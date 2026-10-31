# G3: Traces phase 1 end to end (ENG-656)

The lead verified the integration branch at `843a9ed46` after the T1, T2 and RT3 fix rounds (TF1, TF2, TF3, T4F), plus the phase 2 work merged by then.

## Repository checks

One `lease bench` command ran from 23:27:36 to 23:47:24 UTC (`checks-run.log`):

- `bun run typecheck`: exit 0.
- `bun run test`: 19/19 tasks, 0 `(fail)` lines.
- `bun run lint`: exit 0.
- `bun run licenses:check`: 0 violations.

## A real dev server to ⌘5's feed and the agent's tools

`e2e.ts.txt` (log `e2e-run.log`) runs the setup below:

- **Daemon:** a real `polaris serve` from source, in a throwaway `/tmp/g3h-*` home.
- **App:** a real Node 24 HTTP server instrumented as the polaris-tracing skill describes (OTel NodeSDK with HTTP auto-instrumentation). It exports to the session endpoint from the first `traces.watch` page.

It made three requests, one of which failed, and all 17 assertions pass:

- **⌘5's RPCs:**
  - `traces.watch` lists 3 traces with service `orders-api`, session `trace-test` and the Workspace checkout.
  - Exactly one trace is marked error, and the `status:error` filter returns only that one.
  - `traces.get` returns the error span with its exception event.
  - `traces.span` returns `http.response.status_code` 500.
- **MCP over HTTP, as that session's binding:** `traces` lists the same three, `trace` renders the waterfall with the exception and its `server.ts:13` frame, and `span` returns the code location and attribution.

The system Daemon (pid 10276, 0.7.0) was unchanged before and after.

These paths were not exercised:

- **Turn attribution:** the seeded session had no Turns.
- **Per-command endpoints:** the app didn't get its endpoint from a Bash hook or terminal launch, so `launchedTurn` was null.
- **⌘5 rendering:** there's no screenshot of ⌘5 on real data. The screenshot scripts open fixture scenes only.

## Raspberry Pi 4 idle (lucas-rpi, linux-arm64 compiled builds)

Compiled `linux-arm64` dev builds of origin/main `09fc87128` and the integration head `843a9ed46` each ran as a throwaway Daemon under `/tmp` on the Pi:

- **Setup:** 30 s settle, then a 60 s idle window, three alternating rounds (`run.sh`, `pi-idle.sh`, `pi-ctx.sh`).
- **Pi load:** 0.01–0.13.

| | main | head |
|---|---|---|
| RSS after idle | 63.8–63.9 MiB | 67.2 MiB (+3.4 MiB, +5%) |
| CPU | 0.017% of a core | 0.017–0.033% |
| Context switches/s (threads present in both samples) | 0.30–0.33 | 0.22–0.28 |

Both builds kept 7 threads through the window: the trace worker starts on demand and doesn't run at idle.

The first wakeup measurement in `pi-idle.log` (negative `ctx_per_s`) summed over each sample's live threads and is invalid. `pi-ctx.log` replaces it.
