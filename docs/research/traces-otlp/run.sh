#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
spike_dir=$(mktemp -d "${TMPDIR:-/tmp}/polaris-otlp.XXXXXX")
trap 'rm -rf "$spike_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for file in "$source_dir"/*.ts.txt; do
  name=$(basename "$file" .txt)
  cp "$file" "$spike_dir/$name"
done
cp "$source_dir/package.json.txt" "$spike_dir/package.json"
cp "$source_dir/bun.lock.txt" "$spike_dir/bun.lock"
cd "$spike_dir"
export BUN_INSTALL_CACHE_DIR="$spike_dir/cache"
bun install --frozen-lockfile --ignore-scripts
bun audit-licenses.ts
bun run.ts
