# Daemon transport

The Daemon's socket listener, the RPC server on it, and `polaris bridge`. The second listener, the gateway (`ServerRpcs` over WebSocket on loopback for Extensions, ENG-399), lives in `../gateway/` and hands its connections to the same server. Decisions: ENG-175 (wire) and ENG-179 (SSH bridge, lifecycle).

| File | What |
|---|---|
| `server.ts` | `startServer`: lock, socket, `RpcServer` for `ServerRpcs`, one Wire per connection; with `gateway: { port }`, the gateway's connections too, each marked `tokenRequired`. Handler layers are composed here. |
| `rpcs.ts` | `ServerRpcs` = `DaemonRpcs` + the server-only `ConnectionBlobs` middleware. |
| `defects.ts` | Logs a request's defect with its cause; the server fails only that request (ADR 0064). |
| `rpcAdmission.ts` | Extension RPC reservations before payload decoding or handler forking: 32 per connection, 128 across the server, including streams. |
| `handlers.ts` | `hello` (HostInfo, capabilities; annotates the connection with the device label and the Client's capabilities, scopes it to a Pairing when it presents an `extensionToken`, and checks the Extension's `protocolVersions` against `PROTOCOL_VERSION`: required on the gateway, refused with `ProtocolMismatch` naming the side to update), the `extensions.*` RPCs, and placeholders for every other RPC. |
| `socket.ts` | Stale-socket probe, private socket directory, `Bun.listen` bound atomically, upgrade adoption. |
| `windowsPipe/` | Windows: the user-only, local-only named pipe the Daemon listens on, created through `bun:ffi` (`security.ts` is its descriptor and flags as data; ADR 0059). |
| `bunSocket.ts` | Bun sockets (listened or adopted by fd) as ByteTransports, with partial-write handling. |
| `lock.ts` | Single-instance lock. |
| `hostInfo.ts` | `HostInfo`, with a stable `hostId` in `~/.polaris/host-id` and `previousStop` when the last Daemon was stopped for an upgrade (ADR 0060); `helloHost` answers an older Client of a Windows Host with a newer protocol version (ADR 0059). |
| `bridge.ts` | `polaris bridge`: stdio ⇄ socket, byte for byte. |
| `localDaemon.ts` | How the Daemon's own CLIs reach it: the socket, or on Windows the pipe once its owner is checked. |
| `serve.ts` | `polaris serve`: `startServer` with `upgrades: true` until SIGINT / SIGTERM. |
| `byteStreams.ts` | The byte-stream RPCs (ENG-613): `hostAddress.open` bridges a loopback socket to a stream's blobs and credits; `browser.*` and `byteStream.credit` route to `BrowserHosting` (`../browser/`). See Byte streams below. |
| `byteStreamsHarness.ts` | The byte-stream suites' harness: a throwaway home, a Daemon with these handlers, Clients over the socket, `polaris bridge` or a raw socket, loopback servers. The Browser smoke (`../browser/smoke.e2e.test.ts`) uses it too. |

The framing and blob channel live in `packages/protocol/src/wire.ts` (shared with the Client): each RPC message is one JSON frame serialized with `RpcSerialization.json`; blobs are kind-1 frames. The writer drains queued JSON before each blob chunk and round-robins between blobs, so a large read never holds up a stream by more than one 256 KiB chunk. Limits (per connection): 512 MiB per blob, 1 GiB buffered, 60 s without progress fails a `take`, unclaimed blobs expire after 5 minutes; stream-sourced outgoing blobs buffer at most 4 chunks.

A handler takes an incoming blob whole (`BlobChannel.take`) or as a stream of chunks as they arrive (`BlobChannel.takeStream`, backed by `Wire.takeBlobStream`), which never holds the whole blob: `attachments.stage` writes uploads to disk that way. A streamed take can opt out of the idle timeout (long-lived blobs such as `terminal.attachBinary`'s output); a consumer that stops early makes the Wire drop the rest of that blob as it arrives. The frame decoder queues socket reads rather than merging them, so a blob chunk is copied at most once on its way in.

Incoming blob metadata has its own count limit: 1,024 entries by default, 128 on the gateway. Receiving, completed, failed and pending-consumer entries all count, including zero-byte blobs. Excess new incoming IDs close the Wire; a local `take` beyond capacity fails with `too-large` without allocating another entry. Consumption and expiry return capacity, and shutdown releases the map and buffered bytes. A blob whose consumer stopped reading midway (a Host-address stream whose socket closed) stays as a tombstone, so its late frames don't open a new entry, until the sender's final frame; only a sender that never finishes waits for the expiry sweep. Before ENG-612 every such stream held its slot for the whole 5-minute expiry, and the 1,025th Host-address connection within five minutes closed the Client's connection.

Extension RPC admission (ENG-418) reserves capacity before `RpcServer` can decode payloads or fork work. The gateway is always limited; a token-bearing socket hello permanently opts that connection into the same budget. Token-less socket Clients, including the Desktop App, use neither Extension limit. Overflow or a duplicate active request ID closes the offending connection instead of creating queued fibers. `Ack`, `Interrupt` and other control messages consume no slots. Streams retain their reservation until they terminate; responses and handler finalizers jointly release it. Limited handlers run in a nested request scope so their registered resource finalizers also complete before returning capacity. Disconnect marks requests terminal but keeps capacity for handlers still finalizing, preventing reconnects from bypassing the global bound. There are no new timers or polling loops.

**A defect fails only its request.** The RpcServer runs with `disableFatalDefects`: a handler that dies answers that request with an `Exit` whose cause is the `Die`, and the connection's other requests and streams carry on. The `ConnectionBlobs` middleware logs every defect at error level with the RPC's tag and the whole cause. Expected failures stay typed: a lazy build that fails answers each request with the typed error `lazyRpcLayer`'s `failure` gives it (ADR 0064).

## Byte streams

Host addresses (ADR 0093) and the Browser's CDP streams (ADR 0092) are raw byte streams carried on the Client's own connection, over the blob channel: each direction is one long-lived blob, and each side grants credit (`byteStream.credit`) as it consumes, 1 MiB by default and at most 64 MiB, so a stalled page holds no more than its window and a large transfer can't starve the JSON frames sharing the wire (the writer drains JSON before each blob chunk). A connection holds at most 128 streams of both kinds (`ByteStreamQuota`). `hostAddress.open` passes the hostname to the Host's loopback unresolved (`localhost`, `[::1]`, `*.localhost`), so Portless routes by SNI and Host header; ending the stream, or the connection dropping, closes the socket.

Checked on a Raspberry Pi 4 (`lucas-rpi`, ENG-612) through the Desktop App's proxy: a Portless app on `https://app.localhost:1355` and Vite 7 on `localhost:5173`, including Vite's HMR WebSocket after a page reload. `packages/bench`'s `byte-streams` (one 100 MiB transfer) and `host-address-reload` (a Vite-sized reload, one stream per module) time RPC next to them.

## Mounting handler layers

`startServer({ handlers })` takes any layer of RPC handlers, built from `DaemonRpcs`, `ServerRpcs` or a sub-group (`RpcGroup.make(...).toLayer`, `toLayerHandler`). Handlers are keyed by RPC tag, so they plug into `ServerRpcs` whichever group built them; any RPC not covered falls back to the placeholder. In `serve.ts`:

```ts
export const daemonHandlers = Layer.mergeAll(
  EngineRpcHandlers,                                   // dispatch, subscribeHost, subscribeSession
  FilesRpcsLive.pipe(Layer.provide(FileSearchLive())),
  GitRpcsLive,
  AttachmentRpcsLive,
  TerminalRpcsLive,
).pipe(Layer.provide(/* Engine, store, AttachmentStore, … */))
```

and add their capabilities with `startServer({ capabilities: [...] })` (the transport announces `blobs`).

**BlobChannel is per connection.** Every RPC in `ServerRpcs` carries the `ConnectionBlobs` middleware, which provides the calling connection's `BlobChannel` around each request; handlers read it with `yield* BlobChannel` inside the handler (not while the layer is built). A handler layer that lists `BlobChannel` as a requirement is satisfied at build time by a placeholder that dies if used outside a request, so `startServer` removes `BlobChannel` from the requirements. `transport.test.ts` runs `GitRpcsLive`'s `git.diff` through it.

**Device label.** `hello` calls `client.annotate(DeviceLabel, deviceLabel)` on the connection, so `dispatch` (engine) records which device resolved an approval. For an Extension the label is its Pairing's name.

**Extensions (ENG-398).** A `hello` with an `extensionToken` authenticates it against the Pairing store (`extensions/pairings.ts`, `~/.polaris/extensions.sqlite`, the token's SHA-256 only) and annotates the connection with `ConnectionPairing`; a malformed, unknown or revoked token fails `hello` with `ExtensionTokenRejected`. The first Pairing a connection presents is the one it keeps, and names it (`DeviceLabel`) whatever a later `hello` says; the token is checked again once the connection is bound, so a revoke racing `hello` loses either way. `ServerRpcs` carries the `GrantGate` middleware (`extensions/connection.ts`): every request on a scoped connection goes through `decideAccess` (`grants.ts` in the protocol, exhaustive over RPCs and Commands) and is refused with `NotGranted` naming the missing Grant, or null when the RPC is kept for Clients in 0.3.0. Token-less Clients are never gated. On a gateway connection (`tokenRequired`, `extensions/admission.ts`) a token is required: a token-less `hello` fails with `missing` and a request before `hello` with `NotGranted`, and the connection closes once the error is flushed. `extensions.pair`, `extensions.list` and `extensions.revoke` are served here; revoking closes the Pairing's live connections through `ExtensionConnections`, which `server.ts` binds to each connection's transport. `dispatch` records the connection's `Actor` on session starts, Turns and approvals.

**Remote Access (ENG-400, ADR 0076).** `remoteAccess.status`, `remoteAccess.enable` and `remoteAccess.disable` (Client-only) are served here from `RemoteAccessControl` (`remoteAccess/`): `tailscale serve --bg --https=443 --set-path /polaris http://127.0.0.1:<gateway port>/polaris`, the port from `gateway.json` (`remoteAccess/gateway.ts`). Tailscale holds the state; every call reads it back. `RemoteAccess` (`extensions/remoteAccess.ts`) gives `extensions.pair` the `wss://…/polaris/rpc` URL while it is on.

**The Relay route and Linked Devices (ENG-461, ADR 0080, 0082).** `relayRoute.*` and `devices.*` (Client-only) are served here from `RelayRoute` (`linkedDevices/`). When the route is on, each Linked Device's Noise session becomes a connection on this same server (`serveConnection` with a `LinkedDevice`), annotated with `ConnectionDevice` so `dispatch` records the `LinkedDevice` Actor and `hello` labels it with the device's name. See `linkedDevices/README.md`.

## Single instance, stale sockets, upgrades

- `~/.polaris/daemon.lock` is created with `O_EXCL` and holds the pid. A lock whose pid is dead is stale and is taken over; a lock with no pid yet is honoured for 2 s (another Daemon mid-start). The lock naming this very process but not held by it was inherited across an execve upgrade and is kept.
- Then the socket is probed: if something answers, another Daemon is running (exit 75 from `polaris serve`); a dead socket file is removed. The directory is made 0700, the socket is created under umask 0177 (0600).
- `startServer({ upgrades: true })` (what `serve` does) wires in `service/upgrade.ts`: `adoptListener` on startup (then the probe is skipped: the old listener still accepts), `bindAtomically` for every bind, `adopt` drains connections queued on the inherited listener through `connectFd`, and `serveUpgrades` gets the listener fd.
- On Windows the endpoint is `\\.\pipe\polaris-<hash of the home>` (`@polaris/protocol/endpoint`). The probe opens it: a pipe this user owns is a running Daemon, one another account owns is refused with a `LockError`. There is no execve or SIGUSR2: an upgrade stops the Daemon over its control pipe and the scheduled task starts the new one (ADR 0060). See ADR 0059.
- `daemon.lock` vs `daemon.pid`: the lock is the single-instance guard; `daemon.pid` (written by `serveUpgrades`) is the upgrade signal target. Only the lock holder writes the pid file, so both always name the same process; both survive the execve (same pid) and are removed on a clean exit. Merging them (pointing `upgradeFiles().pid` at `paths().lock`) would be a one-line change in `service/upgrade.ts` if we want one file.

## Bridge

`polaris bridge` connects to `paths().socket` and pipes stdin → socket and socket → stdout with backpressure. Bytes that arrive before the socket connects are buffered. It loads nothing but itself (`main.ts` imports each command lazily, and the exit code comes from the import-free `@polaris/protocol/bridge`), so a bridge, which lives as long as its Client stays connected, costs ~10 MiB rather than a Daemon's worth. It exits 0 when either side closes. On Windows it opens the pipe itself (`windowsPipe/client.ts`), reads the owner SID from that handle and adopts the same handle only when the owner is this user; another owner, or `ACCESS_DENIED`, exits `BRIDGE_EXIT_UNTRUSTED_DAEMON` (77) before a byte is sent, which Clients show as `daemon-untrusted`. With `--relay <pid>` it ends that process with its own exit code, which closes a Windows SSH channel held open by PowerShell (ADR 0063). When nothing listens and `~/.polaris/bin/polaris-supervise` exists (the fallback supervisor on Linux without systemd --user, which nothing may have started since a reboot), it starts the supervisor detached, waits up to 5 s for the socket to accept, and connects once more; input the Client sent meanwhile stays buffered. When the systemd `--user` unit (`~/.config/systemd/user/polaris.service`) exists instead, it starts nothing but waits the same 5 s: a WSL distro boots for the bridge's own `wsl.exe` session, and systemd (under linger) starts the Daemon about 300 ms later (docs/adr/0036-wsl-hosts.md). Otherwise, or if the Daemon does not come up, it exits `BRIDGE_EXIT_NO_DAEMON` (69) with a one-line stderr reason, which the Client shows as Needs Attention. `bridge.test.ts` runs the bridge as a process (`fixtures/bridge.ts`) against a stand-in supervisor. With agent forwarding on, it points `~/.polaris/agent.sock` at the forwarded `SSH_AUTH_SOCK` (atomic symlink swap), so the Daemon's long-lived processes have a stable agent path (`agentSocketPath()`).

## Bun quirks found here

- Under `bun test`, a `node:net` connect to a missing Unix socket fails the test even when its `error` event is handled; tests that need one run the code in a child process.
- Data that reaches a `node:net` socket before a `data` listener exists is dropped, and `drain` is not always emitted. Readers attach in the accept/open callback (`readEvents`), and writes also resolve on the write callback (`writeEvents`).
- `Bun.Socket#write` can accept part of a chunk; `bunSocket.ts` queues the rest until `drain`.

## Known gaps / TODO

- `daemonHandlers` in `serve.ts` is still `Layer.empty`; the lead wires the modules' layers (see above).
- Token-less Clients retain unrestricted RPC concurrency; their queued JSON uses the Wire's 8 MiB high-water mark. Extension connections have the admission limits above.
- `hello` does not reject old Clients over the socket; protocol-version negotiation is on the Client side there. Extensions declare `protocolVersions` and are refused a mismatch (`gateway/README.md`).
- The upgrade adoption path is exercised by `service/upgrade.test.ts` with its fixture, not end to end through `startServer`.
- `git/diff.ts` gets an `ArrayBuffer` from `Response#bytes()` where a `Uint8Array` is typed, so `countFiles` returns 0. The Wire now accepts any byte buffer, but the git module should wrap it in `new Uint8Array(...)`.
