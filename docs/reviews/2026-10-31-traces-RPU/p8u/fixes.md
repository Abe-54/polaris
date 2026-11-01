# P8U fixes (UF8, ENG-660)

Every P8U finding in [the review](../../2026-10-31-traces-RPU.md#p8u-traces-in-review-against-the-real-tracescompare) is fixed. None was declined. The repros now live in `apps/desktop/src/renderer/features/review/traces/` as real tests, and the copies that were here are deleted:
- `daemonFit.test.tsx` and its harness `daemonFit.testing.tsx` run against the real Daemon `TraceStore`, `compareForSession` and `list`.
- `useReviewTraces.refetch.test.tsx` covers P8U-5 and P8U-6.

The harness loads the Daemon modules at run time, not through static imports. The renderer's test tsconfig has DOM types, and the Daemon's sources don't typecheck under them (`Worker.unref`, `Blob` parts).

| Finding | Fix | Test |
|---|---|---|
| P8U-1 | A null p50 on either side reads "no baseline" with its runs ("1 → 1 run") and ranks with the no-baseline rows. A route with no complete run in the later Turn reads "not run", never "– → not run". A picked Turn sends `a: Baseline`, every earlier Turn. The footnote says "at least 3 runs". The fixture compare (`fixtureApi.ts`) and the preview scenes (`tracesScenes.ts`) apply the three-run rule, and the fixture also supports Baseline and Turns. The tests that asserted impossible states are corrected. DESIGN.md is updated. | `daemonFit.test.tsx` P8U-1 (three cases), `model.test.ts`, `fixtureApi.test.ts`, `useReviewTraces.test.tsx` |
| P8U-2 | `TraceCompareSelector` gains an additive `Turns {firstTurnId, lastTurnId}`. `compareForSession` resolves it to the session's Turn ids in order and refuses a reversed range (`E-INPUT`) or an unknown end (`E-TRACE-NOT-FOUND`). `compareQuery.ts` selects `turn_id IN (…)`, and Baseline starts before the range's first Turn and excludes all its Turns. Review sends a Review Turn of several Turns as a range; one Turn still goes as `Turn`. The ⌘5 jump searches each of the side's Turns, latest first. The MCP `compare` tool accepts the range through the same schema. `docs/specs/traces-tools-v1.md` and the traces README are updated. | `daemonFit.test.tsx` P8U-2, `compare.test.ts` (range cases and refusals), `mcp/tools/compare.test.ts`, `protocol/traces.test.ts` |
| P8U-3 | The jump keeps the route and service filters but drops `limit: 1`. It then picks the newest trace whose root and service equal the row's exactly. | `daemonFit.test.tsx` P8U-3 |
| P8U-4 | There is no ratio, and so no change word, when either p50 is 0 ms. | `daemonFit.test.tsx` P8U-4, `model.test.ts` |
| P8U-5 | The request key includes the Host's connection epoch, so a reconnect asks again. The request still goes out while reconnecting: the repro expects that failure to show first. | `useReviewTraces.refetch.test.tsx` P8U-5 |
| P8U-6 | While another pick's comparison is in flight, the last answer and its plan stay shown, and the Route timings row reads "comparing…". | `useReviewTraces.refetch.test.tsx` P8U-6, `model.test.ts` |
| P8U-7 | A route whose later-Turn runs are all partial reads "partial", ranks before "not run", and stays listed even when both sides are partial. The row's tooltip counts the partial runs left out. | `model.test.ts` |

## Choices worth a look

- No new capability gates `Turns`. `traces.compare` hasn't shipped in any release: it isn't in a tag or on origin/main. So every Daemon that advertises it will accept the range once this lands. If a Daemon with the old union ever ships, Review should send `Turns` only behind a `traces.compare.turns` capability.
- The session pick ("all") still compares the latest Review Turn with the last accepted one, now as Turn ranges, as DESIGN describes. Only a picked Turn uses Baseline. Baseline before the latest Turn would also count the intermediate Turns under review. Whether the session pick should change is the Lead's call.
