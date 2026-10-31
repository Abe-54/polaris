# P6 fixes (UF6, ENG-666)

Every P6 finding in `../../2026-10-31-traces-RPU.md` is fixed; none is declined. The repros moved beside the code as real tests and the copies here (`deps.ts`, `model.test.ts`, `view.test.tsx`) are deleted. Paths below are under `apps/desktop/src/renderer/features/traces/`.

| # | Fix | Test |
|---|---|---|
| P6-1 | `openView` opens fitted whenever width alone allows 0.8×, so height never pushes a row under the foot. The layout keeps room under the last layer only for connectors that leave it (the settlement map is 830 px tall, was 882; at 780×680 it opens at 0.73×). | `model/map/view.test.ts` "finding P6-1"; the map screenshot script now measures every fixture map's nodes against the foot and fails on any clipped row (`clipped.json`). |
| P6-2 | `matchService` takes a host's first label only under a private suffix (`.internal`, `.local`, `.localhost`, `.lan`, `.home.arpa`, `.svc`, so also `.svc.cluster.local`); anything else matches by its exact name. | `model/map/calls.test.ts` "finding P6-2"; `map.test.ts`'s matching table now asserts `api.stripe.com` and `api.v1.Users` are not `api`. |
| P6-3 | A client span with no child in another service makes no call of its own when one of its children is a client or producer span; the innermost span carries the call. | `calls.test.ts` "finding P6-3" (HTTP by name, by IP, and an ORM over its driver). |
| P6-4 | A connector up to a higher layer climbs a side lane right of both ends, turns in under the callee's art at its own offset, and is labelled beside the lane. The map widens to keep that label inside it. Same-layer connectors keep the old route round below. | `view.test.ts` "finding P6-4". |
| P6-5 | N+1 is judged on `repeated`: the most calls one span made (a loop, walking past client spans that wrap the call), or one served request (a server or consumer entry) made. A test runner's internal root is neither, so twelve tests that call once each aren't added up. The panel's line still counts per request. | `calls.test.ts` "finding P6-5": twelve tests (not flagged), a script's loop under one span (flagged), a request whose iterations each have their own span (flagged). |
| P6-6 | A node's click passes whether a pointer made it (`event.detail > 0`); only a pointer click can be vetoed by the pan that just ended. The canvas also clears the drag on any click. | `ui/map/ServiceMap.test.tsx` "finding P6-6", plus "a pan that ends on a service doesn't select it". |
| P6-7 | The map's size is memoised on its numbers, and the view re-opens only until the user pans, zooms or fits (`touched` resets only on mount; a new trace remounts the map). | `ServiceMap.test.tsx` "finding P6-7". |
| P6-8 | `Caller.launched` is true only when the root has a `launchedTurn`. The kicker reads "turn 11" for a launched run, else "during turn 11"; the legend reads "Started by the agent", "Started during a turn" or "Started between turns". | `calls.test.ts` "finding P6-8" (all three), `ServiceMap.test.tsx` "finding P6-8". |
| P6-9 | A failed request among the slowest carries the word "error", as waterfall rows do. | `ui/map/ServicePanel.test.tsx` "finding P6-9" (only the failed row says it). |
| P6-10 | An inferred dependency's third tile reads "Client spans". | `ServicePanel.test.tsx` "finding P6-10". |
| P6-11 | Connector labels are `aria-hidden`, with their lines. The panel's Calls and Called by lists carry the same facts. | `ServiceMap.test.tsx` "finding P6-11". |
| P6-12 | Focusing a service from the keyboard pans the map just enough to show it (`revealView`), and the canvas pins its scroll to 0 so a browser's focus scroll can't move the foot. A pointer press doesn't pan (it focuses before a drag). | `view.test.ts` "finding P6-12" (pure), `ServiceMap.test.tsx` "finding P6-12" (scroll pinned). Real Chromium focus scrolling isn't exercised in happy-dom. |

## Trade-offs

- **P6-1.** A tall, narrow map (seven or more layers in a single column) now opens fitted below 0.5×, where labels are hard to read, instead of at 0.8× with rows below the fold. The review's P1 was a row hidden under the foot with no sign; a small whole map is the honest opening, and zoom is one key away.
- **P6-4.** The side lane can pass beside nodes in the layers it climbs through and, when the caller sits right of the callee, under nodes in the callee's row. It no longer retraces the call down or puts its label in the callee's label.
- **P6-5.** A loop whose iterations each sit in their own span, under a non-served root (a script, a test), isn't flagged. Flagging it would bring back the test-runner false positive.

DESIGN.md's Service map "As built" note is updated to match.
