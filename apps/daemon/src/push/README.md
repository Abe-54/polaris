# Push to Linked Devices

The Daemon pushes Needs You, notifications (`SessionNotified`) and finished Turns to Linked Devices through the Polaris Relay and
APNs (`apps/relay/README.md`, Push; `apps/site/app/api/push/README.md`). The relay and the push
service carry each payload sealed to the device and can't read it.

| File | What |
|---|---|
| `plan.ts` | Which Host stream items push: each new approval or question at once; each `SessionNotified` at once, as `notify` (an agent's `notify`, or Polaris's own when a Constellation needs the user); a finished Turn once its session stays Idle with no background tasks for 3 s (ADR 0073), except a Lead Turn Polaris started for a digest (`markDigestTurn`). A Constellation worker (`AgentSession.worker`, which the Host stream's Snapshot also sets from the graphs) pushes only Needs You (ENG-586). Pure. |
| `notifier.ts` | `PushNotifier`: follows the Engine's Host stream (`PushHostEvents`) only while some device is registered, learns digest Turns from the store model (the Host stream leaves out `LeadNotified`, ENG-587), runs the plan and its settle timer, and wakes each registered device, or holds a Needs You while the user is present. |
| `hold.ts` | The Needs You held while the user is at a Desktop App, and which of them they answered there. Pure. |
| `slice.ts` | Folds the Host stream into this Host's Live Activity slice (ADR 0088): the user's working sessions and the earliest start, the newest tool step, the oldest open approval or question. Pure. |
| `liveNotifier.ts` | `LiveNotifier`: follows the Host stream only while some device has a Live Activity registered, and sends the sealed slice in a relay `live` frame: after 1 s of quiet, at once with an alert for a new Needs You, and again when the registrations change or the relay socket connects. |
| `live.ts` | Fits a slice to 560 sealed characters (lines, then session titles, then the Host's name are cut) and seals it under info `polaris-live/1`. The contract is `@polaris/protocol/relay`'s `live.ts`. |
| `seal.ts` | HPKE base mode, DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM, info `polaris-push/1` ([`@hpke/core`](https://github.com/dajiaji/hpke-js), MIT). CryptoKit's `P256_SHA256_AES_GCM_256` opens it. |

## Registration

A device registers over its own Relay route connection with `devices.registerPush { token,
environment, pushKey, ticket }`: its APNs token, `sandbox` or `production`, the public half of
the P-256 key its Notification Service Extension holds, and its ticket for this Host (Ed25519
by its relay identity over this Host's relay address, environment and token). The Daemon
checks the ticket and the key, and keeps the registration in `linked-devices.sqlite`. Only a
Linked Device's connection may register (`not-a-device` otherwise). `automatic: false` is the
device's setting for automatic notifications (Constellations needing the user): those skip it,
while Needs You, agents' notifications and finished Turns still arrive. A new registration
replaces the last one, so the app rotates its key or token by registering again. Unlinking the
device deletes its registration; `unregistered` from APNs deletes it until the device
registers again.

## Live Activity (ADR 0088)

A device registers its activity's update token with `devices.registerLiveActivity { token,
environment, pushKey, ticket }`. The ticket is `signLiveTicket`: Ed25519 by its relay identity
over `"polaris-live-ticket/1\0" ‖ hostAddress ‖ "\0" ‖ environment ‖ "\0" ‖ token`, so a push
ticket can't stand in for it. The Daemon checks it and the key, keeps the registration in
`linked-devices.sqlite` (`live_activities`), and sends its slice. `unregisterLiveActivity`
forgets it and sends `live {slice: null}` so the relay drops this Host's slice. The relay's
`live-gone` (APNs no longer knows the token, or the ticket fails) drops the registration.

The widget extension opens slices with the push key from the shared Keychain, or on a device
from polaris-push's App Group copy (ADR 0090); `live.widget.test.ts` opens `live.ts`'s slices with
the extension's own Swift (needs swiftc).

Presence doesn't hold slices: the activity is the phone's, and the relay sends it anyway.

A clean shutdown sends a last idle slice (nothing working, nothing waiting) before the relay
socket closes; a Host that goes without one (sleep, crash) leaves the activity when the relay
has missed its socket for 2 minutes (ENG-585, `apps/relay/README.md`).

## Presence (ENG-495)

While the user is at a Desktop App, its connection reports `presence.report { presence: "present" }`
(capability `presence`; Desktop App connections only: a Linked Device or an Extension is refused).
`present` is a lease (`HostPresence`, `../presence/`): 120 s, renewed by the Desktop App every
60 s, ended by `away`, by lapsing, or the moment its connection closes. The Host is present
while any lease is live; only present or away crosses the wire.

While present, a finished Turn or a notification isn't pushed at all: the Desktop App showed it
as a banner, and a burst of them when the user leaves would be stale (ENG-524). A Needs You is
held instead, dropped once its request is resolved or withdrawn, and the rest go out when
presence ends, oldest first (at most 200 kept).

## Cost

No registration: no subscription, no timers. A registered Live Activity adds its own Host
stream subscription and a 1 s timer only after a change. With one: a Host stream subscription in memory,
and a timer only while a finished Turn settles. A live presence lease keeps one timer, at its
lapse; each Desktop App renews it with one small RPC a minute. Each push is one `wake` on the existing relay
socket; nothing is queued while it is down.

## Threat model

- The relay sees, per wake: the APNs token, the environment, the payload's size, the time, and
  which host relay address woke which device address. Never content.
- The push service sees the token, environment and sealed payload. Never content, nor who sent it.
- The ticket stops a host from waking a device that didn't register with it under that host's
  address. It doesn't bind the token to the device: a party that learns an APNs token (the relay
  operator, a Host the device registered with) could mint its own ticket for that token. Without
  the device's push key it can only cause the generic "Open Polaris" alert, which the extension
  can't open. Binding tokens to devices at the push service is a follow-up.
- Live Activity slices are sealed like pushes, under their own info, and the relay merges only
  slices whose ticket comes from the same device. A party that learns an activity token can
  still send its own (unreadable) slice to it, as with wakes, but not join the device's.
- A push names the Host, session and request ids in its sealed body; the app answers over its
  own end-to-end session, never through the push path.
