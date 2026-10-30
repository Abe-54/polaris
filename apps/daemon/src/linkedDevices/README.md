# Linked Devices and the Relay route

A Linked Device (the Mobile App) reaches this Host through the Polaris Relay (ADR 0080) with
Client power, once its Noise key is linked here (ADR 0083). The relay's contract is
`apps/relay/README.md`; the shared code is `@polaris/protocol/relay` and `relay/party`.

| File | What |
|---|---|
| `route.ts` | `RelayRoute`: the setting, the Host's keys, open links, `admit` (which handshakes get a session) and the RPCs behind `relayRoute.*` and `devices.*`. |
| `link.ts` | `RelayLink`: the socket to the relay. Key proof, `peers` on every connect and change, handshakes, reconnect with backoff and full jitter. |
| `session.ts` | `DeviceSession`: one device's Noise session as the ByteTransport the server's Wire runs over. |
| `pacer.ts` | Keeps sends under the rates the relay announced, so a large reply is slowed, not closed with 4429. |
| `store.ts` | `LinkedDevices`: `~/.polaris/linked-devices.sqlite` (0600), public keys only; unlinking keeps the row and deletes its push registration. |
| `keys.ts` | The Host's Ed25519 relay identity and X25519 Noise static key, in HostSecrets. |
| `settings.ts` | `~/.polaris/relay-route.json` (0600): on or off and the relay URL. No file is off. |
| `connection.ts` | `ConnectionDevice`: the server annotates a relay connection with its device; `actorOf` and `hello` read it. |
| `selftest.ts` | `polaris selftest`'s libsodium line. |
| `device.testing.ts` | A test device and a real relay process for tests; also a reference for the Mobile App. |

## Who gets in

- A handshake init is answered only when `admit` accepts it: its proven Noise key is a linked
  device's **and** it came from the relay address stored with that key, or it came from an
  open link's address and its payload carries a valid link proof. Anything else gets no reply.
- An accepted device gets a new connection on the same RPC server as the Unix socket, as a
  token-less Client annotated with `ConnectionDevice`; ADR 0078's token-less rule never grants
  anything on this route by itself.
- What that connection may call is an allowlist, `DEVICE_RPCS` and `DEVICE_COMMANDS` in
  `@polaris/protocol` (`deviceGrants.ts`): the Mobile App's own surface, exhaustive over the
  RPCs and Commands so a new one is refused until it is added. Unknown tags are refused.
  `StartSession` is also decided on its decoded payload (RX3-1): any PermissionMode, including
  `full-access` (ENG-458), no `origin`, effort or service tier, in place
  or a new Worktree off the default base. The check names every field, so a new one fails
  typecheck until it is decided; a payload that doesn't decode as a Command is refused.
- `devices.unlink` marks the device unlinked, sends `peers` without it and ends its session:
  the Wire's input ends and the connection's finalizers run.

## Presence

`devices.list` and `devices.watch` give each device's `connectedSince`: when its open relay
session began, or null. The route records it when a session is served and clears it when the
session ends (`RelayLink`'s `ended`), and `devices.watch` sends the list again on each change,
link and unlink. Nothing polls: the relay's `presence` and the socket end sessions.

Push to Linked Devices (`devices.registerPush`, `wake`) is in `../push/README.md`.

## Linking

1. The Desktop App calls `devices.link` (needs the route on) and shows `linkString` as a QR
   code, then waits on `devices.awaitLink`.
2. The device decodes it (`decodeLinkString`), dials the relay with `linkIdentity(secret)`
   and starts a handshake to `hostNoiseKey` whose init payload is `encodeLinkRequest({ v: 1,
   address, name, proof: linkProof(secret, deviceNoiseKey, address) })`.
3. The Daemon checks the proof, replies, then stores the device and swaps the link's address
   for the device's in `peers`. `devices.awaitLink` returns the device. Storing it and
   closing the link (cancel, expiry, a newer link) take one lock, and storing happens only
   while the link is still open: a link that ends first links nothing.
4. The device closes that socket and dials as itself; from then on it handshakes normally.

A link is used once and expires after five minutes (`LINK_TTL_MS`). `devices.add` links a
device another Host already linked, from its relay address and Noise key.

## Lifecycle and cost

The route is off by default and costs nothing then: no socket, no timers, keys not read.
When on, the Daemon holds one WebSocket. Idle, it sends nothing: the relay pings and Bun
answers. A reconnect timer exists only while disconnected; a link's expiry timer only while
it is open. Sessions end with the socket, on `presence {online: false}`, on unlink and when
the same device handshakes again.

## libsodium in the compiled Daemon

`noise-handshake` runs on `sodium-native`, whose loader resolves its prebuild from disk.
`patches/sodium-native@5.2.0.patch` requires each shipped platform's prebuild literally, so
`bun build --compile` embeds exactly one; `polaris selftest` checks it (`libsodium: ok`).
