#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
output_path="${1:-/tmp/steno-live-source.tar.gz}"

cd "$repository_root"
git ls-files -co --exclude-standard -z \
  | tar --null -czf "$output_path" -T -

printf '%s\n' "$output_path"
