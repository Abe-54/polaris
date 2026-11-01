# UF7: P7 fixes (ENG-658, ENG-656)

Checked against base `9a0fac480`, which includes accepted P1 `cb97757c6`. The skill changes are under `skills/polaris-tracing`; the lead separately authorized the narrow redaction change and regression under `apps/daemon/src/traces/` (ENG-656). No queries, store, worker or MCP files changed. The separate redaction commit is `08e000b81` (ENG-656).

| Finding | Result | Fix and evidence |
| --- | --- | --- |
| P7-1 / P10-1 | Fixed; shared with UF10 | Keep `TRACES_ENDPOINT ?? (ENDPOINT ? ENDPOINT.replace(/\/$/, "") + "/v1/traces" : existingVendorUrl)`. `verify-exporters.py` extracts the real SKILL.md expression and sends 9 batches: vendor/base/signal precedence on Node ESM, Node CommonJS and Bun. `fixed-runs/fixed-exporters.txt`. |
| P7-2 | Fixed against P1 | Explain P1's injected base **and** signal endpoints, private upstream resolution and best-effort bounded forwarding. A code-literal fallback alone does not give the Daemon an upstream target. Confirm the target in Traces settings; keep credentials in memory and one exporter per signal. The `@vercel/otel` branch describes recognized separate exporters and limits of duplicate suppression. Source: P1 README, runtime and forwarding policy, not a new stand-in forwarding claim. |
| P7-3 | Fixed | No preload owns signals or calls `process.exit(0)`. Export `shutdownTelemetry` for the app's existing drain handler / CLI `finally`. Node force-flushes traces then logs before SDK shutdown; Bun shuts providers down sequentially. All four small app runs preserve the app's deliberate exit 3 and receive final spans/logs against the original receiver's single-request limit with 20 ms decode delay. |
| P7-4 | Fixed | Cover E-TRACE-NONE **and** 0 traces, batching delay, current-turn filtering, launch environment, base vs signal URL shape, old-vs-P1 injection and no metrics receiver. Diagnose endpoint shape without echoing the token. Explain that span start time decides turn attribution. |
| P7-5 | Fixed | Route Next.js before the generic Node branch. New `references/next.md` uses framework `register()`, dev/endpoint/runtime gates and `@vercel/otel` 2 with compatible peers. Real Next 16.3.8 dev apps on Node and Bun deliver request spans, child spans, failure events and correlated logs. `fixed-runs/next-{node,bun}.txt`. |
| P7-6 | Fixed | Remove `import.meta` from the helper; `Error.captureStackTrace(holder, traced)` skips helper frames on all tested runtimes. Give synchronous CommonJS SDK preload and explicit compile/require instructions. Same helper compiled to CommonJS is exercised on Node and Bun with real `code.*` locations. |
| P7-7 | Fixed | Only dev commands preload the SDK. No top-level bunfig preload. New SDK imports are gated. Added log processors require a logs/general endpoint; existing-exporter additions also require non-production. Next production registration returns without loading SDK packages, even with a collector URL; all no-endpoint preloads run in a directory with **no SDK dependencies**. `fixed-runs/gate-*.txt`. Existing production registration is kept. |
| P7-8 | Fixed in separately authorized ENG-656 change | Preserve a JS/TS file:line:column only inside a stack-frame-shaped line. Ordinary sensitive assignments and malformed/credential-bearing frames still redact. `stack-redaction.test.ts` uses captured Node 24 CJS and Bun stack shapes. Removing the fix gives 5 failures / 5 passes; restored gives 10 passes. `fixed-runs/redaction-negative.txt`, `redact-stacks.txt`. |
| P7-9 | Fixed | Name `src/http.ts` as a separate file, beside the helper, avoiding the `recordFailure` redeclaration. The extracted HTTP code runs on Bun. |
| P7-10 | Fixed | Route fallback is `unmatched`. Add a CLIENT `outgoingFetch` wrapper with context injection. The real HTTP echo boundary receives a traceparent equal to the exported CLIENT span's ids, parented under the server request; no `GET /orders/42` span. `fixed-runs/bun-esm.txt`. |
| P7-11 | Fixed | Dynamic SDK imports; dev vs `[test]` preload instructions; plain `node:http` route naming guidance; compression/metrics limits; continue steps after the fixed line; redacted endpoint diagnosis; reviewed local/pinned-ref skill install instead of main. Constructor guidance now follows actual installed declarations: even sdk-logs **0.223** requires `{ exporter }`, not the review's positional form. The positional Next attempt exported no logs; the corrected one does. Local CLI install into an isolated project succeeded (`fixed-runs/install.txt`). |

No P7 finding is declined. P7-8 is an Area exception explicitly authorized by the lead; the other outside-Area files are this requested evidence/report directory.

## Reproduce

`verify.py` extracts the fenced reference code verbatim, uses RPU's original `node-server.ts`/`bun-server.ts` fixtures with the instructed app-owned shutdown integration, and launches the original `collector.ts`. The receiver uses the real Daemon decoder/redactor, rejects compression and emulates the older one-request-per-token 429. Node CJS is compiled from the same helper, not rewritten. The Bun outgoing wrapper is exercised against a real loopback HTTP boundary.

Run these commands with native loopback access, after installing the reference dependencies in disposable projects:

```sh
python3 docs/reviews/2026-10-31-traces-RPU/p7/verify.py
python3 docs/reviews/2026-10-31-traces-RPU/p7/verify-exporters.py
bun docs/reviews/2026-10-31-traces-RPU/p7/redact-stacks.ts
bun test apps/daemon/src/traces/stack-redaction.test.ts
```

Default scratch root: `/tmp/uf7` (`UF7_SCRATCH` overrides it). Node/Bun dependency directories default to RPU's `/tmp/rpu-p7/{node,bun}/node_modules`; `UF7_NODE_DEPS` and `UF7_BUN_DEPS` override them. Install the packages from node.md and bun.md there with their respective version lines. For Next, install the packages from next.md plus `next@16.3.8`, `react@19.2.6`, `react-dom@19.2.6`, `typescript@7.0.2`, `@types/node` and `@types/react` under `/tmp/uf7/next` before running. The dependencies live outside this repository; no package/lockfile changes are shipped. `fixed-runs/versions.txt` and `sdk-versions.json` record the actual runtime/SDK versions; `reference-sha256.json` identifies the reviewed references. The unchanged RPU `run-app.sh` was also rerun for Node ESM/CommonJS and Bun, with outputs under `fixed-runs/rpu-run-app-*.txt`. TypeScript 7 CommonJS compilation passes (`cjs-typecheck.txt`).

The Next fixture supplies explicit source attributes as the reference instructs for webpack's virtual stack frames; the unbundled Node/Bun fixtures check the helper's inferred location. Next's server owns its lifecycle, so that check waits for batch export before framework shutdown. The small Node/Bun apps flush at shutdown before the 5-second batch delay, preserving their own drain/exit behavior.

## Validation boundaries

These are native local HTTP checks with the real SDKs and Daemon decoder, not a live Daemon/MCP or hosted-vendor round trip. P1's accepted integration tests establish forwarding; this task verifies that the skill matches its implementation. No Next production build, edge runtime, Deno, Workers or packaged-release test is claimed. New Next setup is deliberately Node-development-only; existing production/edge registrations are preserved. The local install check used the installed skills CLI in a disposable project, not the user's global skill directories or an unpublished remote ref.

The first broader redaction test attempt inside the sandbox failed to bind loopback (`EADDRINUSE`, port 0). Native Daemon tests are recorded separately. Initial fixture runs also exposed harness issues (OTLP integer attributes decode as strings; a non-bundling transpile didn't convert CJS imports; Next's automatic dependency installation removed undeclared fixture symlinks). Those harness issues were corrected; the outputs here come from the final extracted snippets.


## Final checks and performance

One `lease bench` command ran 23:05:56–23:18:02 UTC, with checks sequentially, as requested by the lead:

- `bun run typecheck`: **18/18 tasks pass**, 17 cached.
- `bun run --cwd apps/daemon test`: **3293 pass, 87 skip, 0 fail**, 102564 assertions, 580 files, 529.59 seconds. This is the lead-requested full Daemon suite; full monorepo tests were not repeated.
- `bun run lint`: **pass**, formatting checked 5674 files.
- `bun run bench traces --runs 3 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c-eng656-traces.json`: **exit 1**, two existing RSS gates fail. No baseline or tolerance changed.

| Metric | UF7 median (range), 3 runs | Historical accepted P1 unconfigured median (range) |
| --- | ---: | ---: |
| Peak RSS delta, MiB | 192.3 (179.4–199.2) | 197.81 (159.73–199.42) |
| RSS after quiet, MiB | 299.2 (287.4–305.7) | 304.83 (235.56–305.17) |
| Spans/s | 17517 (17201–17673) | 16139.85 (14165.87–16433.85) |
| Ingest, ms | 11417 (11317–11627) | 12391.69 (12170.00–14118.44) |
| RPC p99, ms | 2.72 (2.61–5.98) | 6.03 (5.89–6.66) |

The lead supplied a base post-quiet value of **292.3 MiB** (and 272.0 with TF2). UF7's quiet median is 6.9 MiB above that base value, with the base inside UF7's run range. Both RSS ranges overlap the inherited P1 measurements in `apps/daemon/src/traces/BENCH.md` and `packages/bench/measurements/eng-674/forwarding-unconfigured.json`. These observations do not establish a new regression from this narrow change, nor do they resolve the failed gates. Existing [ENG-682](https://linear.app/luxdev/issue/ENG-682) retains that limitation. No fresh code-disabled base benchmark was run.

The runner reported **3.3 background cores busy** (old baseline: 11.1), so no controlled CPU/throughput improvement is claimed. The benchmark ran against source `9a0fac480958` plus this dirty patch, forwarding unconfigured, 200000 spans/run and 32 seconds quiet per run. Complete machine/run metadata and comparison are retained in `fixed-runs/benchmark.{json,txt}`. Correctness summaries and lease timestamps are in `correctness.txt` and `leased-checks.txt`. Terminal-output trailing whitespace is normalized in the recorded text files.
