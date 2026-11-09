# Shared predictors

`@polaris/predict` runs in the Client main process and the Daemon. Runtime modules use TypeScript, Effect and standard web APIs only; they do not import Electron, Bun or Node APIs. `createPredictor()` retains a bounded rolling latency recorder and starts no requests or timers until its stream is consumed.

```ts
const predictor = createPredictor();
const stream = predictor.complete(request, { signal });
```

`request` is the protocol's `PredictionRequest`. `Delta` contains provisional raw model output. `Final.text` is authoritative after stop-marker removal, suffix-overlap removal, line limiting and whitespace-only abstention. A successful stream emits exactly one Final. Interrupting consumption or aborting `signal` cancels the HTTP request and response body. Errors and cancellations produce no Final or latency sample. Callers cancel the previous request when the buffer changes and check that the buffer is still current before acceptance.

The three formats are `mellum-spm`, `qwen-fim`, and generic `suffix` (OpenAI-compatible only). Mellum uses `<filename>` blocks then suffix/prefix/middle markers. Qwen uses its pipe-delimited FIM tokens. This ports the Polaris TABSPIKE formats from `spike/tab-completion` at `b62492a5`; no external project implementation was copied. The formats were checked against the [Mellum card](https://huggingface.co/JetBrains/Mellum-4b-base), [Mellum2 card](https://huggingface.co/JetBrains/Mellum2-12B-A2.5B-Base) and [Qwen card](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B). Mellum2's card documents completions but does not specify the earlier Mellum FIM grammar; the shared Mellum2 server is covered by the live test.

`countTokens(text)` is a conservative UTF-8 byte upper bound for byte-level tokenizers, **not an exact model token count**. `packContext(context, budgetTokens, counter?)` selects whole pieces in stable order: definitions, import outlines, edit hunks, diagnostics. It skips oversized pieces. `buildPrompt` reserves up to half its input budget for context, counts format markers, and fits the nearest prefix and suffix without splitting Unicode code points. When the prefix exceeds its budget, its start advances in 256-code-point steps to the next whole-line boundary; consecutive keystrokes within a step retain the same prompt start. A single overlong line uses code-point step boundaries; tiny single-line prefixes retain the nearest fitting suffix. Callers can supply a model tokenizer through `PredictionOptions.countTokens`. Generation has a separate `maxTokens` budget. Ordinary expressions use at most 32 tokens and stop at the newline; block openers (`{`, `=>`, or an indented line after `:`) retain the caller's token and line limits. Equal-priority context pieces sort by source and text, so reordering the same facts does not invalidate the prompt cache.

OpenAI-compatible endpoints use `/v1/completions` and SSE; Ollama uses `/api/generate`, NDJSON and `raw:true`. Base URLs may include `/v1` for OpenAI-compatible servers. Requests disable redirects and ambient credentials. Provider payloads are decoded with Effect Schema; truncated streams and malformed/oversized records fail. Endpoint p50 uses at most 31 successful timings for each of at most 32 endpoints; no idle timer performs eviction.

The v1 seam is the `Predictor` interface and the protocol formats. Next-edit models use the separate `EditPredictor` interface below.

## Verification

- `bun test packages/predict apps/daemon/src/prediction apps/desktop/src/main/prediction`
- `POLARIS_PREDICTION_LIVE=1 bun test packages/predict/src/live.test.ts`

The live harness uses an already-running Mellum2 server, default `http://127.0.0.1:8080`, model `mellum2-12b-a2.5b`. Override `POLARIS_PREDICTION_URL` / `POLARIS_PREDICTION_MODEL` as needed. The harness never starts or stops the server (the product's own managed server is the Daemon's, ADR 0049). Recorded model output in `postprocess.test.ts` comes from TABSPIKE's `llama-mellum-full.jsonl`, c02 A. The live-recorded `src/fixtures/mellum-sum.sse` also replays through the complete predictor, split at every byte. Other streaming fixtures are synthetic boundary/error cases.

The Daemon lazily imports its predictor for `prediction.complete`. `LocalPredictor.layer` in `apps/desktop/src/main/prediction/localPredictor.ts` exposes the same `complete` and `p50` functions. TPLACE owns placement, fallback and service composition; TCTX owns Host context assembly and Trust checks. Prediction completion has no EventStore dependency and changes no command, commit, acknowledgement or recovery semantics.

## Latency and provisional display

`PredictionOptions.onTiming` observes prompt construction, first token, and Final, in milliseconds from predictor start. The existing bounded `LatencyRecorder` still records successful Final latency for placement. OpenAI-compatible requests explicitly set `cache_prompt: true`; llama-server's `--cache-reuse` remains a user-run server setting.

The Desktop App carries main-process phase timings in its Final IPC item: placement, context, prompt (Client serving only), first token and Final are cumulative from subscription start. `ipc` measures renderer dispatch to main subscription entry using performance time origins. Renderer marks `polaris.prediction.keystroke`, `ipc`, `render`, and `final` keep only the latest sample for each stage and contain no source text. `render` is the first ghost widget DOM update, not a physical display timestamp.

Deltas can display a stable first line without a Tab keycap. Final enables acceptance only after matching its prefix; Tab inserts only the shown text. If post-processing retracts the preview, the displayed text is replaced by Final. Failure, cancellation and placement fallback clear provisional text; a fallback emits an IPC Reset before its new deltas. No Daemon wire contract or lifecycle authority changes.

Build with `bun apps/desktop/scripts/build.ts --no-app`, then run `node --experimental-transform-types apps/desktop/scripts/prediction/latency.ts <label>` for real Electron keystrokes against the shared server. Three fixed plain-text FIM fixtures each have seven space/letter sequences; discard the first sequence per fixture for warm p50/p95 (36 samples). Isolated profiles and Daemons are cleaned up. The harness also captures both themes, three densities, Reduce Motion, the colourblind palette, load, and model-server memory separately. Hidden-window animation-frame timestamps are diagnostic only; compare the widget `render` marks. Run `bun apps/desktop/scripts/prediction/cache.ts` separately to record production request bodies and llama-server cache timings. Neither script starts or stops model servers.


## Edit Predictions

```ts
const predictor = createEditPredictor();
const stream = predictor.predict(request, { signal });
const medianMs = predictor.p50(request.endpoint);
```

`request` is `EditPredictionRequest`: the live buffer and UTF-16 cursor, optional `focus` for a jump probe, frozen history hunks, endpoint, model, format, and output-token budget. `createEditPredictor(fetcher?)` keeps the serving slice's existing signature. It shares the FIM endpoint decoder and bounded latency recorder. The diff implementation loads only when an Edit Prediction is consumed; importing the package or constructing a predictor does not load it. It emits one `Final` and no provisional deltas; errors, aborts, and interrupted consumption produce no Final or latency sample. Both OpenAI-compatible completions and Ollama raw generation are supported. OpenAI requests are greedy and set `cache_prompt: true`.

Zeta 2.1 uses 40 prefix lines and two marked regions, centred on `focus ?? cursor` with the cursor near the first region's end. Sweep rewrites 10 lines above and below the focus, clipped at file edges. History stays in request order; Sweep includes every hunk as a `.diff` block and reconstructs `original/` from the most recent matching hunk. A frozen hunk that no longer matches the live buffer is left in history without pretending it describes `original/`. Supplied `context` is reserved for future prompt enrichment; these prompts follow the spike's nearby-code and edit-history layouts.

`Final.window` bounds the original buffer range. The parser maps Zeta markers back to their regions, removes the cursor token and format terminators, and preserves CRLF. The combined rewritten window goes through line alignment and then character alignment using the existing syntax-diff Myers implementation. Hunks are ordered, disjoint and use original-buffer UTF-16 offsets. Apply them in one transaction; `Final.cursor` addresses the resulting buffer, using Zeta's marker or the end of the last hunk. Echoed windows, repeated markers, and whitespace-only echoes yield no edits and a null cursor.

The guards suppress reintroduced history lines, edits outside the window, unrelated whitespace changes, changes to healthy closing lines, and expansion of an unrelated shorthand property that could bypass a local default. A rejected hunk drops the whole prediction, since another hunk may depend on it; each dropped hunk is reported in `suppressed`. These are request-only heuristics, not a claim that every unsafe suggestion can be detected. Invalid or truncated regions fail closed. Input prompts are capped at 32,768 units of the configured token counter (conservative UTF-8 bytes by default), output at 65,536 UTF-16 units, Myers at 2,048 insertions/deletions per alignment, and Final at 64 hunks. Oversized or overly complex requests/results fail rather than returning a partial rewrite.

### Replay and live checks

`bun test packages/predict` covers the 60 scored outputs (30 per format), endpoint streaming/cancellation, window edges, UTF-16 and CRLF mapping, multi-region cursor placement, guards, and the stable FIM prefix regression. Fixtures and provenance are under `src/edit/fixtures/`.

| Recorded run | Exact before / after guards | Dangerous before / after | Abstain before / after |
| --- | --- | --- | --- |
| Zeta Q4 frozen n-gram | 9 / 9 | 1 / 0 | 16 / 17 |
| Sweep Q8 n-gram | 6 / 6 | 7 / 0 | 15 / 22 |

The four Zeta and two Sweep wrong outputs remain wrong. Both formats' `rf03` include an extra allowed ground-truth hunk. Zeta `rf01` is exact by the spike's whitespace-insensitive metric but differs from the commit's multiline ternary formatting; the replay explicitly checks this discrepancy instead of claiming byte-exact agreement. All other exact-labelled results match an allowed ground-truth file byte for byte, and their exact minimal hunks are asserted.

```sh
POLARIS_PREDICTION_LIVE=1 \
POLARIS_EDIT_URL=http://127.0.0.1:8091 \
POLARIS_EDIT_MODEL=your-model \
POLARIS_EDIT_FORMAT=zeta-2.1 \
bun test packages/predict/src/edit/live.test.ts
```

Use `sweep-next-edit` for Sweep; set `POLARIS_EDIT_KIND=ollama` for an Ollama endpoint. The harness skips unless opted in, runs all 100 hardening cases, and prints the quality table and request-to-Final p50. Exact and abstain are scored mechanically; acceptable/wrong/dangerous require a matching hand-reviewed output, and novel outputs print their hunks as `unreviewed`. The harness never starts or stops a model server and refuses port 8080. A live run requires a separately available server; replay evidence is not live model verification.

`bun packages/predict/src/edit/bench.ts` measures FIM prompt construction and the complete edit predictor over the recorded responses with an in-memory HTTP boundary, three rounds. It prints p50/p95, not model latency. The Daemon's existing `prediction-context` benchmark separately measures context RPC overhead against the machine baseline.
