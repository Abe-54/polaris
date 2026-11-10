# Polaris for Even G2 (ENG-406)

An Even Hub app for Even Realities G2 glasses: your agent sessions and the approvals waiting on
you, on the glasses, with spoken replies. It runs in the Even app's WebView on the phone and talks
to each Host's gateway through `@polaris/sdk` (`packages/sdk`). Adapted from
even-realities/evenhub-templates@8cb01354 (MIT; see `ATTRIBUTION.md`).

## On the glasses

| Screen | Shows | Tap | Hold | Double-tap |
|---|---|---|---|---|
| Sessions | every paired Host's sessions: Needs you, then Working, then Idle, then the rest | open the session | | exit (asks first) |
| Session | title, state, Host; the oldest approval's title and detail, or the last reply | actions | speak a reply | back |
| Actions | Approve / Deny (Allow once / Deny for computer use: "Use ‹app›?", "Take mouse and keyboard?"; an Extension can't always-allow), a question's options, Interrupt, Continue (after an interrupted Turn), fixed replies, Speak a reply | run it | | back |
| Voice | live text while you hold; then Send / Retry / Cancel | stop, or choose | release stops | cancel |

An approval that arrives while the app is open jumps to the front, unless you are speaking; then it
jumps once the voice screen closes. Voice streams the glasses' microphone (16 kHz s16le mono PCM)
to the Host's `transcribe`, so the speech-to-text key stays on the Host. The transcript reaches an Agent Session only after you
choose Send on the glasses. It answers the question open when recording began, otherwise it is a new
Turn. If the question changes before Send, cancel and open the session again.

The OS takes a tap followed by a hold for its own menu, so "Speak a reply" in the actions does the
same as holding.

The glasses redraw at most every 120 ms. Text changes update in place; a new list or layout rebuilds
the page. When the WebView comes back from the background, the app drops its connections and opens
them again. An interrupted recording offers Retry. Audio waiting for the Host is bounded; if it
falls behind, recording stops and asks you to retry.

## On the phone

Open the app in the Even app. On the Mac, turn on Remote Access (Settings → Hosts, or
`polaris tailscale on`) so pairing strings carry `wss://<host>.<tailnet>.ts.net/polaris/rpc`. Then
add a pairing in Settings → Extensions and scan its QR code or paste its pairing string. Pairings are
kept in the WebView's `localStorage`; one for the Host's own socket is refused, since a phone can't
open it. Several Hosts can be paired.

The phone needs Tailscale connected, and the tailnet policy must let it reach the Mac on TCP 443.
When either is missing, the WebView reports only `Load failed`, so the phone page says to check
both when a Host can't be reached.

## Develop

```bash
bun run --cwd extensions/even-g2 dev:glasses        # Vite on 127.0.0.1:5173; EVEN_DEV_LAN=1 for the phone's QR
bun run --cwd extensions/even-g2 simulate           # the Even Hub simulator against it, with a smoke run
```

`VITE_POLARIS_PAIRING=<pairing string>` seeds a pairing in dev when the WebView has none
(`polaris extension pair --name "Even G2" --allow read,approve,turn,voice` on the Host, or Settings → Extensions).
A local gateway pairing (`ws://127.0.0.1:7477/polaris/rpc`) works in the simulator.

Tests (`bun run --cwd extensions/even-g2 test`) cover the screens and their moves, the event
parsing, the renderer and pairing storage, and run the app against a real Daemon (`polaris serve`
from source with the bench Harness) with fake glasses at the bridge.

## Pack and install

```bash
bun run --cwd extensions/even-g2 pack --host <mac>.<tailnet>.ts.net [--host <origin> …]
```

writes `build/app.json` with those origins in the network whitelist (a bare host gets `https://` and
`wss://`) and `build/polaris-g2-<version>.ehpk`. The whitelist isn't enforced for WebSockets
(see below), but Even Hub lists it to the user.

A release tag also packs it in CI, for the Hosts in the repository variable `EVEN_G2_HOSTS`
(separated by spaces or commas): the release run's `polaris-g2-<version>` artifact holds the
`.ehpk` and its `app.json`. It is never a Release asset, and CI doesn't upload it: `evenhub login`
needs a terminal, and its saved refresh token lasts seven days and rotates on use. To ship it:

1. `gh run download <run-id> -n polaris-g2-<version> -D build/ci` (the release run's ID).
2. Check `build/ci/app.json`'s network whitelist names the Hosts you expect.
3. `bunx evenhub upload build/ci/polaris-g2-<package version>.ehpk -m "<changes>"`.
4. `bunx evenhub promote <package version> --to beta`.

`<package version>` is `extensions/even-g2/package.json`'s, which can differ from the release's.

Install through Even Hub's beta channel:

1. `bunx evenhub login` once, in a terminal: it refuses a non-TTY and has no token flag. Later
   commands reuse `~/.config/evenhub/credentials.yaml`.
2. `bunx evenhub create build/polaris-g2-0.1.0.ehpk --name Polaris --tagline "Agent sessions on your glasses"`
   the first time; `bunx evenhub upload build/polaris-g2-<version>.ehpk -m <changes>` after that.
3. `bunx evenhub promote <version> --to beta`, then `bunx evenhub testers add <Even account email>`
   and accept the invitation.
4. Install the beta build from the Even app.

## What the I0 spike found (2026-10-23, iOS 18.7, SDK 0.0.16)

- A packaged build reaches `https://` and `wss://<mac>.<tailnet>.ts.net/…` through `tailscale serve`.
- The network whitelist isn't enforced for WebSockets; it is not a security boundary.
- The app's origin is `http://127.0.0.1:<port>`, with a new port each launch, so the Daemon knows an
  Extension by its pairing, never by its origin.
- `tailscale serve --set-path` strips the prefix before the backend sees it.
