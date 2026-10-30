# The Browser's CDP facade

Agents drive a session's Browser over CDP (ADR 0092): agent-browser connects to the Daemon's per-session relay, the Daemon opens a `cdp` Browser stream to the Desktop App hosting the session, and this folder answers it (ENG-616). The tabs themselves belong to `../browser`; this folder reaches them through the `CdpTabs` port (`ports.ts`, `adapter.ts`).

## One stream, one facade

`hostBrowsers(sessions, deps)` runs on each Host that supports `browser.host` (`host.ts`): every `Open` the Daemon sends becomes a `cdpFacade` over that session's tabs, fed by the stream's bytes and writing its replies back, within the byte-stream credit window. Streams are known only to the connection that opened them. When the connection drops, every facade closes and detaches.

## What the agent sees

The facade is a browser-level endpoint over one session's tabs:

- `Browser.getVersion`, `Target.setDiscoverTargets`, `Target.getTargets`, `Target.getTargetInfo`, `Target.attachToTarget` (flatten only), `Target.detachFromTarget`, `Target.setAutoAttach`, `Target.activateTarget`, `Target.closeTarget`, and `Target.createTarget`, which opens a tab in the session's Browser `openedBy Agent`. Target ids are the Browser's tab ids; browser context id is `polaris:<sessionId>`.
- Every other method needs a `sessionId` from `attachToTarget` and goes to that tab's `webContents.debugger` (`hub.ts`), including the sessions Chromium opens under the tab (frames, workers). A browser-type target under a tab never routes.
- Another session's tab is no target: `No target with given id found`.

On a tab session, only an allowlist reaches Chromium (`refusals.ts`):

- Whole domains: Accessibility, Animation, Audits, Console, CSS, DOM, DOMDebugger, DOMSnapshot, Debugger, Emulation, Fetch, Input, Inspector, Log, Network, Overlay, Page, Performance, Profiler, Runtime, Security. These act on the tab's own frame tree; agent-browser's `core` tools use Runtime, DOM, Accessibility, Input, Page and Network.
- Mediated one by one: `Target.setAutoAttach` (the tab's frames and workers); `IO.read` and `IO.close` only for a stream this facade's tab handed out (`Fetch.takeResponseBodyAsStream`, `Network.takeResponseBodyForInterceptionAsStream`, `Page.printToPDF`), since IO handles are browser-wide; `IO.resolveBlob`; `Page.navigate` through the Browser's navigation policy (`allowedUrl`); `Browser.setDownloadBehavior` and `Page.setDownloadBehavior` only as `deny` or `default` without a path; `Input.dispatchDragEvent` without files.
- Refused inside the allowed domains, with code -32000: `DOM.setFileInputFiles`, `Page.setInterceptFileChooserDialog`, `Network.loadNetworkResource` (they read files on the Desktop App's machine or fetch on its behalf), and `Security.setIgnoreCertificateErrors`, `Security.setOverrideCertificateErrors`, `Security.handleCertificateError` (TLS checks stay on; Host addresses are trusted through their partition). `Network.getAllCookies` and `Network.clearBrowserCookies` stay: on a tab session they see and clear only the tab's partition (checked in the smoke against real Electron).
- Everything else is refused with code -32000: the Storage, ServiceWorker, Tracing, SystemInfo, Tethering, Memory, HeadlessExperimental, Extensions, PWA and Autofill domains (Storage's cookie methods without a `browserContextId` reach the default context, not the tab's partition), the browser-wide `Browser.*` and `Target.*` methods in `REFUSED_METHODS`, and any domain not listed (WebAuthn, IndexedDB, CacheStorage, …).

Bounds: at most 256 commands await a tab's answer per facade, and at most 1024 messages wait for the Daemon's window; past either the facade closes and the stream ends with `failed`. A tab that finishes opening after the facade closed is closed again, never attached.

## Driving a tab

One `DebuggerHub` per `webContents` (`hub.ts`): facades share an attachment; the last one detaches. On every attach the hub sends `Emulation.setFocusEmulationEnabled`, because Chromium drops synthetic input on a tab that isn't focused, and the session's Browser is often not on screen. Opening DevTools detaches `webContents.debugger`; the hub reattaches while a facade still holds the tab, and ends the sessions with `Target.detachedFromTarget` if it can't. A tab shows the agent-driving indicator (`setAgentDriving`) once the agent sends it a command that acts on it, not for attaching or the setup every attached tab gets (`driving.ts`); agent-browser auto-attaches to the person's new tabs too. Main shows it only while the session is mid-Turn and clears it when the Turn ends (`browser.working`), so Pick unlocks then.

The relay opens each stream with `Polaris.hello { tabs }`, the tabs it remembers; a facade over a session with no tabs reopens their URLs (`openedBy User`), so a Desktop App taking the Browser over shows the same pages. The facade reports `Polaris.tabs` after every change. Neither reaches the agent.

## Tests

`facade.test.ts` covers filtering, refusals, routing and the hub with a fake debugger. `apps/daemon/src/browser/smoke.e2e.test.ts` runs the real agent-browser through the real relay, the real `BrowserHosting` and real byte streams to a real `WebContentsView` in Electron (`smoke/electronMain.ts`, a stand-in Desktop App that connects to the Daemon with `@polaris/client` and runs `serveBrowserHost` as the app does).
