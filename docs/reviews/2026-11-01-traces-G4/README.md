# G4: Traces phase 2 end to end (ENG-657)

Verified on the integration worktree at `9dd5e7a21` (macOS arm64, Bun 1.4.4, Node 24.22.1). No source files changed.

## Setup

Each script starts a real `polaris serve` from source:
- It uses the supported dev launcher's flags (`bun --no-env-file --config=scripts/daemon-dev.toml`), so no checkout `.env` or bunfig is autoloaded.
- It runs in a throwaway `/tmp/g4h-*` home with an empty `/tmp/g4cwd-*` cwd.
- Agent Sessions use the scripted bench Harness (`POLARIS_BENCH_HARNESS=1`), so the Engine, store and Turns are real but no vendor Harness runs.
- The agent's own `POLARIS_*`, `OTEL_*` and `NODE_OPTIONS` are removed from the Daemon's environment.

The apps are real Node 24 servers on the OTel SDK 0.300 packages from `/tmp/rpu-p7/node/node_modules`. Collectors and "vendor" receivers are local Bun OTLP/HTTP servers that decode protobuf with the Daemon's own `decodeBatch`.

To rerun, rename `*.ts.txt` to `*.ts` and run `bun s<N>-….ts` from an empty directory. Running two at once isn't possible, because the trace receiver's port 4319 is fixed (see F1).

The system Daemon (pid 10276, `bin/current` 0.7.0) was the same before and after every script. Every Daemon, app, collector and temp directory was removed after its run.

| # | Scenario | Result | Log |
|---|---|---|---|
| 1 | Forwarding to a launch-environment collector, plus the SEC1 negative case | **PASS** (21/21) | `s1-forwarding.log` |
| 2 | UF11 auto-instrumentation: the app keeps its own spans, and a removed preload is harmless | **PASS** for the asked checks (22 pass); 1 FAIL is finding F2 | `s2-autoinstrument.log` |
| 3 | UF15 restart profile; UF14 user attach with no inspector listener | **PASS** (16/16 when port 4319 is free); finding F1, note F3 | `s3-profiles.log`, `s3-port-held.log`, `s3-intermittent/` |
| 4 | Compare (RPC and MCP) across Turns and Baseline; two-service trace and the service map | **PASS** (19/19) | `s4-compare-map.log` |

## 1. Forwarding (`s1-forwarding.ts.txt`)

Apps run through real `terminal.open` argv launches, so the Daemon builds their environment.

**Daemon A** started with `OTEL_EXPORTER_OTLP_ENDPOINT=R1` and `OTEL_EXPORTER_OTLP_HEADERS=x-collector-key=shell-secret-k1,authorization=Bearer shell-secret-auth`:
- The app's `OTEL_EXPORTER_OTLP_ENDPOINT` was `http://127.0.0.1:4319/otlp/<token>`, not R1.
- Polaris stored its own copy of every trace (`traces.watch` total ≥ 3).
- R1 received the app's spans (`orders-api:GET /fast`, `GET /slow`) as protobuf on `/v1/traces`, with both shell headers.
- Settings: `forwardTo {url: R1/v1/traces, headerNames: [authorization, x-collector-key], passesAppHeaders: true}`.
- In a second Workspace whose `.env` sets `OTEL_EXPORTER_OTLP_ENDPOINT=R2`, spans still went to R1, and **R2 received 0 requests**. Settings list the `.env` file as `otlp-env` evidence; `forwardTo` stays R1.

**Daemon B** started with only the shell's `OTEL_EXPORTER_OTLP_HEADERS`. Its Workspace `.env` sets R2 and `x-file-key=file-secret`.
- Before saving: **R2 received nothing**. Settings show `forwardTo: null` with `.env` evidence, which is the suggestion.
- After `traces.setSettings` saved R2 (RP1's P1-2 attack shape): R2 received the spans. Settings show `headerNames: []` and `passesAppHeaders: false`.
- **None of R2's requests carried `authorization`, `x-collector-key` or `x-file-key`.** The app did send the shell headers to Polaris (precondition checked), so Polaris stripped them.

## 2. Auto-instrumentation (`s2-autoinstrument.ts.txt`)

Each app's own NodeSDK exports to a vendor receiver V at a URL fixed in its source. Settings: `autoInstrument: node`, with a seeded Workspace Trust record.

- **(a) Monorepo.** The terminal opens at the root and only `svc/package.json` lists the SDK. Launch-time detection missed it, so the preload was injected. The child-side ownership check stood down:
  - V received `app-manual-span` plus the app's HTTP spans.
  - Polaris stored 0 spans.
- **(b) `autoInstrumentOverride`, with the app's NodeSDK using `getNodeAutoInstrumentations`.** V still received `app-manual-span` and the HTTP spans: UF11 PASS. **Polaris stored 0 spans** (F2).
- **(b2) Same override, with the app's SDK using `instrumentations: []`** (the shape `preload.test.ts` uses):
  - V received `app-manual-span`.
  - Polaris stored its own `GET` spans.
  - The manual span stayed with the app's provider.
- **(c)** With the root manifest listing the SDK, no preload was injected, and settings showed `autoInstrumentSkipReason` "The project depends on @opentelemetry/sdk-node…".
- **Control.** A plain app with no SDK got the preload, and Polaris stored its `plain-app:GET` spans.
- **(d) Removed preload.** A live `/bin/sh` terminal's `NODE_OPTIONS` holds the `data:` fail-soft wrapper. With `<home>/node-instrumentation/` deleted:
  - `node -e …` in that shell printed its output with `RC2=0` and no `ERR_MODULE_NOT_FOUND`.
  - A new terminal ran `node` with exit 0, and the preload was materialised again.

## 3. Profiles (`s3-profiles.ts.txt`)

The agent's MCP `profile {command: ["node","server.cjs"]}` launches a never-exiting HTTP server. It is a Polaris-owned, cooperative launch: `ps eww` shows the `profile-bootstrap` import in `NODE_OPTIONS`.

- **User attach** (`profiles.attach`, 3 s), with the server under HTTP load:
  - `lsof -nP -iTCP -sTCP:LISTEN -p <pid>` was sampled every 50 ms through the capture (≈100 samples). It only ever showed `127.0.0.1:<app port>`.
  - The capture returned `origin: attach` and completed with frames, including the hot handler `handleOrder`.
  - The app kept serving.
- **`profiles.restartWithProfiling`**:
  - It returned a new `origin: restart` recording with a new pid.
  - The original recording of the never-exiting server completed. In the final run it had 600+ nodes, with `polarisBurn server.cjs:3` among the hot functions.
  - The old pid is gone, and the new server answers.
- **MCP `profile {id}`** reads it.
- **Daemon SIGTERM** stopped the restarted server, and its recording was persisted `completed` with `polarisBurn` frames.

## 4. Compare and service map (`s4-compare-map.ts.txt`)

Two real services: `orders-api` calls `inventory-api` with `fetch`, and propagates W3C context. Both export to the Agent Session endpoint from `traces.watch`, which is the endpoint a Harness-launched command gets. They were spawned by the script rather than by a Harness.

Traffic ran inside two bench Turns of about 8 s each:
- Turn 2: 6 × `/fast`.
- Turn 3: 6 × `/fast`, 6 × `/slow`, 4 × `/new`, 3 × `/call-b`.

Results:
- **`traces.compare` Turn 2 → Turn 3**:
  - `GET /fast`: 6 → 6, with p50/p95 equal to nearest-rank over the `traces.watch` root durations.
  - `/slow`: 0 → 6, `/new`: 0 → 4, `/call-b`: 0 → 3. Each has null percentiles and a `slowestNew`.
  - No `inventory-api` route.
  - Routes are sorted.
- **Baseline → Turn 3**: `/fast` is 6 → 6 with the same before stats, and only Turn 3's routes are listed.
- **Turn 3 → Turn 3**: `/slow` p50 is 62 ms on both sides.
- **Baseline as `b`** returns `E-INPUT`.
- **MCP `compare`** (explicit, and with `a` omitted) gives the same counts, e.g. `GET /fast … p50 5.9 ms → 5.5 ms … runs 6 → 6`.
- **`traces.get`** on a `/call-b` trace:
  - `services: [inventory-api, orders-api]`, with one trace id.
  - `inventory-api`'s server span `GET /stock` has as `parentId` the `orders-api` client span.
- **Desktop service map:** the Desktop's own `serviceMap(traceTimes(detail))` returns the edge `orders-api → inventory-api` (`calls: 1`, `protocol: HTTP`, not inferred).

## Findings

**F1 (P2): cooperative attach silently depends on the trace receiver owning 127.0.0.1:4319.**

`TraceRuntime.environment` returns `{}` when the receiver isn't Listening (`apps/daemon/src/traces/runtime.ts`, the `if (!TraceAvailability.guards.Listening(availability)) return {};` before the `cooperative` block). So when anything else holds 4319, three things follow:
- Polaris-launched Node processes never get the profile bootstrap.
- Every attach, from the sidebar or the agent, fails with "This process is not registered. Restart with profiling instead.".
- That message isn't the reason. `capture.ts` also maps every `targets.get` error to the same text.

Reproduction: `G4_HOLD_4319=1 G4_WARM=none G4_LOAD=0 bun s3-profiles.ts` (log `s3-port-held.log`). It shows:
- availability `EADDRINUSE … bun (PID …)`;
- `ps eww` with no `NODE_OPTIONS` bootstrap, `POLARIS_PROFILE_SOCKET` or `POLARIS_PROFILE_TOKEN`;
- attach refused, including the retry.

Restart profiling is unaffected. I first hit this by accident: 5 consecutive s3 runs failed this way in 4–35 ms (`s3-intermittent/s3-r1.log`, `s3-sleep.log`). They ran while the Lead's `bench idle` Daemon held 4319 (`/tmp/g4/bench-idle.log`, up to 00:27:12). The runs passed again from 00:27:31.

Any second Daemon on the Host triggers it: a dev Daemon beside the installed one, a bench, or a test.

Fix direction: compute the cooperative overlay independently of receiver availability, and give "not registered" its real cause.

**F2 (P3): under `autoInstrumentOverride`, an app whose own SDK loads `getNodeAutoInstrumentations` leaves Polaris with no spans.** The app keeps all its spans, so UF11 holds. But Traces stays empty, and `autoInstrumentSkipReason` is null.

(b) and (b2) differ only in the app's `instrumentations` list. The likely cause is that the app's HTTP/undici instrumentations re-patch the modules over Polaris's, since OTel instrumentations unwrap an already-wrapped export. I didn't confirm that mechanism. The repo's override tests use `instrumentations: []`, so they don't cover this, which is the usual app setup.

**F3 (P3, mostly upstream): late-attached CPU profiles can miss already-optimised frames.**
- **In Polaris:** a `setInterval` loop that had been running since start (`polarisBurn`) was missing from every attach profile. Its time showed as `listOnTimeout` self time, even though the same process's `--cpu-prof` recording shows it.
- **Plain Node 24.22.1, no Polaris** (`probe-attach.*`): a worker `connectToMainThread` session, which is UF14's mechanism, missed the function in 9 of 9 default runs. A main-thread `inspector.Session` missed it in 6 of 7. The function appears if it first runs after `Profiler.start`, or with JIT tiers off.
- **A warmed HTTP handler under load** (`handleOrder`) was present in 6 of 6 plain-Node probes (`probe-attach-http.log`). It was present in 9 of 10 Daemon attach captures. The miss is `s3-intermittent/s3-diag.log`; later runs also confirmed it in the raw `attach.cpuprofile`.

This isn't a UF14 regression. The parser preserves what V8 returns. A user should still expect late-attach profiles of long-running hot loops to be attributed to their caller.

## What was faked or not exercised

- **No real Harness.** Bench Turns stand in for a Harness. Apps in scenarios 1 and 2 ran through real Polaris terminals. In scenario 4 the script spawned them with the session endpoint, and in scenario 3 they launched through the real MCP `profile` command. Claude's per-command Bash injection (UF13) and the `launchedTurn` attribution were not exercised.
- **Seeded Trust and MCP binding.** Workspace Trust was seeded through `createExecutionTrust` and the MCP binding was issued directly, as `RP4/p4/daemon-smoke.ts` does, not through the Desktop.
- **Attach target.** The only cooperative launch reachable without a vendor Harness is the profile `command` launch, so the attached process was also running `--cpu-prof`. A plain-Node probe shows this doesn't change attach frames.
- **No Desktop App.** It was never launched. The service-map check runs the renderer's pure model on the RPC result, not the UI.
- **Other paths not exercised:**
  - Vendor (Axiom/Vercel) forwarding, metrics forwarding, logs forwarding (only traces were asserted) and the forwarding queue's retry and drop behaviour.
  - Agent MCP attach with its Pending Approval.
  - Linux peer credentials and compiled-binary runs: everything here ran from source on macOS.
- **Overlap with the Lead's lease.** These runs overlapped the Lead's `spec`, `bench traces` and `bench idle` (to 00:27:12). Scenario 3's server burns about 40% of a core and serves load, which may have added background CPU to those bench numbers. Its Daemons also held port 4319 at times, though the Lead's `bench traces` reports a normal ingest.

Linear follow-ups: F1 is ENG-702, F2 is ENG-703 and F3 is ENG-704.

## Repository checks and benchmarks (lead)

One `lease bench` command ran `all.sh.txt` on `9dd5e7a21` from 04:06:52 to 04:46:25 UTC (`checks-run.log`):

- `bun run typecheck`, `bun run test` (19/19 tasks, 0 fail), `bun run lint`, `bun run licenses:check` and `bun run spec`: all exit 0.
- **Traces bench** (`bench-traces.log`, 3 full runs against `mac14-13-apple-m2-max-12c-eng656-traces.json`): no regressions beyond tolerance. Medians: 33,584 spans/s (baseline 13,323), ingest 5,955 ms (15,012), RPC p99 during ingest 3.3 ms (16.3), peak RSS over base 173.4 MiB (153.1, +13%), RSS after quiet 195.9 MiB (184.8, +6%). The quiet RSS ranged 175.8–291.4 MiB across runs, so ENG-682 passes on the median only and stays open. The Host started with 6.3 busy cores (baseline 11.1): throughput and CPU aren't comparable.
- **Idle bench** (`bench-idle.log`, 3 runs against `mac14-13-apple-m2-max-12c-m31-idle-quick.json`): no regressions beyond tolerance. Client RSS 109.4 MiB (135.8), footprint 65.7 MiB (98.1), no-client wakeups 0.73/s (10.5).
- The end-to-end scripts above overlapped the spec and both benches, and scenario 3's server burns about 40% of a core, so the bench numbers carry that background load.

## Raspberry Pi 4 idle (lucas-rpi, linux-arm64 compiled builds)

Same procedure as G3 (`pi-run.sh.txt`, `pi-idle.sh.txt`, `pi-ctx.sh.txt`, log `pi.log`): origin/main `09fc87128` against head `9dd5e7a21`, three alternating rounds, 30 s settle then a 60 s idle window. Pi load 0.09–0.11.

| | main | head |
|---|---|---|
| RSS after idle | 63.7–63.8 MiB | 67.1–67.3 MiB (+3.4 MiB, +5%) |
| CPU | 0.017–0.050% of a core | 0.017–0.050% |
| Context switches/s (threads present in both samples) | 0.28–0.33 | 0.27–0.33 |

Both builds kept 7 threads. The `ctx_per_s` column in the `pi-idle.sh` lines is the invalid all-threads sum (see G3) and is superseded by the `pi-ctx.sh` lines. The Pi's own Daemon was untouched and the throwaway files were removed.
