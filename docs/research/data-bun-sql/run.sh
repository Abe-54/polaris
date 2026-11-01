#!/usr/bin/env bash
set -euo pipefail

# Creates only disposable databases. Never point these probes at a user's Data Source.
HERE=$(cd "$(dirname "$0")" && pwd)
OUTPUT=${1:-$(mktemp -d /tmp/polaris-data-bun-sql.XXXXXX)}
mkdir -p "$OUTPUT"
OUTPUT=$(cd "$OUTPUT" && pwd)
RUNTIME=${SPIKE_ENGINE:-docker}
case "$RUNTIME" in
  docker|podman) CONTAINER=("$RUNTIME") ;;
  vmpal) CONTAINER=(vmpal containers) ;;
  *) echo "SPIKE_ENGINE must be docker, podman, or vmpal" >&2; exit 2 ;;
esac
PG_NAME="polaris-data-s-$$-pg"
MY_NAME="polaris-data-s-$$-my"
PG_PORT=${SPIKE_PG_PORT:-56491}
MY_PORT=${SPIKE_MYSQL_PORT:-56492}
PG_IMAGE=postgres:16@sha256:1beaa3084eee2676f20a9cd9928f0bf2c5bf674f8e49f81017912183d377c61c
MY_IMAGE=mysql:8.4@sha256:a0225d1ea6631c8bc2385dc4c2faba17bbf1834ecf369e1659a9a382bd8d5dd7
LSP_ROOT=$(mktemp -d /tmp/polaris-data-sqllens.XXXXXX)
PG_CREATED=0
MY_CREATED=0
cleanup() {
  if [ "$PG_CREATED" = 1 ]; then "${CONTAINER[@]}" rm -f -v "$PG_NAME" >/dev/null; fi
  if [ "$MY_CREATED" = 1 ]; then "${CONTAINER[@]}" rm -f -v "$MY_NAME" >/dev/null; fi
  rm -rf "$LSP_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${CONTAINER[@]}" ps >/dev/null
"${CONTAINER[@]}" run -d --name "$PG_NAME" -p "127.0.0.1:$PG_PORT:5432" -e POSTGRES_PASSWORD=spike -e POSTGRES_DB=spike "$PG_IMAGE" > "$OUTPUT/postgres-container.txt"
PG_CREATED=1
"${CONTAINER[@]}" run -d --name "$MY_NAME" -p "127.0.0.1:$MY_PORT:3306" -e MYSQL_ROOT_PASSWORD=spike -e MYSQL_DATABASE=spike "$MY_IMAGE" > "$OUTPUT/mysql-container.txt"
MY_CREATED=1

ready() {
  local i
  for i in {1..90}; do
    if "${CONTAINER[@]}" exec "$1" "${@:2}" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  "${CONTAINER[@]}" logs --tail 30 "$1" >&2
  return 1
}
ready "$PG_NAME" pg_isready -h 127.0.0.1 -U postgres -d spike
ready "$MY_NAME" mysql -h127.0.0.1 -uroot -pspike -D spike -Nse 'SELECT 1'
"${CONTAINER[@]}" inspect "$PG_NAME" "$MY_NAME" > "$OUTPUT/containers.json"
cp "$HERE/sqllens-package.json" "$LSP_ROOT/package.json"
cp "$HERE/sqllens.bun.lock" "$LSP_ROOT/bun.lock"
bun install --cwd "$LSP_ROOT" --frozen-lockfile --ignore-scripts > "$OUTPUT/sqllens-install.txt"
export SPIKE_LSP_ROOT="$LSP_ROOT"
export SPIKE_PG_URL="postgres://postgres:spike@127.0.0.1:$PG_PORT/spike"
export SPIKE_MYSQL_URL="mysql://root:spike@127.0.0.1:$MY_PORT/spike"
bun "$HERE/lexical-checks.mjs" > "$OUTPUT/lexical-checks.ndjson"
for ENGINE in postgres mysql; do
  echo "Probing $ENGINE (Bun $(bun --version), $RUNTIME)…"
  bun "$HERE/index.mjs" "$ENGINE" > "$OUTPUT/$ENGINE.ndjson"
  bun "$HERE/sqllens.mjs" "$ENGINE" > "$OUTPUT/sqllens-$ENGINE.ndjson"
done
bun "$HERE/validate.mjs" "$OUTPUT" > "$OUTPUT/validation.ndjson"
echo "Recorded live probes: $OUTPUT"
