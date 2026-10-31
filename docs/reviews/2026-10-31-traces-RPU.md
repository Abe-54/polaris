# RPU: adversarial review of phase 2's UI and the skill (P5, P6, P8U, P10, P7), ENG-657

Reviewed the integration branch at `99ca0343d`. The diffs reviewed, each against its first parent:
- P5, Profiles: `Merge P5` (`b8e6e0eb7`).
- P6, Service map: `Merge P6` (`8f873b368`).
- P8U, Traces in Review: `Merge P8U` (`d49763b44`), checked against P8's Daemon `traces.compare` (`7f2f4e4b3`).
- P10, Settings → Traces and Set up tracing: `Merge P10` (`99ca0343d`).
- P7, the polaris-tracing skill: `af9a2d9c9` (merged in `e049fef37`), checked against HEAD.

No product code was changed.

What the Daemon at `99ca0343d` serves matters for every UI finding:
- `traces.compare` is implemented and advertised (`apps/daemon/src/transport/serve.ts:250`).
- `traces.settings` and `traces.profiles` are not: `handlers.ts:477-483` answers `Unsupported`. So P5 and P10 can only be exercised on fixtures today, and their findings land the day P1/P3/P4 ship.
- Forwarding to a vendor (ENG-674) isn't implemented.

Evidence:
- Failing repro tests in `docs/reviews/2026-10-31-traces-RPU/{p5,p6,p8u,p10}/`, named `finding <id>: …`. Each fails on this base and should pass once its finding is fixed.
- P7's scripts and run outputs in `docs/reviews/2026-10-31-traces-RPU/p7/`: the reference code extracted verbatim and run on Node 24.22.1 and Bun 1.4.4 against a stand-in receiver that uses the Daemon's own `decodeBatch` and redaction.
- Screenshots through scriptedElectron (SX): see [Screenshots](#screenshots).

Run the repros from `apps/desktop`, which has the DOM preload and the test dependencies. The P8U `daemon-fit` tests import the real Daemon `TraceStore` and `compareForSession`, and also run from there:

```sh
cd apps/desktop && bun test ../../docs/reviews/2026-10-31-traces-RPU
```

Result on `99ca0343d`: 0 pass, 39 fail (P5 12, P6 9, P8U 8, P10 10). See [Checks run](#checks-run).

Severity follows the product-design skill's Review output:
- **P0**: blocks the primary task, or a severe accessibility failure.
- **P1**: a misleading state or consequence, or a missing critical state.
- **P2**: friction, inconsistency, or a signal used as decoration.
- **P3**: minor craft.

## Summary

| # | Sev | Status | Finding |
|---|---|---|---|
| P8U-1 | P1 | CONFIRMED (test) | Against the real Daemon, any route with fewer than 3 runs a side reads "p50 – → –"; "no baseline" and "not run" rows never show a p50 |
| P8U-2 | P1 | CONFIRMED (test) | A Review Turn made of several Turns is compared by its last Turn only |
| P10-1 | P1 | CONFIRMED (test, run) | The fixed-exporter "one-line change" reads a variable Polaris never sets, so applying it still sends nothing to Polaris |
| P7-2 | P1 | CONFIRMED (code) | The skill says Polaris forwards to the vendor; forwarding isn't implemented, so the vendor's dev dataset silently stops getting spans |
| P6-1 | P1 | CONFIRMED (test, screenshot) | The Service map's opening view clips the bottom row whenever height, not width, limits it |
| P6-2 | P1 | CONFIRMED (test) | Matching a host by its first label folds `api.stripe.com` into a service named `api`, or drops it as a self-call |
| P6-3 | P1 | CONFIRMED (test) | Nested client spans count one call twice, or add a phantom host |
| P5-1 | P1 | CONFIRMED (test) | In a checkout with no traces, a listed Profile can't be opened |
| P5-2 | P1 | CONFIRMED (test) | The Profiles watch never reopens after a reconnect, and a drop replaces the list with an error (RT3 finding 1 again) |
| P8U-5 | P2 | CONFIRMED (test) | A comparison that failed while the Host was away isn't asked again on reconnect |
| P8U-6 | P2 | CONFIRMED (test) | Changing the pick while Route timings is open flips the pane back to the diff until the answer arrives |
| P8U-3 | P2 | CONFIRMED (test) | Opening a route named with `*` or `?` can select another route's trace (the filter is a glob) |
| P6-4 | P2 | CONFIRMED (test) | A call back up a cycle is drawn over the call down, through the callee, with its label on the callee's name |
| P6-5 | P2 | CONFIRMED (test) | N+1 is counted per entry, so 12 tests that each call once read as "12 calls … in one request" |
| P6-6 | P2 | CONFIRMED (test) | After any pan, activating a service from the keyboard or a screen reader does nothing |
| P6-7 | P2 | CONFIRMED (test) | A trace still receiving spans throws away the user's pan and zoom on every batch |
| P6-8 | P2 | CONFIRMED (test) | "Started by the agent" is claimed for runs no Turn is known to have launched |
| P6-9 | P2 | CONFIRMED (test) | A failed call among the slowest requests is shown only in red |
| P5-3 | P2 | CONFIRMED (test) | Restart state lives in the component: a refusal follows to another service, and an in-flight restart can be sent twice |
| P5-4 | P2 | CONFIRMED (test, fixture) | A restart the user clicked reads "Restarted with profiling by the agent" |
| P5-5 | P2 | CONFIRMED (test, fixture) | A recording in progress shows a read failure and "Record it again" |
| P5-6 | P2 | CONFIRMED (test) | A frame chosen by keyboard can leave the shown range without the chart panning to it |
| P5-7 | P2 | CONFIRMED (test) | Screen readers get nothing from the flame chart |
| P5-8 | P2 | CONFIRMED (code) | Under the System theme, the canvas keeps the old appearance's colours when macOS switches |
| P5-9 | P2 | CONFIRMED (test) | Restart with profiling stays enabled while the Host is away, and never says what it stops |
| P5-12 | P2 | CONFIRMED (code) | The Profiles tab tells every user to update a Daemon that no version implements |
| P10-2 | P2 | CONFIRMED (test) | The Keep row promises "errors always"; the Daemon prunes error spans past 7 days and under pressure |
| P10-3 | P2 | CONFIRMED (test) | If the Host drops mid-install, Set up tracing sticks on "Installing…" until remount |
| P10-4 | P2 | CONFIRMED (test) / PLAUSIBLE | The skill is installed only for Claude Code and Codex, but the agent starts on the session's Harness |
| P7-3 | P2 | CONFIRMED (run) | The skill's shutdown handler replaces the app's own SIGTERM handling, and the last batch is lost in a race |
| P7-4 | P2 | CONFIRMED (code) | The E-TRACE-NONE diagnosis misleads, and "0 traces" isn't covered |
| P7-5 | P2 | CONFIRMED (code) | Next.js projects get no working recipe, and node.md's first instruction is wrong for them |
| P7-6 | P2 | CONFIRMED (run) | The tracing helper breaks in CommonJS projects, which node.md says are supported |
| P7-7 | P2 | CONFIRMED (run) | The bunfig preload and the ungated log exporters change production |
| P7-8 | P2 | CONFIRMED (run) | Bun and CJS stacks with a frame in `auth.ts`, `session.ts` or `tokens.ts` are stored as "[redacted]" |
| P8U-4 | P3 | CONFIRMED (test) | A later p50 of 0 ms reads "Infinity× faster" |
| P8U-7 | P3 | CONFIRMED (code) | Routes whose later traces were all partial read "not run" |
| P6-10 | P3 | CONFIRMED (code) | An inferred dependency's panel shows "Spans n" beside "Inferred from client spans" |
| P6-11 | P3 | CONFIRMED (code) | Connector labels reach assistive technology as orphaned text |
| P6-12 | P3 | PLAUSIBLE | Tabbing to an off-screen service may scroll the overflow-hidden canvas |
| P5-10 | P3 | CONFIRMED (test) | Dragging the whole recording shifts it to negative time |
| P5-11 | P3 | CONFIRMED (test) | ⌘L in the profile panel adds the trace once the trace bar re-registers |
| P10-5 | P3 | CONFIRMED (test) | A refused save rolls back to a stale snapshot, overwriting a later save |
| P10-6 | P3 | CONFIRMED (test) | Removing the picked Workspace shows "No workspaces yet" while others are listed |
| P10-7 | P3 | CONFIRMED (test) | A forward collector, once set, can never be removed |
| P10-8 | P3 | CONFIRMED (code) | In "app exports elsewhere", the fixed-exporter card promises Polaris will see traces after the change |
| P10-9 | P3 | CONFIRMED (code) | The collector URL's validation reason isn't announced and can be cut off |
| P10-10 | P3 | CONFIRMED (code) | "Ask an agent" sends a Starting session's follow-up to a new agent in the same checkout |
| P10-11 | P3 | PLAUSIBLE | A session in a review checkout would get its follow-up agent in the Workspace root |
| P7-9 | P3 | CONFIRMED (run) | bun.md's "add this to the tracing helper" redeclares `recordFailure` |
| P7-10 | P3 | CONFIRMED (run) | The Bun route fallback names spans by raw path, and outgoing calls don't propagate context |
| P7-11 | P3 | CONFIRMED (run/code) | Smaller skill inaccuracies (import cost, `bun test` preload, plain `node:http` names, compression, metrics) |

P7-1 (the same defect as P10-1, seen from the skill) is folded into P10-1.

## P8U: Traces in Review, against the real `traces.compare`

The request the desktop sends is right. Its reading of the response is not: P8U was built and tested only against the fixture compare, and the fixture leaves out the Daemon's three-run rule.

### P8U-1. P1: Fewer than three runs on a side reads "p50 – → –" (CONFIRMED (test))

Locations:
- `apps/daemon/src/traces/compareQuery.ts:62-70`, `:193`: `enough = before ≥ 3 && after ≥ 3`, else p50 and p95 are null. The spec says the same (`docs/specs/traces-tools-v1.md`, "Fewer than three complete retained samples on either side means no baseline").
- `apps/desktop/src/renderer/features/review/traces/model.ts:99-110`, `:122`, `:153-169`, `:179`.
- `apps/desktop/src/renderer/features/traces/preview/fixtureApi.ts:106-109`: the fixture computes a p50 for any count.
- Tests that lock in states the Daemon never produces: `fixtureApi.test.ts` (`[null, 38]` for one run) and `useReviewTraces.test.tsx` (`after: {p50Ms: 38, count: 1}`).

What happens:
- A route that ran once in each Turn, the usual case for "run the tests", reads `p50 – → –` with no change word, classed "compared" and sorted as ratio 0.
- A route new in the later Turn always reads `– … no baseline`; DESIGN shows "212 ms".
- A route that didn't run in the later Turn always reads `– → not run`; DESIGN shows "1.9 s → not run".
- The desktop compares with one earlier Turn (`a`), which makes three runs a side rare. P8's spec has a `Baseline` selector (traces from earlier Turns, the Lead's decision); the desktop never uses it.

Repro: `daemon-fit.test.tsx`, "finding P8U-1" (three cases), through the real Daemon compare. The preview scenes and screenshots show the fixture's impossible rows (`p8u-route-timings-fixture-dark-calm.png`).

Smallest fix:
1. In `routeRows`, a null p50 on either side reads "no baseline" with the runs, and ranks with no-baseline rows.
2. Send `a: Baseline` for a picked Turn instead of the Turn before it; update DESIGN.
3. Give `fixtureComparison` the three-run rule and fix the fixture and hook tests that assert impossible states.
4. Say "at least 3 runs" in the footnote (`TracesCompareBody.tsx:25`).

### P8U-2. P1: A multi-Turn Review Turn is compared by its last Turn only (CONFIRMED (test))

Locations: `model.ts:28-31` (`sideOf` sends `turn.turns.at(-1).id`); `compareQuery.ts:40` (`turn_id=?`); `useReviewTraces.ts:46` (the ⌘5 jump filters the same way).

What happens: a user message whose routes ran in its opening Turn, followed by a Harness continuation Turn, shows those routes as "not run". The "→ not run" row then opens the earlier Review Turn's traces. The baseline side drops its earlier Turns the same way.

Repro: `daemon-fit.test.tsx`, "finding P8U-2": expects `["POST /invoices","compared",3]`, gets `["POST /invoices","not-run",0]`.

Smallest fix: a Turn-range selector in the protocol and Daemon (e.g. `Turns {firstTurnId, lastTurnId}`, the shape Review's diff uses), with the matching filter for the jump. The desktop can't merge percentiles from several requests.

### P8U-5. P2: No retry on reconnect (CONFIRMED (test))

Locations: `useReviewTraces.ts:93-119` (deps `[api, hostKey, sessionId, key, supported, ended]`, no epoch); `main/ipc/traces.ts:49-52`.

What happens: opening Review during a reconnect leaves "Route timings · unavailable" until a Turn ends or the pick changes. Capabilities are kept while disconnected, so nothing re-runs. RT3 fixed the same pattern for Traces watches.

Repro: `hook.test.tsx`, "finding P8U-5".

Smallest fix: put `host?.status.epoch` in the request key, and skip the request while not connected.

### P8U-6. P2: The pane flips back to the diff while a new pick loads (CONFIRMED (test))

Locations: `useReviewTraces.ts:121`, `:138-141` (null whenever `seen.key !== key`); `section.ts:36`, `:50` (`shown = open && list !== null`); `model.ts:203` promises a "comparing…" figure that's never produced.

What happens: the diff and its grouping bar flash in, then Route timings returns. On a slow Host (a Raspberry Pi) it's a visible jump.

Repro: `hook.test.tsx`, "finding P8U-6".

Smallest fix: keep the last answer (or a loading answer) while a new key is in flight, and show "comparing…".

### P8U-3. P2: A route named with `*` or `?` opens another route's trace (CONFIRMED (test))

Locations: `useReviewTraces.ts:46-52` passes `route: row.route` as `TraceFilter.route`, a glob with no escape (`packages/protocol/src/traces.ts:210`, `apps/daemon/src/traces/queries.ts:44-64`). The service filter matches any span's service, while compare's service is the root's, so with `limit: 1` a trace rooted elsewhere can also be picked (PLAUSIBLE).

What happens: an Express route "GET /files/*" opens the newest "GET /files/report" trace.

Repro: `daemon-fit.test.tsx`, "finding P8U-3", through the real `onOpenRoute` and Daemon `list`.

Smallest fix: watch with the default limit and pick `traces.find(t => t.root === row.route && t.service === row.service)`, or add an exact root filter to `TraceFilter`.

### P8U-4. P3: "Infinity× faster" (CONFIRMED (test))

`model.ts:99-102` guards only `before.p50Ms === 0`; `:184` divides by an after of 0. A root span with start = end is stored as 0 ms. Fix: a null ratio when either side is 0 (or under 1 ms). Repro: "finding P8U-4".

### P8U-7. P3: All-partial routes read "not run" (CONFIRMED (code))

`compareQuery.ts` excludes partial traces from the counts and reports them in `routes[].partial`; `model.ts:104-134` ignores `partial`. A test trace trimmed by retention (`retention.ts:114`) reads "→ not run"; if both sides are partial the route disappears. Fix: show "partial" when `partial.after > 0`.

Verified true: the capability gate and its Unsupported copy; route key = root service + root span name on both sides; compare and the ⌘5 jump both filter on the root span's `turn_id` (neither uses P2's `launchedTurn`); nearest-rank percentiles in ms on both sides; out-of-order responses dropped; fetches only on open, pick change and Turn end; Schema Diff and Route timings share the pane.

## P6: the Service map

### P6-1. P1: The opening view clips the bottom row (CONFIRMED (test, screenshot))

The Lead's note from P6's acceptance, confirmed with its cause.

Locations: `apps/desktop/src/renderer/features/traces/model/map/viewport.ts:46-52` (`openView`); `model/map/layout.ts:12`, `:26`, `:207` (PITCH 214, FIRST_BASE 180, 60 px under the last row); `ui/map/usePanZoom.ts:53-57`, `:68-82`.

What happens:
- The settlement trace lays out at 880×882 in 4 layers; the bottom row's label box ends at 826.
- In a 780×680 canvas, width allows 0.83× but height only (680 − 24 − 52) / 882 = 0.685×. `fitView` takes 0.685.
- `openView` sees 0.685 < `OPEN_ZOOM` and opens at 0.8× from `MARGIN.top`, never checking height. The bottom row ends at 24 + 826 × 0.8 = 685 px, under the foot (H − 52).
- Any canvas shorter than about 737 px hides `redis` and `api.postmarkapp.com`. The latter carries the trace's only error. A 5-layer map needs about 908 px, so it clips at every common window height.

Repro: `model.test.ts`, "finding P6-1" (780×680 and 780×720). Screenshots at the default 1440×900 window, every theme and density: `p6-bottom-row-map-midnight-calm.png`, `p6-bottom-row-map-light-compact.png`.

Smallest fix: fall back to 0.8× only when width is what doesn't fit; when height binds, open fitted:

```ts
const across = (canvas.width - 2 * MARGIN.side) / map.width;
if (fitted.k >= OPEN_ZOOM || across >= OPEN_ZOOM) return fitted;
```

If 0.69× reads too small, tighten the layout instead (the 60 px under the last row only when a route turns back up, a smaller PITCH). The test holds for either.

### P6-2. P1: First-label host matching merges third-party hosts into a traced service (CONFIRMED (test))

Locations: `model/map/infer.ts:123-128` (`matchService`); `model/map/graph.ts:136-138`.

What happens:
- A caller named `api` (a very common `service.name`) calling `https://api.stripe.com` maps the call to itself and skips it as a self-call: the dependency vanishes. Likewise `api.openai.com`, `api.github.com`, gRPC `api.v1.Users`.
- With a traced `api` present, `web` calling Stripe is drawn as `web → api` and merged with the real call (`×2`).
- P6's own test ("never a partial word") asserts `api.stripe.com → api`, codifying it.

Repro: `model.test.ts`, "finding P6-2".

Smallest fix: match the first label only when the rest is a private suffix (`.internal`, `.local`, `.localhost`, `.svc`, `.svc.cluster.local`, `.lan`); otherwise exact name only.

### P6-3. P1: Nested client spans double-count (CONFIRMED (test))

Locations: `model/map/graph.ts:113-150` (`clientCalls`), `:152-158`.

What happens: a client span whose only child is another client span in the same service (fetch over undici, an SDK over HTTP, an ORM over a pg driver) has no child in another service, so it falls through to `inferTarget` and makes its own call beside its child's. Two nested spans to `fx-rates.internal` give `×2`; with an IP URL a phantom `10.0.4.12` node appears; nested `db.system` spans give `postgresql ×2`. Every count doubles, and N+1 fires at 5 real calls.

Repro: `model.test.ts`, "finding P6-3".

Smallest fix: when no child is in another service, return `[]` if any child is itself a client or producer span.

### P6-4. P2: Back-edges run through the callee (CONFIRMED (test))

`model/map/layout.ts:155-180` (`routesOf`, `to.layer <= from.layer`). With gateway → billing → gateway, both nodes sit at x = 110; the return route rises through billing's art and label, over the call down, with its label inside billing's label box. Single-node rows are always centred, so every back-edge in a chain does this. Fix: route upward and same-layer edges along a side lane with the label beside it. Repro: "finding P6-4".

### P6-5. P2: N+1 per entry flags test runs (CONFIRMED (test))

`model/map/graph.ts:178-196`, `panel.ts:45-57`. A test runner's internal root is the entry for all its calls, so 12 tests that each call ledger-api once read "12 calls to ledger-api in one request: 73 ms each, 870 ms in all". That's Polaris's main case (`bun test`). Fix: count per parent span of the calls (sibling calls in one loop), or flag N+1 only under a server or consumer entry. Repro: "finding P6-5".

### P6-6. P2: Keyboard activation dropped after a pan (CONFIRMED (test))

`ui/map/usePanZoom.ts:133-135`, `:173`; `ui/map/ServiceMap.tsx:121-123`. `dragged` is set on pointerup and cleared only on the next pointerdown; Enter, Space or an assistive-technology click has no pointer events, so `wasDrag()` stays true and the selection is dropped. Fix: clear `dragged` in a canvas `onClick`, or ignore `wasDrag` when `event.detail === 0`. Repro: "finding P6-6".

### P6-7. P2: A growing trace resets pan and zoom (CONFIRMED (test))

`ui/map/ServiceMap.tsx:82-84`, `usePanZoom.ts:53-57`, `:68-73`. Each batch gives a new `size` object, so `opening` changes identity, `touched` resets and the view re-opens, up to 4 times a second. The waterfall keeps a growing trace in view; the map does the opposite. Fix: memoise `size` on `[width, height]`; reset `touched` only on mount. Repro: "finding P6-7".

### P6-8. P2: "Started by the agent" without a launch Turn (CONFIRMED (test))

`model/map/graph.ts:269`, `ui/map/ServiceMap.tsx:48`, `:128`, `model/map/words.ts:17-21`. The caller's Turn is `launchedTurn ?? turn`, and the legend says "Started by the agent" whenever it's non-null. P2 defines `launchedTurn = null` as a user terminal, a Codex launch or unknown. A command the user typed during Turn 11 reads "bun run settle.ts · turn 11, Started by the agent"; every fixture has `launchedTurn: null`, so the settlement map says it today. Fix: a `launched` flag on `Caller`; otherwise "during turn 11". Repro: "finding P6-8".

### P6-9. P2: Colour-only failure in "slowest requests" (CONFIRMED (test))

`ui/map/ServicePanel.tsx:166-177`: the failing Postmark call is only `severity-critical-text`. TF3 added an "error" word to waterfall rows; this list didn't get it (rule/no-colour-alone). Repro: "finding P6-9".

### P6-10 to P6-12. P3

- **P6-10 (CONFIRMED (code))**: `ServicePanel.tsx:240-241`, `graph.ts:240-244`: an inferred node's Spans tile counts the caller's client spans ("postgresql · Spans 3" beside "Inferred from client spans"). Hide it or label it "Client spans".
- **P6-11 (CONFIRMED (code))**: `MapLayer.tsx:140-149`: the SVG is `aria-hidden` but the connector label spans aren't, so a screen reader hears "×214 · HTTP ×2 · SQL" with no ends. Mark them `aria-hidden`.
- **P6-12 (PLAUSIBLE)**: `ServiceMap.tsx:100-131`: Chromium scrolls an `overflow:hidden` container to a focused child; the map never pans to a focused node, so `scrollTop` would shift the foot and the zoom anchor. With P6-1 the bottom row is exactly where this happens. Pan on focus and pin scroll to 0.

Verified true: call inference order and self-call skipping; entries; N+1 threshold; caller shown only for non-server roots; 0.8× opening and fit on double-click or `0`; BFS layers terminate on cycles; dimming by Find spans, Errors only and the Services chip; Calls / Call time on inferred nodes; changing trace remounts the map. `serviceMap` + `mapLayout` on the 10k-span, 30-service mesh: about 24 ms here (32 nodes, 66 edges). Not filed: two Postgres databases share one `postgresql` node (named by `db.system` alone).

## P5: Profiles

### P5-1. P1: A Profile can't open in a checkout with no traces (CONFIRMED (test))

`apps/desktop/src/renderer/features/traces/ui/TracesMode.tsx:87-96`: `<ProfilePanel>` mounts only when `setup === null`. With no traces, the main area shows Setup while the Profiles tab still lists recordings (a "Whole command" profile of `bun test` with no OTel). Clicking a row sets `aria-current` and nothing else. DESIGN expects a Profile without an open trace (⌘L adds it "when no trace is open"). Fix: a selected Profile mounts `ProfilePanel` whatever `setup` is. Repro: "finding P5-1".

### P5-2. P1: Profiles never re-watch after a reconnect (CONFIRMED (test))

`features/traces/data/profiles.tsx:22-36` (`useProfiles`) keys on Host + session only; compare `data/hooks.tsx:115-132` (`useTraces`, with the epoch generation and the away guard TF3 added for RT3 finding 1). On a drop the tab shows the error instead of the last list (rule/remote-is-normal); on reconnect nothing resubscribes. The same applies to `useProfile` and the Profiles count. Fix: the same `useConnectionOf` epoch and away guard. Repros: "finding P5-2" (two tests).

### P5-3. P2: Restart state isn't keyed by target (CONFIRMED (test))

`ui/profiles/RestartButton.tsx:46`, `:55-63`, `:82-93`. A refusal ("Polaris didn't start this process") stays under the button after the target changes, e.g. under "Restart ledger-tests with profiling", never tried. The tab switch unmounts `ProfileList`, forgetting an in-flight restart, so the button returns enabled and a second restart can be sent. Fix: keep restart state in the per-session profile store keyed by `service:pid`. Repros: "finding P5-3" (two tests).

### P5-4. P2: The user's restart is credited to the agent (CONFIRMED (test, fixture))

`model/profile/labels.ts:20-21`, `:29`: `byAgent = profile.turn !== null`. A user restart during a Turn, or of an agent-launched service (P2's launch Turn), carries a Turn. Fix: an optional `requestedBy: "user" | "agent"` on `Profile` next to `origin`, or drop "by …". Repro: "finding P5-4".

### P5-5. P2: "Record it again" while recording (CONFIRMED (test, fixture))

`ui/profile/ProfilePanel.tsx:224`, `:277-284`. After a restart the new Profile is selected and `profiles.get` runs before any `.cpuprofile` exists (`path: null until an artifact exists`), so it reads "recording · 0 ms so far · This recording has no profile to read · Record it again". Also `version` is in `useProfile`'s key, so each status or duration change drops the chart to "Reading the profile…". Fix: don't `get` while `status === "recording"`; pass `version` as the generation. Repro: "finding P5-5".

### P5-6. P2: Keyboard selection off-screen (CONFIRMED (test))

`ui/profile/FlameChart.tsx:211-217` scrolls only vertically. From 11,700–12,400 ms, ArrowDown then ArrowLeft selects a GC frame at 11,412 ms, outside the window; the header names it, the canvas doesn't show it. Fix: pan the window to the frame. Repro: "finding P5-6".

### P5-7. P2: The flame chart is silent to screen readers (CONFIRMED (test))

`FlameChart.tsx:261-277` (`role="application"` with only an `aria-label`), `ProfilePanel.tsx:116-144`. Arrow keys walk frames but nothing is announced. Fix: a visually hidden `aria-live="polite"` line ("fetchRate · fx.ts:23 · 670 ms · level 4"). Repro: "finding P5-7".

### P5-8. P2: Stale canvas colours under the System theme (CONFIRMED (code))

`FlameChart.tsx:57`, `:70`, `:83-85`; `flameDraw.ts:34-51`. The palette resets only when the `theme` setting changes; with "system", a macOS appearance switch keeps the old greys and label colour until the Profile is reopened. `features/diffs/useThemeType.ts:5` already listens to `prefers-color-scheme`. No repro: happy-dom doesn't resolve `color-mix`/`var()`.

### P5-9. P2: Restart with profiling while away, with no consequence stated (CONFIRMED (test))

`RestartButton.tsx:67-81`. The button is enabled while Reconnecting, and a click fails as if refused (rule/remote-is-normal: destructive actions wait for Connected). Nothing says the running process (pid only in the tooltip) is stopped and started again, dropping in-flight requests (rule/destructive-names-object). Fix: disable unless connected; a one-line consequence ("Stops pid 47118 and starts it again with profiling") or a confirm popover. Repro: "finding P5-9" (the away part).

### P5-12. P2: "Update it in Settings → Hosts" can't help (CONFIRMED (code))

`ui/profiles/ProfileList.tsx:127-128`, `model/availability.ts:22-25`. No Daemon advertises `traces.profiles` (`serve.ts:236-250`; `handlers.ts:479-482`). If P5 ships before P4, every user sees an action that does nothing. Fix: hide the Traces | Profiles switch until P4 lands, or drop the upgrade instruction; track on the release.

### P5-10 and P5-11. P3

- **P5-10 (CONFIRMED (test))**: `FlameChart.tsx:136`, `:165`, `:242` clamp to `layout.endMs` while "whole" is `max(endMs, durationMs)` (`ProfilePanel.tsx:175-178`). On the ledger profile, any drag of the whole view gives `from = -90`, and Escape's `zoomedIn` then miscounts. Use one total and clamp `panned` to `from >= 0`.
- **P5-11 (CONFIRMED (test))**: `ProfilePanel.tsx:88-94`, `TraceBar.tsx:45-49`, `routes/commands.ts:267-270` (last registration wins). Any re-registration of the trace bar's ⌘L (the open trace growing, likely while recording) takes ⌘L back while focus is in the flame chart. Make the trace bar defer while a profile-focused flag is set.

Verified true: the desktop contract spreads the protocol's `GetProfile` / `RestartWithProfiling` / `WatchProfiles` fields and returns `ProfileDetail` / `Profile` / `ProfilesSnapshot` unchanged (`origin` and `service` are `optionalKey`); `ProfileError` keeps code, message and fix over IPC; gating is right both ways; click selects, double-click / Enter / the pill opens in the Editor; the overlap uses exact nanoseconds; one culled canvas whose hit-testing matches its drawing and scales with `devicePixelRatio`; durations use TF3's `durationLabel`. The 50,000-node sweep reproduced (see [Screenshots](#screenshots)).

## P10: Settings → Traces, Set up tracing, the fixed-exporter card

### P10-1. P1: The one-line change reads a variable Polaris never sets (CONFIRMED (test, run))

Also found from the skill's side (P7-1).

Locations: `apps/desktop/src/renderer/features/traces/model/setup.ts:83-84` (`FIXED_EXPORTER_CHANGE`), used by `model/agentSetup.ts:29-30` (the agent prompt), `ui/setup/FixedExporterCard.tsx:74` and `ui/setup/TracesSetup.tsx:61`. Compare `apps/daemon/src/traces/runtime.ts:109`, `:151` and `skills/polaris-tracing/SKILL.md:47-55`.

What happens:
- The line is `url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? existingVendorUrl,`. The Daemon injects only `OTEL_EXPORTER_OTLP_ENDPOINT` (a base needing `/v1/traces`), so under Polaris it always falls back to the vendor.
- The prompt says "as the polaris-tracing skill's fixed-exporter line does", but the skill's line handles the base variable: two conflicting instructions. "Ask an agent" doesn't install the skill, so the shown line may be all the agent has.
- The agent applies it, runs the app, and the traces tool answers E-TRACE-NONE.
- ADR 0094 also says to read `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`.
- The card's lead adds "keeps Axiom getting everything; Polaris forwards to it", which isn't true until ENG-674 (P7-2). Crop: `p10-fixed-exporter-card-midnight-calm.png`.

Evidence: `setup.test.tsx`, "finding P10-1" (evaluates the line with `OTEL_EXPORTER_OTLP_ENDPOINT` set: the Axiom URL). `p7/fixed-exporter-runs.txt`: `skill: exported to …/otlp/tok_review/v1/traces`, `desktop: exported to …/otlp/vendor/v1/traces`.

Smallest fix: make the line the skill's expression (TRACES ?? base + `/v1/traces` ?? vendor), ideally from one constant the prompt, the cards and the skill share; or have the prompt point at the skill and install it first. Fix the ADR sentence.

### P10-2. P2: "errors always" is false (CONFIRMED (test))

`features/traces/settings/model.ts:150` (KEEP_LINE, hand-mirrored); `apps/daemon/src/traces/retention.ts:90-112`. 200 MB and 7 days are right. `pruneCheckout` removes every unpinned record past `maxAgeMs`, errors included, and drops errors once a checkout is over twice its budget (RT1's "bounded pressure allowance, never an age exemption"). Fix: "200 MB · 7 days" (or say what's true), derived from a shared constant. Repro: `keep.test.ts`, an 8-day-old error span pruned under `DEFAULT_RETENTION`.

### P10-3. P2: Stuck on "Installing…" after a drop (CONFIRMED (test))

`features/review/checkout/exit.ts:35-36`; `ui/setup/actions.ts:28-31`, `:77`; `main/ipc/feeds.ts:49-55`. `followExit` settles only on an Exit item or an `end` with NotFound; any other `end` (including a drop) never resolves, so `busy` stays true and, if the install finishes on the Host, the agent never starts. Fix: treat any `end` as stopped ("The install stopped before it finished", Try again), or resubscribe on reconnect. Repro: "finding P10-3" (two cases).

### P10-4. P2: Skill installed for two Harnesses, agent started on any (CONFIRMED (test) / PLAUSIBLE)

`model/agentSetup.ts:11-19` (`-a claude-code codex`), `ui/setup/actions.ts:43` (copies `session.harness`), `packages/protocol/src/harnesses.ts:81-118`. On OpenCode, Gemini CLI or Copilot sessions the agent is told to use a skill it may not have. Fix: build `-a` from the Harness, or start the setup agent on Claude Code / Codex. The skills-CLI agent ids in the test are an assumption; whether those Harnesses read the claude-code / codex directories is PLAUSIBLE.

### P10-5 to P10-11. P3

- **P10-5 (CONFIRMED (test))**: `settings/hooks.tsx:68-73`: a refusal restores the whole object captured before the save, wiping a later accepted save from the UI. Re-read on refusal, or revert only the patch's own keys.
- **P10-6 (CONFIRMED (test))**: `settings/ui/TracesPage.tsx:88-112`: once `picked` names a removed Workspace, the card reads "No workspaces yet" beside listed ones. Apply the `options.some(…)` fallback to `picked`.
- **P10-7 (CONFIRMED (test))**: `settings/model.ts:103`, `TracesSettingsCard.tsx:53-56`: the protocol accepts `forwardTo: null`, but an emptied field is only "Enter the collector's URL". Treat an emptied field as clearing it, or add Remove.
- **P10-8 (CONFIRMED (code))**: `ui/setup/TracesSetup.tsx:89-93`, `apps/daemon/src/traces/runtime.ts:99-109`: when the user exports their own endpoint the Daemon injects nothing, yet the card says "Polaris forwards to it" and replaced the accurate "This app sends its traces elsewhere". P10's own test locks it in. Keep the elsewhere note there.
- **P10-9 (CONFIRMED (code))**: `TracesSettingsCard.tsx:60-77`, `packages/ui/src/components/polaris/settings/rows.tsx:41`, `:58-59`: the reason sits in a one-line `truncate` caption with no `aria-describedby` or live region. Point `aria-describedby` at it and let it wrap.
- **P10-10 (CONFIRMED (code))**: `model/agentSetup.ts:44-48` vs `features/session/model/intent.ts:56-75`: a Starting session (e.g. Dormant resuming) gets a new StartSession in the same checkout, two agents in one in-place checkout; the composer waits instead. Treat Starting like idle, or derive from `composerMode`.
- **P10-11 (PLAUSIBLE)**: `model/agentSetup.ts:35-38`, `apps/daemon/src/engine/decider.ts:274-286`: a ReviewCheckout placement (`worktreeId: null`, `cwd = checkout.path`) maps to InPlace, the Workspace root, not the checkout Traces showed. Unconfirmed whether a Reviewer session can be the shown one.

Verified true: settings shapes come from the protocol schemas; the forward URL check is `Schema.is(TraceForwardUrl)` after a trim (uppercase scheme, IPv6, `http://a@b`, percent-encoded userinfo, `javascript:`, whitespace all behave as the Daemon would); header values never reach the UI, the prompt or IPC; the card shows only `fixed-url` and `axiom`; the deep link is StrictMode-safe; routing by Session State is a read, not a lifecycle change (AGENTS.md's state-machine rule holds), and needs-you gets a new session as DESIGN says; exit codes are read from the Exit item; `busy` prevents double installs; StartSession copies Harness, permission mode, model, effort and placement.

## P7: the polaris-tracing skill

### P7-2. P1: "Polaris forwards to the vendor" isn't true yet (CONFIRMED (code))

Locations: `skills/polaris-tracing/SKILL.md:10`, `:57`, `:59`; `references/existing-exporters.md:3`, `:13`; `apps/daemon/src/traces/README.md:121` (forwarding is ENG-674/675); `handlers.ts:477-478`. ENG-674 is In Progress.

What happens: the skill justifies one exporter per process and "the vendor keeps getting every span once" by forwarding. At HEAD, after the fixed-exporter line, every span from a Polaris-launched command goes to Polaris only, and the project's dev dataset (Axiom, Honeycomb) silently stops getting them, while the agent tells the user nothing is lost. Production is unaffected unless it sets the variable.

The Desktop's fixed-exporter card makes the same claim (`apps/desktop/src/renderer/features/traces/settings/model.ts:78`, "Polaris forwards to it"; see the P10 crop).

Smallest fix: until ENG-674 lands, in the skill and the card, say that under Polaris the fixed exporter sends to Polaris instead of the vendor and the user must accept that; drop "passes them on when it forwards". Restore it with forwarding.

### P7-3. P2: The shutdown handler overrides the app's (CONFIRMED (run))

`references/node.md:48-50`, `references/bun.md:47-52`.
- With the endpoint set, the handler's `process.exit(0)` cuts an app's own graceful shutdown short: "drained" never prints and exit 3 becomes 0, on both runtimes.
- If the app's handler exits first, every batched span and log is lost.
- The receiver allows one request in flight per token (`receiver.ts:140`); traces and logs flush together at shutdown, so one gets 429 and arrives only on the retry about 1 s later. On Bun with a prompt exit that was every span, including the ERROR span step 7 checks.

Evidence: `p7/node-runs.txt`, `p7/bun-runs.txt` (`POST …/v1/traces -> 429 (token busy)`, `== spans (none)`).

Smallest fix: install the handler only when the app has none, or tell the agent to call `sdk.shutdown()` from the app's existing handler; never force exit 0. Separately (T1): allow one traces and one logs request per token at once.

### P7-4. P2: Misleading E-TRACE-NONE diagnosis (CONFIRMED (code))

`SKILL.md:38-41`; `apps/daemon/src/mcp/sessions/traces.ts:28-61`; `traces/queries.ts:62`; `traces/runtime.ts:99-104`.
- "Empty means … or the user exported their own endpoint": in that case the echo prints the user's URL, not an empty string.
- The echoed value is the base `/otlp/<token>`, which an agent compares with `/otlp/<token>/v1/traces` and concludes is wrong.
- "Spans from a process started in an earlier Turn need `turn: "all"`" is wrong: Turns are attributed by span start. What hides traces is a server started outside this session, whose spans carry `turn = null` or another session's Turn. The tool then says "Turn N · 0 traces", not E-TRACE-NONE, and the skill doesn't cover it.
- No mention of the 5 s `BatchSpanProcessor` delay: `traces` right after `curl` shows nothing.

Fix: rewrite the bullets (empty = not launched by Polaris; a non-`127.0.0.1:4319/otlp/…` value = the user's endpoint suppressed injection; wait about 6 s; on 0 traces retry with `turn: "all"`).

### P7-5. P2: No Next.js recipe (CONFIRMED (code))

`SKILL.md:17` sends Next.js down "No telemetry, Node"; `references/node.md:17-34` writes a root `instrumentation.ts` with `NodeSDK` and `node:module`, which Next loads itself in both Node and edge runtimes expecting `register()`. The redirect to `@vercel/otel` is the last table row, after the file is written, and existing-exporters.md covers only projects that already have it. Fix: a Next.js branch with `@vercel/otel@2`, `export function register() { registerOTel({ serviceName }) }`, and its 2.x peers. A Next build wasn't run.

### P7-6. P2: The helper breaks in CommonJS (CONFIRMED (run))

`references/tracing-helper.md:14` uses `fileURLToPath(import.meta.url)`; `node.md:66` says CJS is supported. tsc `--module commonjs` gives TS1343; `require("./tracing.ts")` in a `"type": "commonjs"` package throws SyntaxError on Node 24.22.1 (`p7/misc-checks.txt`). Fix: say "use `__filename`" in the CJS row, or drop the helper check for `Error.captureStackTrace(holder, traced)`.

### P7-7. P2: Two setups touch production (CONFIRMED (run))

`SKILL.md:10` promises production keeps behaving as today.
- `references/bun.md:56`: a top-level bunfig `preload` runs for every `bun <file>` in that directory, including a production start; where production sets `OTEL_EXPORTER_OTLP_ENDPOINT` (a collector sidecar), the SDK and P7-3's exit-0 handler run in production.
- `references/existing-exporters.md:9`, `:19`: the log exporter added on the `@vercel/otel` and Axiom branches isn't gated, so with no variable set it posts to `http://localhost:4318/v1/logs` (`p7/misc-checks.txt`: `4318 got /v1/logs`).

Fix: prefer `--preload` in the dev script; gate the log processor on the endpoint variable.

### P7-8. P2: Plain-path stacks redacted by file name (CONFIRMED (run))

`apps/daemon/src/traces/redact.ts:47`, `:62-67`; `SKILL.md:28`, `:36`. TF1 fixed Node ESM (`file://` frames survive). Plain-path frames (Bun, Node CJS) still match the `key: value` rule: `session.ts:40:3` reads as an assignment and the whole stack becomes "[redacted]" (`p7/redact-stacks.txt`: `bun, src/auth.ts -> "[redacted]"`). It fails the skill's step 7 check. The owner is redaction (T1/TF1). `docs/research/traces-otlp.md:199-201` now states the opposite of the truth. Fix: don't treat `<word>.<ext>:<digits>` as an assignment; update the research note.

### P7-9 to P7-11. P3

- **P7-9 (CONFIRMED (run))**: `references/bun.md:60-64` says to add a block to the helper that imports `recordFailure` from the helper itself: `"recordFailure" has already been declared`. Say "save this as `src/http.ts`".
- **P7-10 (CONFIRMED (run))**: `bun.md:107`: the route fallback returns `pathname`, producing a server span `GET /orders/42` against the skill's own rule; `traced` around outgoing `fetch` makes no CLIENT span and injects no `traceparent`, so a Bun service's calls start new traces and the Service map can't link them. Default to `"unmatched"`; add a small outgoing wrapper.
- **P7-11 (CONFIRMED (run/code))**:
  - `node.md:3` "runs exactly as before": with no endpoint the static imports still cost 0.2–0.5 s and about 70 MB RSS (47.6 → 121 MB). Use `await import()` inside the gate.
  - `bun.md:56`: a top-level `preload` doesn't apply to `bun test` on Bun 1.4.4; `[test] preload` is needed.
  - Plain `node:http` server spans are all named `GET`, so `traces {route}` and compare lump routes together; say to set `http.route`.
  - The receiver refuses `content-encoding` (415, `receiver.ts:135-137`); no warning about `compression: gzip` on a fixed exporter.
  - `SKILL.md:19` "nothing else" conflicts with steps 3–7 and existing-exporters.md:9.
  - `SKILL.md:39` echoes the raw session token into tool output (low risk; E-TRACE-NONE already prints it).
  - The install fetches `luxdotdev/polaris` main, unpinned: it fails today ("No matching skills found", `p7/skills-add-from-github.txt`) and after merge users get main's skill whatever their Daemon version.
  - On the "configured from the environment" branch, metrics 404 at `/v1/metrics`; say `OTEL_METRICS_EXPORTER=none`.

Verified true at HEAD: the `traces` / `trace` / `span` MCP tools and E-TRACE-NONE match the skill; the endpoint is injected as the base `http://127.0.0.1:4319/otlp/<token>` and suppressed when the user set either variable; the receiver serves only `/v1/traces` and `/v1/logs`, and `metricReaders: []` is needed (without it, three `/v1/metrics` posts in 0.4 s); nothing starts without the endpoint; the ESM loader hook is required; `code.*` lines are right on both runtimes (Bun's `return traced(…)` points at the caller's caller, as the skill warns); exceptions survive on Node ESM after TF1; README, SKILL.md and the Desktop's `INSTALL_COMMAND` agree. Versions: Node 24.22.1, Bun 1.4.4, TypeScript 7.0.2, `@opentelemetry/api` 1.10.0, `sdk-node` 0.300.0, `sdk-trace` / `sdk-logs` 3.0.0, `@vercel/otel` 2.2.0 (inspected).

## Screenshots

All through scriptedElectron (SX), in one `lease bench` command, from a fresh `bun run build` of this base, at the scripts' 1440×900 window. Full sets are in `/tmp/rpu` on this Mac (not committed): Service map 20 PNGs (3 themes × 3 densities plus overdue, failing-test, errors-only and mesh), Profiles 14, Review traces 37, Traces states 36 (empty, user-exported, fixed-exporter, fixed-exporter-user-exported, settings-traces, settings-traces-fresh × 2 themes × 3 densities).

The Daemon was untouched: `~/.polaris/daemon.pid` 10276 and `~/.polaris/bin/current` 0.7.0 before the build, between the map and Profiles runs, and after the last script.

Committed crops:
- `p6-bottom-row-map-midnight-calm.png`, `p6-bottom-row-map-light-compact.png` (P6-1): the default settlement map opens with `redis` and `api.postmarkapp.com` cut off under the foot; only their names, kinds and "1 ERROR" show, and the art's top edge. The same in every theme and density, since density doesn't change the map's canvas. Fragments of the clipped art also show below the foot's bottom border. The foot also reads "Started by the agent" for a run with `launchedTurn: null` (P6-8).
- `p8u-route-timings-fixture-dark-calm.png` (P8U-1): the preview's Route timings shows rows the real Daemon can't produce: "test overdue-totals 1.4 s → 3.1 s · 2 → 3 runs · 2.2× slower", "38 ms no baseline · 3 runs" (fine), and "POST /invoices/import 1.9 s → not run · 1 → 0 runs". Against `compareQuery.ts` the first and last read "–".
- `p10-fixed-exporter-card-midnight-calm.png` (P10-1, P7-2): the card says "Reading the endpoint from the environment keeps Axiom getting everything; Polaris forwards to it", then offers the line that reads only `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. Both halves are false at HEAD.

Performance re-measured in the same run, matching the claims: the 10k-span, 30-service map opens in 39.4 ms (claimed 26.4 ms, at a higher load) and zoom / pan median 5.5 / 5.6 ms, max 7.0 ms, 0 long frames; the 50,000-node flame chart sweep median 5.6 ms, max 7.0 ms, 0 long frames, draw max 0.2 ms, reopen 22.8 ms.

I looked at the map (midnight calm, light compact), the fixed-exporter state (midnight calm) and Route timings (dark calm).

## Checks run

All heavy work ran as one command, `bun apps/daemon/src/main.ts lease bench -- /bin/sh /tmp/rpu/shots.sh`, admitted at 22:47:13 UTC (load 16.4) and done at 22:50:44 UTC (load 4.6):

| Step | Result |
|---|---|
| `bun run build` (apps/desktop) | exit 0 |
| `node scripts/tracesServiceMapScreens.ts /tmp/rpu/map` | exit 0 |
| `node scripts/tracesProfileScreens.ts /tmp/rpu/profiles` | exit 0 |
| `node scripts/reviewTracesScreens.ts --out /tmp/rpu/review` | exit 0 |
| `node scripts/tracesStatesScreens.ts /tmp/rpu/states --only …` | exit 0 |
| `bun test ../../docs/reviews/2026-10-31-traces-RPU` (apps/desktop) | 0 pass, 39 fail, 8 files: every repro fails, as intended |

The P7 runs (Node and Bun scratch apps, the stand-in receiver, the CJS and bunfig checks) ran in `/tmp/rpu-p7` outside the lease; they're small single processes. Their scripts and outputs are in `p7/`.

No product code changed, so no repository typecheck, test or lint run was needed beyond the repros. `docs/` is outside oxfmt and the lint ratchet.

## Not checked

- No live Daemon end to end: `traces.settings` and `traces.profiles` aren't served, so P5 and P10 ran on fixtures; P8U's daemon-fit tests use the real `TraceStore` and compare in process, not over the socket.
- No real MCP round trip for the skill; the receiver's 429 is emulated from `receiver.ts`.
- No Next.js build, Deno or Workers; the 2.x-line instructions weren't run end to end.
- Whether OpenCode, Gemini CLI or Copilot sessions can see a skill installed for claude-code and codex.
- Trackpad pinch and horizontal scroll on the map, `devicePixelRatio` changes without a resize on the flame chart, and the System-theme switch (P5-8), all beyond happy-dom.
- Real screen readers.
