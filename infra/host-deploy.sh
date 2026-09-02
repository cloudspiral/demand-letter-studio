#!/usr/bin/env bash
set -euo pipefail

archive_path="${1:?source archive path is required}"
release_id="${2:?release id is required}"
release_root="/opt/steno/releases/$release_id"
data_root="/var/lib/steno"
ai_provider="${STENO_AI_PROVIDER:-mock}"
openai_secret_arn="${STENO_OPENAI_SECRET_ARN:-}"
openai_model="${STENO_OPENAI_MODEL:-gpt-5.6-sol}"
bedrock_model="${STENO_BEDROCK_MODEL:-us.anthropic.claude-sonnet-4-6}"
aws_region="${STENO_AWS_REGION:-us-east-1}"

install -d -m 0755 "$release_root" "$data_root/postgres" "$data_root/storage"
chown 999:999 "$data_root/postgres"
chown 10001:10001 "$data_root/storage"
tar -xzf "$archive_path" -C "$release_root"

docker build --pull --tag "steno-app:$release_id" "$release_root"
docker network inspect steno-internal >/dev/null 2>&1 || docker network create steno-internal

if ! docker inspect steno-postgres >/dev/null 2>&1; then
  docker run --detach \
    --name steno-postgres \
    --network steno-internal \
    --restart unless-stopped \
    --env POSTGRES_DB=steno \
    --env POSTGRES_USER=steno \
    --env POSTGRES_HOST_AUTH_METHOD=trust \
    --volume "$data_root/postgres:/var/lib/postgresql/data" \
    postgres:17-alpine
fi

for _ in $(seq 1 60); do
  if docker exec steno-postgres pg_isready -U steno -d steno >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec steno-postgres pg_isready -U steno -d steno

docker rm --force steno-app >/dev/null 2>&1 || true
app_command=(
  docker run --detach
  --name steno-app
  --network steno-internal
  --restart unless-stopped
  --env NODE_ENV=production
  --env "AI_PROVIDER=$ai_provider"
  --env "AWS_REGION=$aws_region"
  --env "OPENAI_MODEL=$openai_model"
  --env "BEDROCK_MODEL=$bedrock_model"
  --env DATABASE_URL=postgresql://steno@steno-postgres:5432/steno
  --env STORAGE_DIR=/var/lib/steno/storage
  --env STATIC_DIR=apps/web/dist
  --env PYTHON_BIN=python
  --volume "$data_root/storage:/var/lib/steno/storage"
  --publish 127.0.0.1:3002:3001
)

if [ "$ai_provider" = openai ]; then
  test -n "$openai_secret_arn"
  command -v asm-exec >/dev/null
  test -s /var/run/awssmatoken
  wcp_token=$(< /var/run/awssmatoken)
  openai_key_ref="{{resolve:secretsmanager:$openai_secret_arn:SecretString:apiKey}}"
  openai_ready=false
  for _ in $(seq 1 180); do
    if AWS_TOKEN="$wcp_token" OPENAI_API_KEY="$openai_key_ref" OPENAI_MODEL="$openai_model" AWS_REGION="$aws_region" \
      asm-exec -- sh -c 'curl --fail --silent --show-error --output /dev/null --header "Authorization: Bearer $OPENAI_API_KEY" "https://api.openai.com/v1/models/$OPENAI_MODEL"'; then
      openai_ready=true
      break
    fi
    sleep 10
  done
  [ "$openai_ready" = true ]
  AWS_TOKEN="$wcp_token" OPENAI_API_KEY="$openai_key_ref" AWS_REGION="$aws_region" \
    asm-exec -- "${app_command[@]}" --env OPENAI_API_KEY "steno-app:$release_id"
else
  "${app_command[@]}" "steno-app:$release_id"
fi

for _ in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:3002/api/ready >/dev/null; then
    break
  fi
  sleep 2
done
curl --fail --silent http://127.0.0.1:3002/api/ready

imds_token=$(curl --fail --silent --show-error --request PUT \
  --header 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
  http://169.254.169.254/latest/api/token)
public_ip=$(curl --fail --silent --show-error \
  --header "X-aws-ec2-metadata-token: $imds_token" \
  http://169.254.169.254/latest/meta-data/public-ipv4)
live_hostname="$public_ip.sslip.io"

install -d -m 0755 /opt/steno/caddy
printf '%s\n' \
  "$live_hostname {" \
  '  reverse_proxy 127.0.0.1:3002' \
  '  header {' \
  '    Cache-Control "no-store"' \
  '    Referrer-Policy "same-origin"' \
  '    Strict-Transport-Security "max-age=31536000"' \
  '    X-Content-Type-Options "nosniff"' \
  '    X-Frame-Options "DENY"' \
  '  }' \
  '}' > /opt/steno/caddy/Caddyfile

docker rm --force steno-router >/dev/null 2>&1 || true
docker run --detach \
  --name steno-router \
  --network host \
  --restart unless-stopped \
  --volume /opt/steno/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  --volume steno-caddy-data:/data \
  caddy:2-alpine

for _ in $(seq 1 30); do
  if curl --fail --silent --resolve "$live_hostname:443:127.0.0.1" "https://$live_hostname/api/ready" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --resolve "$live_hostname:443:127.0.0.1" "https://$live_hostname/api/ready"

ln -sfn "$release_root" /opt/steno/current
docker image prune --force --filter "until=168h" >/dev/null
