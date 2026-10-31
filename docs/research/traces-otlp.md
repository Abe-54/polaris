# OTLP/HTTP receiver spike (ENG-656)

This is the throwaway spike for [ADR 0094](../adr/0094-the-daemon-receives-agents-telemetry-and-forwards-it.md),
before T1 adds the Daemon receiver. The runnable source is under [traces-otlp/](traces-otlp/)
as `.ts.txt`; nothing runs from `apps/`, and no production dependencies changed.

## Decision for T1

Use **`127.0.0.1:4319`**, OTLP/HTTP, with protobuf and JSON on `POST /v1/traces`.
The product endpoint adds the Agent Session token prefix, so its injected base is
`http://127.0.0.1:4319/otlp/<token>` and the trace URL is that base plus `/v1/traces`.
4318 remains available for an app's existing standard OTLP collector; 4319 is an adjacent,
easy-to-recognise fixed port. It is a Polaris choice, not an assigned OTLP default.
Use the literal IPv4 address in the injected URL: this spike binds IPv4 loopback only.

The script proves initial availability by binding the receiver, then starts another receiver
on the same address. The second must exit nonzero with `EADDRINUSE`; it never chooses a random
port or kills the owner. After all tests it binds once more to prove cleanup released the port.
For the Daemon, an occupied port should leave tracing unavailable with a concrete port-conflict
error while the rest of the Daemon continues. T1 owns that integration behavior.

Choose **OpenTelemetry's generated `ExportTraceServiceRequest.decode` backed by
`protobufjs/minimal`**, using `@opentelemetry/otlp-transformer@0.213.0`, `protobufjs@7.5.4`
and `long@5.3.2` from the frozen lockfile. The spike imports
`@opentelemetry/otlp-transformer/build/src/generated/root.js` directly. It decodes resource,
scope, spans, attributes (including nested values), events, links, status and unknown wire fields;
there is no handwritten partial wire reader. Timestamps remain exact `Long` values rather than
floating-point numbers. This gives T1 a real, bounded dependency choice and measured cost.

The generated schema is an internal deep import, **not a stable public OTel receiver API**.
Pin it; changing versions requires rerunning the fixtures. The generated JS file is 857,876 bytes
and also declares metrics/logs schemas; importing it does not start the SDK. A later smaller
generated traces-only module is possible, but its cost is not measured here.

The transformer and `long` are Apache-2.0; `protobufjs` and its helper packages are BSD-3-Clause.
`bun run licenses:check` passes (1,205 production packages, zero violations). Because this spike
is deliberately outside the production workspaces, that command does not walk its dependencies:
`audit-licenses.ts.txt` additionally walks **every installed spike package**, rejects anything
outside the repository's permissive license list, and prints names, versions and licenses.
It passes with the frozen tree. T1 must regenerate production notices when it adds dependencies.
No third-party source was copied: the schema is consumed from its installed package. `proc.ts.txt`
is a snapshot of this repository's `packages/bench/src/proc.ts` for self-contained sampling.

## Measurement

Measured results and raw logs follow below. The Mac uses Bun 1.4.4; the Pi's installed Bun is
1.3.13. These are measurements of each Host's actual runtime, not a controlled comparison of CPUs.
The first Pi attempt stopped before measurements because Bun 1.3.13 could not read Bun 1.4's
version-2 lockfile. The committed lockfile was regenerated using Bun 1.3.13 (version 1), and the
complete packaged smoke was verified with that runtime on the Mac before the retry.

Measured on 2026-10-31 using spike head `792ce1744eb34ff9d9b05ca9227209439c2f00d7`.
The worker ran the Mac command natively; the lead ran the identical archived script through
`lucas-rpi` and supplied its raw output (exit 0). Both runs report `allChildrenStopped: true`
and `portReleased: true`. The lead also checked that no spike process or temporary directory
remained on the Pi. Raw evidence: [Mac](traces-otlp/mac.log), [Pi](traces-otlp/pi.log).

| Host | Runtime / hardware | Load averages at start |
| --- | --- | --- |
| Mac | Bun 1.4.4, Node 24.22.1; Apple M2 Max, 12 cores, 32 GiB; Darwin 27.0.0 | 3.44 / 5.51 / 6.37 |
| Pi 4 (`lucas-rpi`) | Bun 1.3.13, Node 24.21.0; Linux arm64, 4 cores, 3,973,849,088 bytes RAM; kernel 6.18.50+rpt-rpi-v8 | 0.09 / 0.12 / 0.06 |

The Mac was not a quiet Host. Read its sample spread and controls alongside the medians.
The Pi hardware identity comes from the assigned Host; `os.cpus()` reports its model as `unknown`.

| Decode, ms per 1,000 spans | Mac median | Mac p95 | Pi median | Pi p95 |
| --- | ---: | ---: | ---: | ---: |
| Protobuf | 2.620 | 3.053 | 17.196 | 18.751 |
| JSON (UTF-8 decode + parse) | 1.256 | 1.301 | 15.928 | 16.232 |

| Idle control, medians of three windows | Mac | Pi |
| --- | ---: | ---: |
| Bare RSS, MiB | 22.750 | 43.750 |
| Receiver RSS, MiB | 23.516 | 46.473 |
| Bare wake-ups/s (Mac) or context switches/s (Pi) | 9.497 | 48.294 |
| Receiver wake-ups/s (Mac) or context switches/s (Pi) | 9.298 | 47.794 |
| Bare CPU, % of one core | 0.110 | 0.500 |
| Receiver CPU, % of one core | 0.124 | 0.500 |

There is no consistent listener-induced increase in idle wake-ups/context switches in these
windows. That does not mean Bun has zero idle activity: the control has the same runtime and
codec imports. The Pi receiver adds about 2.72 MiB of idle RSS over its control median.

| Receiver/run | Idle RSS MiB | After 200k spans MiB | After 5s settle MiB | Growth from idle MiB | Sampled post-response peak MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mac 1 | 23.52 | 96.69 | 96.70 | 73.19 | 96.67 |
| Mac 2 | 16.62 | 93.33 | 68.59 | 51.97 | 93.31 |
| Mac 3 | 23.58 | 96.59 | 96.58 | 73.00 | 96.58 |
| Pi 1 | 46.48 | 99.54 | 74.69 | 28.21 | 103.84 |
| Pi 2 | 46.46 | 104.06 | 72.77 | 26.30 | 108.62 |
| Pi 3 | 46.47 | 103.89 | 72.28 | 25.81 | 108.35 |

Idle RSS growth during the windows was -6.97 to +0.06 MiB on the Mac and -0.74 MiB
on each Pi run. RSS can fall as pages are reclaimed; these counters do not establish the cause. A sampled
post-response peak can also be slightly below the later post-stats RSS reading. The table reports
each counter as sampled rather than treating it as a continuously measured high-water mark.

**T1 budget:** a representative 1,000-span protobuf batch occupies the Pi event loop for roughly
17 ms just to parse. Bound incoming work and budget normalization, redaction, forwarding and
storage separately. The listening socket is small relative to this parse/allocation workload;
RSS remaining five seconds after traffic grows by 25.81–28.21 MiB on the Pi and 51.97–73.19 MiB
on the Mac. These short runs do not establish a long-run memory plateau.

### Method and boundaries

- The manual Node SDK generates 1,000 spans: a root and 999 children. Each child has five
  attributes (string, integer, boolean and string-array values), one event and one link; the
  first child has an error status. Its real protobuf exporter sends one batch to the Bun receiver.
  The same ended SDK spans are serialized with OTel's JSON serializer. Sizes are **315,383 bytes
  protobuf / 972,154 bytes JSON**. Assertions compare counts, names, error status, events, links,
  exact nanosecond timestamps and trace IDs across formats.
- Decode timing starts with wire bytes already in memory. Protobuf calls the generated decoder;
  JSON calls `TextDecoder.decode` then `JSON.parse`. Each warms up 50 times, then records 30
  samples of 20 complete batch decodes; the report uses the median and nearest-rank p95 of those
  sample averages. A 600,000-span checksum makes the batch result observable. GC during timing
  is included. No HTTP, decompression, store writes, redaction, schema validation or product
  normalization is included. JSON returns strings for uint64s and hex IDs; protobuf returns
  `Long`s and bytes. These are parse costs, not equal-cost fully normalized domain objects.
- A separate receiver process imports only the codec and Bun HTTP server. A bare control imports
  the same codec and waits on stdin without a listener. Each run settles 5 seconds, then samples
  a 10-second idle window without HTTP probes or timers in the measured process. There are three
  runs of each. The parent reads kernel counters before and after the window.
- macOS wake-ups are idle plus interrupt wake-ups from `proc_pid_rusage(RUSAGE_INFO_V2)`.
  Linux uses **voluntary plus involuntary context switches across all live threads**, a proxy,
  not the same wake-up counter. Do not compare these values across operating systems.
- Each receiver then accepts 100 batches of 1,000 protobuf spans and 100 JSON batches: **200,000
  spans per run**, sequential requests, with no retained span graphs. RSS is read after every
  response for a sampled peak and again after a further 5 seconds. RSS growth is relative to
  that run's idle RSS, without forcing GC. This measures a short allocation/retention workload,
  not a long-duration leak test. The bare process gets no traffic.
- This is a listening spike, not the full Daemon: no SQLite, forwarding, token authorization,
  Origin/Host checks, logs ingestion, compression or concurrent export load. Its 4 MiB body cap
  bounds these fixtures, but it is not a hardened parser or a production receiver contract.

## Both real senders

The script runs each sender in its own **Node** process, avoiding competing global OTel providers.
The receiver is Bun. No Axiom/Vercel credentials or vendor traffic are involved: the explicit
vendor exporter reaches a second local path solely to demonstrate the two-exporter behavior.

| Sender/configuration | Receiver observation | Required settings |
| --- | --- | --- |
| Manual `OTLPTraceExporter` (`exporter-trace-otlp-proto@0.213.0`) | 1,000 spans, `application/x-protobuf`, `/v1/traces`, header `x-spike-sender: manual` | Constructor `url` is the **full** trace URL; constructor `headers` carries app headers. Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4319/v1/traces` and explicitly read it in the app's URL fallback. |
| `@vercel/otel@2.1.1` HTTP app, `GET /hello`, explicit vendor exporter plus default processors | One `GET /hello` span at `/v1/traces` with `x-spike-sender: vercel-base`, protobuf; same trace ID at `/vendor/v1/traces` | `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_EXPORTER_OTLP_HEADERS=x-spike-sender=vercel-base`. Base endpoint has no trailing slash. Default `spanProcessors` retained. |
| Same app, signal-specific endpoint and JSON | One `GET /hello` at `/otlp/spike/v1/traces` with `x-spike-sender: vercel-signal`, JSON; same trace ID at vendor path | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4319/otlp/spike/v1/traces`, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS=x-spike-sender=vercel-signal`. General endpoint deliberately points at port 1; general header is overridden. |

The manual exporter uses this app change:

```ts
new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? existingVendorUrl,
  headers: existingVendorHeaders,
});
```

An exporter with a literal `url` cannot be redirected merely by setting the general endpoint
environment variable. Constructor headers also remain attached to the redirected request: a
production forwarder must handle them without storing secrets. This spike uses synthetic labels.
It flushes and shuts down the SDK before exiting, so delivery is established by the receiver's
decoded request log, not just by the sender's exit status.

For `@vercel/otel`, keep its default `spanProcessors`/`"auto"` behavior. In the pinned version,
an explicit `traceExporter` does not suppress an additional environment-configured exporter.
Consequently Polaris must **not forward that extra copy to the vendor again**. A custom
`spanProcessors` list or Vercel's production `VERCEL_OTEL_ENDPOINTS` branch can change this;
neither is claimed tested. The sample is a small Node HTTP app using `registerOTel`, not a
deployed Next.js app or a test of automatic instrumentation.

The Bun 1.3 smoke also caught an HTTP detail: after an unsupported-content-type request, an
unread body could cause the next keep-alive request to return 400. Draining bounded bodies before
returning early made the `415` followed by `404` check pass. T1 should preserve that regression
coverage when it implements rejection paths.

## Senders set up by the skill (ENG-658)

The `polaris-tracing` skill ([skills/polaris-tracing](../../skills/polaris-tracing/SKILL.md)) was
followed in scratch apps against T1's real receiver (the worktree Daemon at `08798fa8`, a throwaway
`POLARIS_HOME`, a scripted Agent Session and its injected endpoint) on 2026-10-31, with Node 24.22.1
and Bun 1.4.4. What it learned, beyond the spike above:

- **OpenTelemetry JS 3.0 changed the setup.** `sdk-node@0.300`, `sdk-logs@3` and `sdk-trace@3`
  processors take `{ exporter }`; passing the exporter itself fails only at `shutdown()`
  (`Cannot read properties of undefined (reading 'shutdown')`), losing the batch. The logs API moved
  into `@opentelemetry/api@1.10`; a logger from `@opentelemetry/api-logs@0.223` reads a different
  global and drops every record without an error. `sdk-trace-base` is deprecated for `sdk-trace`.
- **`@vercel/otel@2.2.0` pins the 2.x line** (`resources` < 3, `sdk-logs` < 0.300), so its projects
  keep `0.2xx` exporters. With only `OTEL_EXPORTER_OTLP_ENDPOINT` set (no protocol variable), an
  explicit vendor `traceExporter` plus the default processors sent one copy to the vendor and one to
  the receiver. Its source adds the environment exporter only in the `"auto"` processor branch, and
  not when `VERCEL_OTEL_ENDPOINTS` is set.
- **ESM needs the loader hook.** Under `node --import ./instrumentation.ts`, `node:http` produced no
  server span until `module.register("@opentelemetry/instrumentation/hook.mjs")` ran first.
- **`NodeSDK` exports metrics by default** to `/v1/metrics`, which the receiver doesn't serve;
  the skill sets `metricReaders: []`.
- **Bun drops tail-call frames.** A `code.*` location read from the stack points at the caller's
  caller for `return traced(…)` or `=> traced(…)` on Bun, never on Node; `await traced(…)` keeps it.
- **The fixed-exporter line** sent to the vendor URL without the variable and to
  `/otlp/<token>/v1/traces` with it, carrying the app's headers either way.
- **Redaction (RT1 P1).** Every exception stack containing a `file://` frame (all Node ESM stacks)
  was stored as `"[redacted]"`, because a credential-free URL redacts the whole value. Bun stacks,
  which carry plain paths, survived.

The Node app (`NodeSDK`, auto-instrumentations, ESM TypeScript) and the `Bun.serve` app (manual
`TracerProvider` and `LoggerProvider`) each stored a server span with a child carrying `code.*`,
an ERROR child with its exception event, and log records correlated to their spans, read back
through `traces.watch`, `traces.get` and `traces.span`.

## Reproduce

Prerequisites: Bun (tested 1.3.13 and 1.4.4; product minimum remains 1.3.9), Node ≥22.18 with TypeScript stripping,
registry access for the frozen install, and port 4319 available. From the repository:

```sh
sh docs/research/traces-otlp/run.sh
```

`run.sh` copies all `.ts.txt` files and the pinned manifest/lockfile into `mktemp`, installs with
`--frozen-lockfile --ignore-scripts`, audits licenses, runs both senders, measures, prints raw JSONL,
stops all children and removes the temporary directory/cache. It does not modify the installed
Bun or the repository lockfile. `SPIKE_RUNS=0` runs only sender/port/decode smoke; defaults are
three idle/memory runs, 10-second windows and 5-second settles. The script has a ten-minute
watchdog and cleanup on failures/signals. A failed initial bind exits without touching its owner.

For the Pi handoff, from a repository containing the spike commit:

```sh
git archive HEAD docs/research/traces-otlp |
  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes lucas-rpi '
    export PATH="$HOME/.bun/bin:$PATH"
    spike_dir=$(mktemp -d /tmp/polaris-otlp-handoff.XXXXXX)
    trap '\''rm -rf "$spike_dir"'\'' EXIT
    tar -xf - -C "$spike_dir" && sh "$spike_dir/docs/research/traces-otlp/run.sh"
  '
```

The worker's sandbox refuses SSH before authentication (`Operation not permitted`); the lead
runs this command through the existing alias. No SSH keys, configuration or `known_hosts` changes
are needed or made.

## Validation

The packaged runner passed the complete sender, decoder, HTTP rejection, port collision, idle,
traffic and shutdown paths. A short-window run also passed on the Mac using Bun 1.3.13 before
the Pi retry. The fixed rejection sequence failed on that runtime before body draining was added.
Repository typecheck (18/18 cached tasks), lint and `licenses:check` passed. The repository-wide
`bun run test` attempt had 18 successful cached tasks and sandbox socket/lock failures in the
Daemon tests, plus unrelated file-watcher failures; it was interrupted after 3m58s to stop
contaminating measurement. It is not a passing full-suite receipt, and no native full-suite rerun
is claimed for this docs-only change. No product, protocol or state-machine files changed.

## References

- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/): HTTP paths, content types,
  success responses and the OTLP JSON deviations (hex trace/span IDs and decimal uint64 strings).
- [OpenTelemetry JS protobuf exporter](https://github.com/open-telemetry/opentelemetry-js/tree/541e1b4ad83ad2093459794a18283228fe58d199/experimental/packages/exporter-trace-otlp-proto)
  and [generated schema](https://github.com/open-telemetry/opentelemetry-js/blob/541e1b4ad83ad2093459794a18283228fe58d199/experimental/packages/otlp-transformer/src/generated/root.js):
  the transformer's published `gitHead`, consumed through installed packages.
- [Vercel OTel](https://github.com/vercel/otel) and the exact installed 2.1.1 `dist/node/index.js`:
  environment precedence and its `auto` processor branch. Context7 documentation was consulted;
  all configuration claims above were also exercised through real HTTP requests.
