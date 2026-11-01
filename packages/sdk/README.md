# @doellsoftware/polaris-sdk

Read and drive Polaris Daemons from an Extension: a Raycast command, a glasses app, a script.
See your Hosts' sessions and the approvals waiting on you, answer them, send Turns, start
sessions.

The SDK works in Node (22 or later) and Bun, over the local Daemon's socket or a Host's gateway,
and in a browser or WebView, over the gateway only. It talks to Polaris 0.3.0 or later.

```sh
npm install @doellsoftware/polaris-sdk
```

## Pair first

Every Extension presents a pairing. Make one in the Desktop App (Settings → Extensions) or with
the `polaris` command on the Host, choose what it may do (its Grant), and paste the string it gives you
(`polaris-pair:v1:…`) into your Extension's settings. Keep it secret: it is a token.

| Grant | Lets the Extension |
|---|---|
| `read` | see Workspaces, sessions, Turns and pending approvals |
| `approve` | answer approvals |
| `turn` | send Turns, interrupt, continue |
| `start` | start sessions (a session that isn't supervised also needs `approve`) |
| `voice` | transcribe speech |

Anything else is refused with `NotGranted`, which names the Grant that was missing.

## The plain API

Promises for calls, async iterators for feeds.

```ts
import { createPolaris, NotGranted } from "@doellsoftware/polaris-sdk";

const polaris = await createPolaris({
  pairings: [process.env.POLARIS_PAIRING!], // one per Host, or several for one Host
  clientName: "My Extension",
});

const host = polaris.hosts[0]!;

// Re-emitted on every change; breaking out of the loop stops the feed.
for await (const view of polaris.subscribeHost(host.hostId)) {
  const approval = view.approvals[0];

  if (approval === undefined) continue;
  console.log(`Allowing: ${approval.title}`);
  await polaris.respondToApproval(host.hostId, approval.sessionId, approval.id, { kind: "allow" });
  break;
}

try {
  await polaris.sendTurn(host.hostId, sessionId, "Run the tests again");
} catch (error) {
  if (error instanceof NotGranted) console.log(`Pair again with the ${error.needed} Grant`);
  else throw error;
}

await polaris.close();
```

### Calls

| | |
|---|---|
| `connect(hostId)` | connect now (calls connect on first use anyway); resolves with the Host's info |
| `sendTurn(hostId, sessionId, prompt)` | send a Turn |
| `respondToApproval(hostId, sessionId, requestId, response)` | `{ kind: "allow", remember? }`, `{ kind: "deny", reason? }` or `{ kind: "answer", text }` |
| `interrupt(hostId, sessionId)` | stop the Turn in flight |
| `continue(hostId, sessionId)` | continue a Turn the Daemon interrupted when it restarted |
| `startSession(hostId, { workspaceId, harness, prompt, permissionMode?, worktree?, model? })` | resolves with the new session's id |
| `transcribe(hostId, audio)` | speech to text through the Host (the `voice` Grant); see Voice |
| `close()` | close every connection; feeds end |

### Feeds

| | |
|---|---|
| `subscribeHost(hostId)` | `HostView`: `workspaces`, `sessions` (newest first, archived left out), `archived`, `approvals` |
| `subscribeHosts()` | every Host's latest `HostView` at once; one that can't be reached has `error` set |
| `subscribeSession(hostId, sessionId, { turnLimit? })` | `SessionView`: `session`, `turns` with their items, `pendingApprovals`, `streaming` text |

When the connection drops, a feed emits its last view with `connected: false`, reconnects with
backoff and carries on from where it was. A Host that was never reached fails the feed at once
(`HostUnreachable`), so a wrong pairing doesn't wait forever. Pass `reconnect: false` to end feeds
on the first drop instead.

## Voice

`transcribe` sends microphone audio to the Host, which relays it to its speech-to-text provider
with a key that never leaves the Host, and yields what was heard. The audio is raw PCM: 16 kHz
(`VOICE_SAMPLE_RATE`), signed 16-bit little-endian, mono, in chunks of any size.

```ts
for await (const { finalText, interimText, finished } of polaris.transcribe(hostId, microphone)) {
  show(finalText + interimText);
  if (finished) await polaris.sendTurn(hostId, sessionId, finalText);
}
```

Each snapshot replaces the last: `finalText` is settled, `interimText` may still change. Ending
the audio iterator ends the feed with one `finished` snapshot; breaking out of the loop stops the
transcription. A transcript becomes a Turn only when you send it. Without a key on the Host the
feed fails with `VoiceError` (`reason: "no-key"`, and a message saying how to set one).

## The Effect API

The same client, for Extensions written with [Effect](https://effect.website): calls are Effects,
feeds are Streams, errors are typed, and connections close with the Scope.

```ts
import { Effect, Stream } from "effect";
import { openPolaris } from "@doellsoftware/polaris-sdk";

const program = Effect.gen(function* () {
  const polaris = yield* openPolaris({ pairings: [pairing], clientName: "My Extension" });
  const host = polaris.hosts[0]!;

  yield* polaris.subscribeHost(host.hostId).pipe(
    Stream.filter((view) => view.approvals.length > 0),
    Stream.runHead
  );
  yield* polaris.interrupt(host.hostId, sessionId).pipe(
    Effect.catchTag("NotGranted", (error) => Effect.log(`missing ${error.needed}`))
  );
});

Effect.runPromise(Effect.scoped(program));
```

## Errors

| Error | When |
|---|---|
| `InvalidPairing` | a pairing string can't be read (`reason` says why) |
| `HostUnreachable` | no pairing for the Host connects, or the connection was lost |
| `ExtensionTokenRejected` | the token is unknown or revoked (`reason`): pair again |
| `ProtocolMismatch` | the Host's Polaris is too old or too new for this SDK; `update` says which to update (`"polaris"` or `"extension"`) |
| `VoiceError` | the Host couldn't transcribe: `reason` is `no-key`, `key-rejected`, `provider-failed`, `busy`… |
| `AudioFailed` | the audio iterator passed to `transcribe` threw |
| `NotGranted` | the pairing's Grant doesn't allow it; `needed` names the Grant (null: not for Extensions) |
| `CommandRejected`, `NotFound` | the Daemon refused the command, or the session or approval is gone |
| `UnknownHost` | no pairing names that Host |

## Transports

Every `hello` presents the pairing's token and the protocol versions the SDK speaks
(`SUPPORTED_PROTOCOL`).

A pairing with a `url` (`ws://127.0.0.1:7477/polaris/rpc` on the Host itself,
`wss://<host>.<tailnet>.ts.net/polaris/rpc` over Tailscale) uses the gateway; one without uses
`$POLARIS_HOME/daemon.sock` (`~/.polaris/daemon.sock`). Several pairings for one Host (say, the
socket and the gateway) are tried in order. In a browser the package resolves to its browser
build, which has the gateway only. `createPolarisWith` and `openPolarisWith` take a transport of
your own.

## 0.2.0

Bundles the current protocol, including Data, Traces, Profiles and profile-attach approval
requests. This lets Extensions handle the approvals emitted by Polaris 0.8.0.

## Building

In the Polaris repository, `bun run --cwd packages/sdk build` writes the package to `dist/`, and
`bun run --cwd packages/sdk pack` also runs `npm pack` on it, into `build/`. The protocol is
bundled in; the only dependency is `effect`. Inside the repository the package is still
`@polaris/sdk`; only the published name differs. A release tag publishes it to npm with
provenance (`release.yml`'s `npm` job) when its version isn't there yet.

## Releasing

The SDK keeps the version in `packages/sdk/package.json`. A version containing `-` is published
under `next`; every other version uses `latest`, even when the Polaris tag is a prerelease.
An exact version already on npm is skipped without moving any dist-tags.

The workflow uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) on a
GitHub-hosted runner, with Node 24.22.1 and its bundled npm 11.19.1. It checks the tarball's
SHA-256 and publishes with provenance and lifecycle scripts disabled. It needs no `NPM_TOKEN`.

The owner completed the initial setup on 2026-10-24: `@doellsoftware/polaris-sdk@0.1.0` is
published with `latest = 0.1.0`, and a trusted publisher is registered for GitHub organization
`luxdotdev`, repository `polaris`, workflow filename `release.yml`, environment `npm`, with
direct `npm publish` allowed. No bootstrap token is needed in CI.

The initial trusted-publisher registration expires if no publish uses it within two days.
A release that leaves the SDK at `0.1.0` skips publishing and does not exercise that trust.
If the registration expires before the first release that bumps the SDK version, the owner
must re-register it with those same settings before that release runs.

Verify that next new SDK version publishes on GitHub with provenance and the expected tag.
Local tests use fake npm and GitHub commands and do not prove OIDC publication. This remaining work is
tracked in [ENG-425](https://linear.app/luxdev/issue/ENG-425). The GitHub `npm` environment's
reviewer and tag protection are owner settings; the Apple signing jobs keep their separate
`release` environment.
