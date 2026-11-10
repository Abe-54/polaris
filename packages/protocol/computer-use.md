# Computer use: the wire contract

What the Daemon, the Desktop App, the Mobile App and Extensions build against for computer use (ENG-846, ADR 0104). The schemas are in `src/computerUse.ts`, the policy in `src/computerUsePolicy.ts`, and the additions to existing types in `src/domain.ts`. The policy is specified in `packages/spec/computer-use.qnt`.

The Daemon serves status, setup, on/off and the always-allowed list (`apps/daemon/src/computerUse/`) and announces `computer-use`. It serves the preview too (`apps/daemon/src/computerUse/preview/`): `preview.latest` on every Host, and `preview.watch` with `computer-use.preview` on macOS when the capture tool is beside the Daemon. `computerUse.app` still answers `Unsupported` (`apps/daemon/src/transport/computerUseDefaults.ts`, a layer of its own that the real handlers replace), and the Engine doesn't send the two approval kinds yet.

`COMPUTER_USE_RPC_TAGS` lists the ten RPCs. The SDK's Client group (`ExtensionClientRpcs`) leaves them out, as it does Requests: no Extension may call them.

## Capabilities

| Capability | Who announces it | What it covers |
|---|---|---|
| `computer-use` | The Daemon, once it serves the RPCs below. A Client, when it decodes the two new approval kinds. | Every `computerUse.*` RPC except the live preview, the `app` and `headed-input` approval kinds, and `ToolCall.computerUse`. |
| `computer-use.preview` | The Daemon, only on a Host that can capture a window live (macOS). | `computerUse.preview.watch`. |

The Daemon sends an `app` or `headed-input` approval only to a Client that announced `computer-use`, as it does for `secret` and `approval.secret`: an older Client can't decode the kind. `ToolCall.computerUse` is an optional field, so it needs no gate.

## Status

`ComputerUseStatus` is `{ state, checkedAt }`. `state` is the first of these that applies:

| `state` | Meaning | What a Client offers |
|---|---|---|
| `NoDesktop` | The Host has no desktop session. The Daemon detects this itself. | Nothing to turn on. |
| `Off` | The user has not turned computer use on for this Host. | Turn on (`computerUse.enable`). |
| `NeedsSetup { setup }` | It is on and something is missing. | The setup for `setup`, below. |
| `Ready` | Agent Sessions get the `polaris_desktop` tools. | Turn off (`computerUse.disable`). |

`setup` is one of:

- `MacPermissions { accessibility, screenRecording }`: each permission of Polaris Computer Use.app, true once granted. At least one is false.
- `LinuxPackages { packages, command }`: packages to install. `command` installs them with the Host's package manager, or is null when Polaris doesn't know it.
- `AccessibilityBus {}`: the accessibility bus (AT-SPI) is off or not running.

| RPC | Payload | Answers |
|---|---|---|
| `computerUse.status` | `{ refresh }` | The status. `refresh` checks the Host again. |
| `computerUse.watch` (stream) | `{}` | The Host feed, below. |
| `computerUse.enable` | `{}` | The new status. On again is fine. |
| `computerUse.disable` | `{}` | The new status. Sessions lose the tools and every Controlled app is released. |
| `computerUse.openSetup` | `{ permission }` | The status. Opens setup on the Host itself, never on the Client's machine. `permission` is `accessibility`, `screen-recording`, or null for the Host's one step (macOS 27). Fails with `ComputerUseSetupFailed { message }`. |

**The Host feed.** `computerUse.watch` sends `ComputerUseItem`s: one `Status`, one `AllowedApps` and one `ControlledApps` first, then each again, whole, whenever it changes. Ending the stream unsubscribes. The Daemon doesn't poll for this stream: it rechecks when a Client asks with `refresh`, after `openSetup`, and when a session needs computer use.

`ControlledApps` lists each app a session controls now (`{ app, sessionId, since }`), for "in use by …".

## Apps

- `AppId`: the app's stable id on its Host. The bundle id on macOS, the executable's path on Windows, the `.desktop` id on Linux. Never the display name.
- `DesktopApp`: `{ id, name, icon }`. `icon` is a PNG as base64, at most 64 px on each side and 32 KiB, or null. The Daemon scales it.
- `AppRef`: `{ id, name }`, without the icon. `computerUse.app { appId }` answers the `DesktopApp` for one (`NotFound` when the Host has no such app).
- `AppWindow`: `{ id, title }`. `id` is the Host's own window id as text.

## Approvals

Two new `ApprovalKind`s. Both carry the app in `ApprovalRequest.app` (a `DesktopApp`) and the session in `sessionId`. Both are answered with `RespondToApproval`, like any approval.

| Kind | Asked | Answers |
|---|---|---|
| `app` | Once per app per Agent Session, in every permission mode. | `Allow { remember: false }`: allow for this session. `Allow { remember: true }`: always allow on this Host. `Deny`. |
| `headed-input` | Once per app per Agent Session, after the app is allowed, before the first headed input in it. | `Allow { remember: false }`: allow for this session. `Deny`. Never always-allowed. |

`appDecisionRefusal(kind, decision, actor)` is the rule for which decision fits: it answers the reason a decision is refused, or null. The Daemon applies it inside the commit, with the `Actor` that sent the command, and rejects a refused decision (`CommandRejected`); the approval stays pending. Refused:

- `Allow { remember: true }` on `headed-input`, from anyone.
- `Allow { remember: true }` on `app` from an Extension. "Always allow" changes the Host for every later Agent Session, so only the Desktop App and a Linked Device set it; an Extension allows for the session or denies.
- `Answer` and `Provided`.

## The policy

`computerUsePolicy.ts` is the policy as pure functions over `AppPolicy`. The Daemon keeps one per Host and folds it; nothing in it reads a permission mode or a Harness.

`decideAppUse(policy, { sessionId, appId, headed })` answers the first that applies:

1. `Refused`: the app is on the built-in always-refused list. No approval and no always-allow reaches it.
2. `InUse { by }`: another session controls the app. The tool call is refused; there is no queue.
3. `NeedsApproval { kind: "app" }`: the app is neither always-allowed nor allowed for this session.
4. `NeedsApproval { kind: "headed-input" }`: the use is headed, and headed input is not allowed for this session in this app.
5. `Allowed`: act. `controlApp` then records that the session controls the app.

What changes it:

| Function | When | Effect |
|---|---|---|
| `answerAppApproval` | An approval is resolved. | `Allow` grants the session the app, or headed input in it. With `remember`, an `app` approval always-allows the app on the Host instead. `Deny` and a refused decision change nothing, so the next use asks again. |
| `releaseSession` | The session's Turn ends, or the Daemon restarts. | Every app the session controls is released. Its approvals stay. |
| `forgetSession` | The session is archived or removed. | Its approvals go with it. |
| `withoutAllowedApp` | `computerUse.removeAllowedApp`. | The app is no longer always-allowed. Sessions that relied on it ask again. |

A session's approvals are folded from its `ApprovalRequested` and `ApprovalResolved` events, so they survive a Daemon restart. Subagents use their session's id, so they share its Controlled apps. The always-refused list itself belongs to the Daemon.

## The always-allowed list

| RPC | Payload | Answers |
|---|---|---|
| `computerUse.allowedApps` | `{}` | `AllowedApp[]` (`{ app, allowedAt }`), by name. |
| `computerUse.removeAllowedApp` | `{ appId }` | The list after removing it. An app not on it is fine. |

The list also arrives on the Host feed.

## Preview

Every preview image is a JPEG that travels as a blob (binary side-chunks), never inline, so a frame never delays a JSON frame such as an approval. `PreviewFrame` is `{ blobId, bytes, width, height, capturedAt, app, window }`. `window` is null for a capture of the whole screen.

| RPC | Payload | Answers |
|---|---|---|
| `computerUse.preview.watch` (stream, capability `computer-use.preview`) | `{ sessionId, maxEdgePx, link }` | `PreviewItem`s: `Frame { frame }`, or `Idle { reason }` with `no-window`, `screen-locked` or `not-ready`. |
| `computerUse.preview.latest` | `{ sessionId, maxEdgePx }` | The session's latest screenshot, or null. |

- **Subscribe and unsubscribe.** Opening `preview.watch` subscribes; ending the stream unsubscribes. The Host captures only while at least one Client watches.
- **Size.** `maxEdgePx` is the longer side the Client wants, null for the largest. The Daemon clamps it with `previewEdge`: 160 to 1280 px. A frame is at most 512 KiB (`PREVIEW_MAX_FRAME_BYTES`); the Daemon lowers JPEG quality to fit.
- **Rate.** The Client names its `link`: `local`, or `remote` for SSH, Remote Access and the Relay. The Daemon sends at most `PREVIEW_MAX_FPS[link]` frames a second: 10 local, 2 remote. A frame is dropped, never queued, while the previous one is still being sent.
- **No live stream.** A Host without `computer-use.preview` (Linux, Windows) answers `preview.latest` with what the session's last action saw. It is null before the first action, and on a Host that can't take screenshots (Wayland outside GNOME). On macOS it is the still thumbnail.

## Tool Calls

`TurnItem.ToolCall.computerUse` is a `ComputerUseCall`, set on a `polaris_desktop` call and null on any other:

- `app`: the `AppRef` the call acted on, or null for a call about no one app (listing apps).
- `window`: the `AppWindow`, or null when the call names none. Its `id` matches `PreviewFrame.window.id`.
- `headed`: the call used headed input.

## Who may call what

| | Desktop App | Linked Device | Extension |
|---|---|---|---|
| `computerUse.status`, `watch`, `app`, `preview.latest` | yes | yes | no |
| `enable`, `disable`, `openSetup`, `allowedApps`, `removeAllowedApp`, `preview.watch` | yes | no | no |
| Answering an `app` or `headed-input` approval (`RespondToApproval`) | yes | yes | with the `approve` Grant |
| "Always allow on this Host" (`Allow { remember: true }` on `app`) | yes | yes | no |

**Who may always-allow.** The Desktop App, and the Mobile App answering as a Linked Device. No Extension may: Even G2 and Raycast offer "allow" (for this session) and "deny" only, and the Daemon refuses `Allow { remember: true }` on `app` from an Extension whatever its Grants. Nobody may always-allow headed input.

A Linked Device fetches `preview.latest` on demand, to show what the agent sees next to an approval. The live stream (`preview.watch`) stays on the Desktop App.

A Linked Device or an Extension sees the approvals only once it announces `computer-use`.
