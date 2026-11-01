#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# Bun must receive these flags before it can load checkout startup configuration.
if [ "${1-}" = "--watch" ]; then
  shift
  exec bun --no-env-file --config="$script_dir/daemon-dev.toml" --watch "$script_dir/../apps/daemon/src/main.ts" "$@"
fi

exec bun --no-env-file --config="$script_dir/daemon-dev.toml" "$script_dir/../apps/daemon/src/main.ts" "$@"
