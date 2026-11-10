# Visualization sandbox review (ENG-594)

R1 reviewed integration base `685523b8171e3f2126fd7c853e24fd0fb3d95483`, including
F1, A1, W1 and M1. This is a review with fixes and explicitly tracked gaps, not a claim
that arbitrary JavaScript is harmless or that all engines have been verified.

## Findings and changes

### High: Desktop's WebRTC policy still allowed TURN over TCP — fixed

`disable_non_proxied_udp` does what its name says. With the real frame builder and
bootstrap, a parser-created closed declarative shadow root can hide a `srcdoc` child
from the MutationObserver. That child has a fresh WebRTC constructor. Three such
children sent **420 TCP bytes** to a local TURN listener despite the IP policy and
permission handlers; UDP stayed at zero. The literal fragment is rejected by
validation. This is a confirmed host-boundary bypass on unvalidated content, not a
demonstrated validator-accepted end-to-end exfiltration exploit.

The Desktop preload now runs in every frame, including these children, and synchronously
uses `contextBridge.executeInMainWorld` to make `RTCPeerConnection`, its WebKit alias
and `RTCDataChannel` undefined and non-configurable before page scripts. Only the main
frame installs the Polaris API or its IPC listeners. `sandbox`, `contextIsolation` and
`webSecurity` stay on; `nodeIntegration` stays off. `nodeIntegrationInSubFrames` enables
the sandboxed preload, not a Node API in the page. The engine probe verifies that
`require`, `process` and `polaris` are absent in the child, while the main frame retains
the Polaris API. No Desktop feature uses WebRTC (search of `apps/desktop/src`).

The regression harness bundles the actual `createMainWindow`, `frameResponse` and
preload. With the fix, the child script runs but constructing WebRTC throws, and the
listeners receive **0 TCP bytes and 0 UDP packets**. `PV_NEGATIVE_CONTROL=1` replaces
only the preload lockdown with a no-op: the test fails and records the 420 TCP bytes.
The test never treats an unloaded or crashed frame as a successful block.

Alternatives were checked in the Lead's requested order. A frame-only
`Connection-Allowlist: ()` header in Electron 44.9.3 produced a renderer termination
(`network.mojom.MdnsResponder`, bad IPC reason 123), including with
`ConnectionAllowlists` enabled. It is not shipped as a fix. No documented complete
WebRTC-off switch was found in the current Electron/Chromium API; the IP policy
explicitly permits TCP. The tested preload avoids a separate WebContents per card.
`executeInMainWorld` is experimental in Electron's types, so this regression probe
must accompany Electron upgrades.

References: [Electron IP policy](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwebrtciphandlingpolicypolicy),
[context bridge](https://www.electronjs.org/docs/latest/api/context-bridge),
[Chromium connection allowlists](https://developer.chrome.com/blog/connection-allowlist-announcement).
No upstream code was copied.

### Shared guard bypasses — narrowed, not made a security boundary

The bootstrap captures `Reflect.apply`, `Object.defineProperty`, WeakSet membership
operations, observer registration, selector/removal methods and node/shadow getters.
It uses plain loops instead of mutable `forEach` methods. `attachShadow` forces
`clonable` and `serializable` false. The original `attachShadow` cannot be stolen by
replacing `Function.prototype.apply`.

Four tests in `frame/guard.test.ts` fail against the base bootstrap and pass with the
fix: WeakSet poisoning, Function.apply interception, Element.remove poisoning and
cloning a closed shadow tree. A Chrome probe also checks an overridden `nodeType`
getter and fails when only the captured getter is replaced by a live property read.
The existing browser checks still pass. Removal remains asynchronous;
parser-created closed roots and broader accessor poisoning are not solved by this
guard. Synchronous insertion guards and a complete adversarial accessor matrix remain
[ENG-633](https://linear.app/luxdev/issue/ENG-633).

### Frame response sandbox — strengthened

The response CSP now includes `sandbox allow-scripts`, in addition to the iframe
attribute. Chrome verifies an opaque origin even when the embedding iframe omits its
sandbox attribute. The app CSP still permits only `app://polaris/frame/` frames;
its script policy was not loosened. Frame URLs remain excluded from trusted IPC URLs.

### Availability and platform coverage — open

[ENG-634](https://linear.app/luxdev/issue/ENG-634) tracks unrestricted message parsing,
height/confirmation floods, oversized transient state allocations, and Mobile's
unbounded total state files/writer map. These are resource-exhaustion risks; this
review did not find a message route from a Visualization to an agent.

[ENG-635](https://linear.app/luxdev/issue/ENG-635) tracks CI, generated fuzzing, raw
DNS observation, and fresh iOS/Android engine checks. [ENG-636](https://linear.app/luxdev/issue/ENG-636)
tracks controlled memory measurement against the product budget. All four follow-ups
are linked to ENG-594 and the Polaris 0.7.0 release.

## Vector matrix

**Engine** means exercised in this review. **Reasoned** means code/contract inspection
and, where named, unit tests. **Reported** means a dependency Claim's evidence, not
new R1 verification. Chrome is 156.0.8078.79; Electron is 44.9.3 / Chromium 152.0.7977.167.

| Vector | Result and evidence |
| --- | --- |
| Encoded URLs | **Engine, Chrome:** an entity-encoded `http:` URL passes the scanner but the image request is blocked. Validation is advisory, not confinement. |
| `srcset` | **Engine, Chrome:** external candidates rejected by validation and blocked by CSP at runtime. |
| CSS `url()` / `@import` | **Engine, Chrome:** plain import and escaped `u\72l` background URL cannot load. |
| Font exfiltration | **Engine, Chrome:** applied external `@font-face` is blocked by `font-src`; only data fonts are allowed. |
| SVG `href` / `xlink:href` | **Engine, Chrome:** external image/use references produce no HTTP request. |
| `<meta refresh>` | **Engine:** Chrome CSP alone permits a self-navigation request (local positive probe). The actual Electron window handler refuses it before any request reaches the listener. |
| `<base>` | **Engine, Chrome:** rejected by validation; `base-uri 'none'` blocks it. |
| `<form>` | **Engine, Chrome:** explicit submit cannot send a request; the sandbox blocks forms before CSP evaluation. `form-action 'none'` is an additional policy restriction. |
| `<a target=_blank>` / `javascript:` | **Engine, Chrome:** sandbox blocks JavaScript and entity-encoded external popup attempts. Same-frame JavaScript is intentionally allowed; it has the frame's authority. |
| Dynamic script `.src` | **Engine, Chrome:** concatenated property assignment bypasses the scanner; CSP blocks the script load. |
| `new Image().src` | **Engine, Chrome:** concatenated property assignment bypasses the scanner; CSP blocks the image load. |
| `sendBeacon`, `fetch`, WebSocket, EventSource | **Engine, Chrome:** concatenated API names bypass the scanner; runtime requests are blocked by CSP. The probe checks its API attempts reached the end and observes resource-policy violations. |
| Prefetch/preconnect/DNS-prefetch | **Engine, Chrome:** no HTTP hit from the hint corpus; a separate TCP listener accepts no preconnect connection. **Reasoned/coverage gap:** DNS queries are not observed; raw DNS verification is ENG-635. |
| Blob Worker | **Engine, Chrome:** constructor can return before a CSP error; no worker script runs. The first version of the probe incorrectly treated constructor return as execution. |
| SharedWorker / ServiceWorker | **Engine, Chrome:** construction/registration denied in the opaque frame. **Reasoned for Mobile**, pending ENG-635. |
| `eval` / `Function` | **Engine, Chrome:** both throw under the script policy. |
| WebRTC / hidden `srcdoc` child | **Engine:** Chrome still sends TCP and UDP with `webrtc 'block'`, `frame-src 'none'` and the bootstrap active. Desktop's new per-frame preload blocks both transports. |
| Synchronous `about:blank` child | **Engine, Chrome:** reading its document throws `SecurityError` before observer removal. **Reasoned for WKWebView**, pending ENG-635. |
| `parent` / `top` access | **Engine, Chrome and real Desktop App:** document access denied; the frame cannot read the app bridge. |
| Foreign-frame postMessage | **Engine, real Desktop App:** foreign source ignored. **Reasoned, Mobile:** each WebView has its own native callback; nested realms have no agent API. Source-schema and no-forwarding checks remain the app boundary. |
| `pv:open-link` without activation | **Reasoned:** accepted as a request, never an automatic open. Desktop calls `shell.openExternal` only from the confirmation button; Mobile calls `Linking.openURL` only for confirmation index 0. Both require https. Repeated requests can annoy/flood: ENG-634. |
| Huge `pv:state` | **Reasoned + store tests:** Desktop caps persisted values at 16 KiB and total at 512 KiB; Mobile caps each at 64 KiB; both coalesce writes over 500 ms. Parsing/serialization happens before those caps; oversized transient allocations and Mobile total storage remain ENG-634. |
| Height flood | **Reasoned + message tests:** finite heights clamped, but no host rate limit; ENG-634. Frame-side rAF throttling is not a hostile-code boundary. |
| Theme-token injection | **Reasoned + token/document tests:** allowed names only; length cap; `<>{};` refused; initial title/state escaped. Live values use `style.setProperty`, not HTML. A URL in a value cannot bypass resource CSP. Fake host messages cannot give the frame more than its own existing authority. |
| App CSP / Electron settings | **Engine + review:** app script policy unchanged; frame URL remains untrusted for IPC. Response adds sandbox. All-frame preload preserves context isolation, OS sandbox and disabled Node integration; child page has no Node or Polaris globals. |
| Persistent/two-way channel to the agent | **Reasoned + real-app smoke:** handlers are limited to height, confirmed link and device-local state. No handler forwards frame input into a Turn or Daemon state. User-confirmed external links intentionally leave the sandbox. |

The HTTP listener observes resource requests, not every network packet. The separate
local TCP and UDP listeners observe the selected TURN/STUN probes. No claim is made
that this fixed corpus exhausts JavaScript, browser-engine or operating-system channels.

## F1 handoff disposition

| Item | Disposition |
| --- | --- |
| 1. Host WebRTC block; closed declarative roots | **Fixed on Desktop**, tested with TCP as well as UDP. Validator rejection of literal `shadowrootmode` has a dedicated existing test. Mobile all-frame document-start removal and denied child navigation are **Reported** from M1; native WebRTC disable beyond injection is not claimed. Fresh verification: ENG-635. |
| 2. CSP does not govern WebRTC/srcdoc | **Verified in Chrome:** hidden child sends 112 TCP bytes and 4 UDP packets despite `webrtc 'block'`. WKWebView recheck filed in ENG-635. |
| 3. Synchronous insertion guards | **Filed, ENG-633.** Host lockdown is the containment boundary; the in-page observer remains best effort. |
| 4. Synchronous about:blank SecurityError | **Verified in Chrome.** WKWebView case filed in ENG-635. |
| 5. Browser check in CI | **Filed, ENG-635.** Both engine scripts still run manually. |
| 6. Generated validator-accepted fuzzing | **Filed, ENG-635.** This change adds a reproducible fixed corpus, not a fuzz campaign. |
| 7. Worker families on each platform | **Verified in Chrome** after correcting asynchronous Worker detection. WKWebView/Android filed in ENG-635. |
| 8. State caps/rate; link confirmation | **Resolved existing controls by review/tests; residual gaps filed, ENG-634.** Confirmed links cannot silently open; parsing/height/total Mobile bounds remain. |
| 9. Clonable closed shadows | **Fixed:** forced non-clonable/non-serializable roots; failing-first regression. |
| 10. Prototype poisoning | **Fixed for listed live methods**, with captured calls and plain loops; node/shadow getters also captured. Comprehensive tamper resistance is not claimed; remaining accessor/insertion work is ENG-633. |
| 11. Original attachShadow stolen through apply | **Fixed:** captured `Reflect.apply`; failing-first regression. |

## Reproduction and limits

From the repository root, with local sockets permitted and Google Chrome installed:

```sh
bun packages/visualization/scripts/security-check.ts
PV_NEGATIVE_CONTROL=1 bun packages/visualization/scripts/security-check.ts
bun packages/visualization/scripts/browser-check.ts
env -u ELECTRON_RUN_AS_NODE bun apps/desktop/scripts/visualizationScreens.ts --out /tmp/pv-r1 --build
```

The negative-control command must fail its Desktop WebRTC assertion. The security
script clears `ELECTRON_RUN_AS_NODE` for its Electron child. Its Chrome WebRTC check is
an intentional local negative control showing why CSP is insufficient.

Validation: 137 shared-package tests; 3,215 Desktop tests; both package typechecks;
changed-file quality checks; security corpus 14/14; existing Chrome check 17/17;
real-app check 14/14. Removing the response sandbox also fails its response test.
The first Desktop suite run had 17 local-socket failures under the tool sandbox; the
same suite passed with socket access. No production dependencies changed.

No fresh iOS engine run was performed. CoreSimulator access required escalation;
there was no booted simulator. M1's iOS 27 simulator evidence (CSP, STUN positive control,
closed-root navigation refusal, state and confirmation) remains **Reported** only.
Android is unverified. Unit tests over happy-dom are not CSP or native-engine proof.

## Performance check

The existing real-app 30-Visualization scroll check ran against the original committed
code and then the fixed code, using separate builds and fresh test homes. Both passed
all 14 checks, retained at most three live frames while scrolling and two at rest, and
used five Electron processes. No extra WebContents-per-card design was introduced.

| Measurement | Original `685523b8` | Fixed |
| --- | --- | --- |
| p50 frame time | 5.6 ms | 5.6 ms |
| p95 | 6.3 ms | 6.4 ms |
| p99 | 11.0 ms | 6.9 ms |
| Frames over 8.33 ms | 1.13% | 0.37% |
| Working set without Visualizations | 1,053 MB | 1,040 MB |
| Working set after scrolling 30 | 1,153 MB | 1,118 MB |

These are summed Electron working sets in a dev app, not physical-footprint values or
a committed machine baseline. An earlier fixed run was 746→940 MB; W1 reported
534→516 MB. The variation does not establish a preload regression, but the latest
original and fixed runs both exceed the product's memory target. ENG-636 records the
budget discrepancy and the need for controlled release-build measurements.

### Physical footprint on a built app (ENG-636, 2026-11-09)

`apps/desktop/scripts/visualizationScreens.ts` now samples the peak physical footprint
(`scripts/lib/sampleTree.ts`, 3 s at 200 ms) of the Electron tree and of the throwaway
Daemon, as `budgets.ts` does, beside the old summed working set. Three runs on a Mac14,13
(32 GB), on `out/` from `bun scripts/build.ts --no-app` (Vite production renderer) at
`a4a35cea6`, Electron launched with `--use-mock-keychain` against a `/tmp` Daemon on the
bench Harness. All 14 checks passed in every run.

| Run | App, `polaris` scene | Daemon | Total | App, after scrolling 30 | Daemon | Total | Working set, before → after |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 857 MiB | 74 MiB | 931 MiB | 745 MiB | 74 MiB | 819 MiB | 966 → 1,028 MB |
| 2 | 860 MiB | 77 MiB | 937 MiB | 766 MiB | 74 MiB | 840 MiB | 917 → 959 MB |
| 3 | 900 MiB | 64 MiB | 964 MiB | 857 MiB | 75 MiB | 932 MiB | 982 → 1,120 MB |

Frames: p95 6.1 ms in every run, at most 0.56% over 8.33 ms; two live frames at rest,
three while scrolling; five processes.

**Reconciled.** By physical footprint, the measure the Desktop budget (`budgets.ts`,
`< 1024 MiB`, app tree plus Daemon) is checked against, the app plus Daemon stays under
1 GB with and after 30 Visualizations: 819–932 MiB after the scroll, 931–964 MiB on
the busier `polaris` preview scene. The summed working sets above 1 GB counted shared
pages once per process, so they overstate the total and aren't the budget's measure.
The headroom is thin: run 3 came within 60 MiB of the line.

Limits: the "before" figure is the `polaris` preview scene, not the same 30-card scene
without its frames, so it isn't a Visualization-free baseline of that scene. The runs used
the dev bundle's Electron binary (`out/dev/Polaris Dev.app`) loading the production build,
not a signed, packaged `Polaris.app`. The Host was under heavy load from other agents
(load average 72–146); footprint is less sensitive to load than timing is. No committed
machine baseline is gated on these numbers.
