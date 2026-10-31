#!/usr/bin/env bash
# Runs one scratch app against a fresh stand-in collector, exercises it, SIGTERMs it, and prints
# what arrived. Usage: run-app.sh <name> <appdir> <with-endpoint:1|0> -- <start command...>
set -u
NAME=$1 APP=$2 WITH=$3; shift 4
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=/tmp/rpu-p7/out-$NAME
rm -rf "$OUT"; mkdir -p "$OUT"
bun "$HERE/collector.ts" "$OUT" > "$OUT/collector.stdout" 2>&1 &
CPID=$!
for _ in $(seq 50); do [ -f "$OUT/port" ] && break; sleep 0.1; done
CPORT=$(cat "$OUT/port")
APORT=$(( 40000 + RANDOM % 20000 ))
cd "$APP"
if [ "$WITH" = 1 ]; then
  env -u OTEL_EXPORTER_OTLP_TRACES_ENDPOINT OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:$CPORT/otlp/tok_review" PORT=$APORT "$@" > "$OUT/app.stdout" 2>&1 &
else
  env -u OTEL_EXPORTER_OTLP_ENDPOINT -u OTEL_EXPORTER_OTLP_TRACES_ENDPOINT PORT=$APORT "$@" > "$OUT/app.stdout" 2>&1 &
fi
APID=$!
for _ in $(seq 100); do curl -s -o /dev/null "http://127.0.0.1:$APORT/" && break; sleep 0.1; done
curl -s "http://127.0.0.1:$APORT/orders/42" > /dev/null
curl -s "http://127.0.0.1:$APORT/rates/eur" > /dev/null
curl -s -H 'traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' "http://127.0.0.1:$APORT/fail" > /dev/null
sleep 0.5
kill -TERM $APID
wait $APID; echo "app exit code: $?" >> "$OUT/app.stdout"
sleep 1
kill $CPID
echo "== app stdout"; cat "$OUT/app.stdout"
echo "== requests"; cat "$OUT/requests.log" 2>/dev/null || echo "(none)"
echo "== spans"; [ -f "$OUT/spans.jsonl" ] && bun -e '
for (const line of (await Bun.file(process.argv[1]).text()).trim().split("\n")) {
  const s = JSON.parse(line);
  const a = s.attributes ?? {};
  const ex = (s.events ?? []).find((e) => e.name === "exception");
  console.log(JSON.stringify({ name: s.name, kind: s.kind, status: s.status, statusMessage: s.statusMessage,
    trace: s.traceId?.slice(0, 8), parent: s.parentId?.slice(0, 6) ?? null, span: s.id?.slice(0, 6), scope: s.scope?.name,
    service: s.service, code: [a["code.function.name"], a["code.file.path"], a["code.line.number"]],
    exception: ex ? { type: ex.attributes["exception.type"], message: ex.attributes["exception.message"],
      stack: String(ex.attributes["exception.stacktrace"]).split("\n").slice(0, 3).join(" | ") } : undefined }));
}' "$OUT/spans.jsonl" || echo "(none)"
echo "== logs"; [ -f "$OUT/logs.jsonl" ] && bun -e '
for (const line of (await Bun.file(process.argv[1]).text()).trim().split("\n")) {
  const l = JSON.parse(line);
  console.log(JSON.stringify({ body: l.body, severity: l.severityText ?? l.severity, trace: l.traceId?.slice(0, 8), span: l.spanId?.slice(0, 6), service: l.service }));
}' "$OUT/logs.jsonl" || echo "(none)"
