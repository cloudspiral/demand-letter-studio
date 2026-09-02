#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_env="$repository_root/.data/onlyoffice.env"

mkdir -p "$(dirname "$runtime_env")"
if [[ ! -f "$runtime_env" ]]; then
  umask 077
  editor_secret="$(openssl rand -hex 32)"
  {
    printf 'ONLYOFFICE_JWT_SECRET=%s\n' "$editor_secret"
    printf 'ONLYOFFICE_PUBLIC_URL=http://127.0.0.1:8088\n'
    printf 'ONLYOFFICE_INTERNAL_URL=http://127.0.0.1:8088\n'
    printf 'ONLYOFFICE_APP_URL=http://host.docker.internal:3001\n'
  } > "$runtime_env"
fi

cd "$repository_root"
docker compose --env-file "$runtime_env" --profile onlyoffice up -d onlyoffice
printf 'ONLYOFFICE is starting at http://127.0.0.1:8088. Run `pnpm dev:onlyoffice` for Steno.\n'
