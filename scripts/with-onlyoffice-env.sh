#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_env="$repository_root/.data/onlyoffice.env"
if [[ ! -f "$runtime_env" ]]; then
  printf 'Missing %s. Run `pnpm onlyoffice:up` first.\n' "$runtime_env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$runtime_env"
set +a
cd "$repository_root"
exec "$@"
