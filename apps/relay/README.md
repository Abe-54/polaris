# Polaris Relay

The Polaris Relay (`@polaris/relay`) lets a Linked Device reach a Host on another network
(ADR 0080). A Host's Daemon and the user's Linked Devices both dial out to it over WSS. It
forwards frames between a device and the Hosts that link it and can read none of them: they
are end-to-end encrypted with Noise between device and Daemon, with keys exchanged at link
time.

It is a Bun + Effect service shipped as a container: ours runs on Railway, and anyone can run
their own.

This README is the contract for the Daemon side (R2) and the Mobile App (R4). The shared code
lives in `packages/protocol`:

| Import | What | Native code |
|---|---|---|
| `@polaris/protocol/relay` | Wire format: control messages, data frames, close codes, addresses, `verifyEd25519` | none (WebCrypto) |
| `@polaris/protocol/relay/party` | A party's key proof (`generateRelayIdentity`, `proveRelayKey`) and the end-to-end channel (`RelayInitiator`, `acceptHandshake`, `RelaySession`) | libsodium (`sodium-universal`) |

The relay itself imports only the first, so the end-to-end code and keys never enter it.

## Keys

Each party has two key pairs, made once and kept by the party:

- **Relay identity**: Ed25519. It proves the party to the relay. The party's **relay address**
  is derived from it: base64url (no padding) of the first 16 bytes of SHA-256 over the 32-byte
  public key, always 22 characters. The relay knows parties only by this address.
- **Noise static key**: X25519, for the end-to-end channel. The relay never sees it.

At link time the Desktop App's QR code carries the Host's relay address and Noise static
public key to the device. The device sends its own address and Noise static public key back
to the Daemon, which adds the device to its linked devices. The link flow itself belongs to
R2/R4. All the relay needs is that the Host lists the device's address (see `peers` below).

## Connection

1. The party opens `wss://<relay>/v1`. Anything else is 404; `GET /healthz` answers `ok`.
2. The relay sends a `challenge`: a fresh 32-byte nonce and its limits.
3. The party answers with `auth`, signing
   `"polaris-relay/1 auth\0" ‖ nonce ‖ role` (role byte: `1` host, `2` device) with its relay
   identity. A host also sends its linked devices in `peers`; a device must not send `peers`.
4. The relay checks the signature and replies `ready` with the party's address. Until then
   the party sends nothing else: a message while the proof is being checked closes the socket.
5. The relay then sends `presence` for every linked peer already online.

```
party                                  relay
  ── WebSocket upgrade /v1 ───────────▶
  ◀── {"t":"challenge","v":1,"nonce":"<b64url 32B>","limits":{…}}
  ── {"t":"auth","role":"host","key":"<b64url Ed25519 pub>","sig":"<b64url 64B>","peers":["<addr>",…]} ─▶
  ◀── {"t":"ready","address":"<addr>"}
  ◀── {"t":"presence","peer":"<addr>","online":true}       (one per linked peer online)
```

## Control messages

Text WebSocket messages of JSON. Schemas: `ClientControl` and `RelayControl` in
`packages/protocol/src/relay/wire.ts`.

| Message | Direction | Meaning |
|---|---|---|
| `challenge {v, nonce, limits}` | relay → party | First message on every socket. |
| `auth {role, key, sig, peers?}` | party → relay | The key proof. Exactly once. |
| `ready {address}` | relay → party | Proof accepted; data may flow. |
| `peers {peers}` | host → relay | Replaces the host's linked devices. Devices may not send it. |
| `presence {peer, online}` | relay → party | A linked peer came online, went offline, or was unlinked. |
| `unreachable {peer}` | relay → party | A forward to `peer` was dropped: it is offline, or it and the sender are not linked. The relay does not say which. |
| `wake {id, peer, token, environment, ticket, payload}` | host → relay | Wake a device that gave this host a ticket, online or not (see Push). Devices may not send it. |
| `woken {id, outcome}` | relay → host | What became of that wake. |

A host and a device can reach each other only while the host lists the device and both are
online. Two hosts, or two devices, never can. The relay keeps the lists in memory only, and a
host's list goes when its socket closes; the Daemon sends it again on every connect.

## Data frames

Binary WebSocket messages:

```
data frame = version:u8 (1)  op:u8  peerLength:u8  peer:ascii  payload
op 1       = forward. Party → relay: peer is the destination. Relay → party: peer is the source.
```

The relay reads only the header. It checks that the sender may reach `peer`, swaps the
destination address for the sender's, and passes the payload on unchanged. Payloads are at
most 65,544 bytes (`MAX_RECORD_BYTES`); a whole message is at most `MAX_RELAY_MESSAGE_BYTES`.
Ops 2–255 and versions other than 1 are reserved and close the socket today.

The relay keeps nothing. A frame for a peer that is offline is dropped with `unreachable`.
There is no queue and no redelivery; recovering is the job of the end-to-end session and the
protocol on top of it.

## End-to-end records

Each data frame's payload is one end-to-end record. Records are independent of the carrier,
so a later direct path between device and Daemon (e.g. iroh, ADR 0080) carries the same
records and only the carrier changes.

```
record = type:u8  tag:8 bytes  body
type 1 = handshake init   body = Noise IK message 1            device → host
type 2 = handshake reply  body = Noise IK message 2            host → device
type 3 = data             body = one Noise transport message, AD = type ‖ tag
```

- **Construction**: `Noise_IK_25519_ChaChaPoly_BLAKE2b`, prologue `polaris-relay-e2e/2`,
  implemented by [noise-handshake](https://github.com/holepunchto/noise-handshake) (Holepunch's
  handshake for Hyperswarm, Apache-2.0) over libsodium. We wrote no cryptographic primitives.
- **Directions**: Split's first key encrypts device → host, as the Noise specification says.
  Prologue `/1` had them reversed; a `/1` party and a `/2` party fail at the handshake, and
  both must update. Keys are unchanged, so links made under `/1` keep working without re-pairing.
- **Who starts**: the device always starts, with the Host's Noise static key from the QR code.
  IK hides the device's static key from everyone but the Host, and the Host proves its own
  key in the reply.
- **Linking**: `acceptHandshake` passes the device's proven static key to `isLinked` and
  refuses the device before replying when it is not linked. The Daemon should also check that
  the frame's source address is the one stored with that key.
- **Tag**: 8 random bytes the device picks per handshake. They tell a peer's sessions apart
  across reconnects. The tag is authenticated as associated data in every data record.
- **Plaintext**: the byte stream of ordinary `packages/protocol` frames (`encodeJsonFrame`,
  `encodeBlob`). `seal` splits it into records of at most 65,519 plaintext bytes, and the
  receiver feeds each `open` result to a `FrameDecoder`. RPC, blobs and resume work as on any
  other transport.
- **Order**: records must be opened in the order they were sealed. A lost, repeated or
  reordered record fails authentication; the session is then dead, and the device starts a
  new handshake. The relay keeps order on a socket, so this happens only across reconnects.
- **Limits**: a session refuses to seal or open past 2³²−1 records (Noise's nonce), which
  also needs a new handshake.
- `RelaySession.handshakeHash` is the same on both sides and can bind higher-level proofs to
  the session.

## Reconnecting

Relay sockets drop: networks change, the relay redeploys, phones sleep. Parties should:

- Reconnect with exponential backoff and full jitter (e.g. 0.5 s doubling to 30 s), prove the
  key again, and, as a host, send `peers` again in `auth`.
- Treat `presence {online: false}` and their own reconnects as the end of every session with
  that peer. The device starts a new handshake when it sees the host online. The host drops
  sessions it holds for a device that went offline or reconnected.
- Not resend records across sessions. The protocol layer above resumes (`packages/client`'s
  resume) as it does after any dropped connection.

A newer socket that proves the same key replaces the older one, which is closed with `4409`.
So a Daemon that restarts before its old socket times out takes over at once.

## Push

A phone that is asleep has no socket, so a host wakes it through APNs: it sends `wake` with
the device's APNs token and environment (`sandbox` for development builds, `production` for
TestFlight and the App Store), the device's **ticket**, and a payload sealed to the device
(HPKE, `relay/push.ts`). A host declares its own peers, so listing a device proves nothing;
the ticket does. The device signs it with its relay identity for one host:
Ed25519 over `"polaris-push-ticket/1\0" ‖ hostAddress ‖ "\0" ‖ environment ‖ "\0" ‖ token`
(`signPushTicket`), and hands it to that Host with its registration. The relay checks that the
ticket's key hashes to `peer` and signs this host's address, environment and token, so a
host can wake only devices that registered with it, at the token they gave it. It rate-limits
per host relay address (a reconnect doesn't refill the budget) and asks the push service
(`apps/site`'s `/api/push`) to deliver `{token, environment, payload}`. It answers `woken`:

| Outcome | Meaning |
|---|---|
| `sent` | APNs accepted it. |
| `unlinked` | No valid ticket from `peer` for this host; nothing was sent. |
| `rate-limited` | Over the host's wake rate, or APNs throttled it. |
| `unregistered` | APNs no longer knows the token: the host drops it until the device registers again. |
| `refused` | The push service refused it, e.g. a production token on a preview deployment. |
| `unavailable` | No push service configured, it is busy or down: try later. |

The relay sends `challenge {push: true}` only when a push service is configured.

**Requests to the push service** are `POST` with JSON `{token, environment, payload}` and three
headers: `x-polaris-timestamp` (Unix seconds), `x-polaris-nonce` (16 random bytes, base64url)
and `x-polaris-signature`, base64url HMAC-SHA256 under the shared secret over
`"polaris-push/1" \n method \n path \n timestamp \n nonce \n hex(SHA-256(body))`
(`signPushRequest` in `@polaris/protocol/relay`). The service refuses timestamps more than 60 s
off and nonces it has seen.

**What it sees.** The relay sees the APNs token, the environment, the payload's size and when
wakes happen, and which host asked for which device. It cannot read the payload; it logs only
each wake's outcome and duration (`relay.wake`), never the token, payload or addresses. The push
service sees the token, environment and sealed payload, not who sent it.

### Live Activities (ADR 0088)

A host sends `live {peer, token, environment, ticket, slice, active, alert}` with its slice of a
device's Live Activity, sealed to the device; `slice: null` leaves the activity. The ticket is
the device's live ticket (`signLiveTicket`, context `polaris-live-ticket/1`), checked on every
frame; a bad one is answered `live-gone {token, outcome: "unlinked"}`. The relay keeps the
latest slice per (token, host) in memory only and sends the merged ContentState `{v: 1,
slices}`, ordered by host address, per (device, environment, token): a ticket from another
device for the same token makes another activity, so a host can't add to or evict a device's
slices. It sends that to the push service as `{token, environment, live: {event,
timestamp, state, alert}}`:

- routine updates at most once every 5 s per token (APNs priority 5);
- a slice with `alert` (a new Needs You) at once, with the alert, spending the host's wake budget;
  over it, the slice goes as routine;
- past six hosts, those with `active` (work or Needs You) are kept;
- a host's slice goes when it stops listing the device in `peers`, sends `slice: null`, or its
  socket has been gone `POLARIS_RELAY_LIVE_HOST_GONE_MS` (a sleeping host stops saying "working");
- APNs' `unregistered` ends the activity: every host with a slice in it hears
  `live-gone {token, outcome: "unregistered"}`.

A host holds slices in at most `POLARIS_RELAY_MAX_PEERS` activities, and the relay in at most
`POLARIS_RELAY_MAX_LIVE_ACTIVITIES` (10,000). A host that disconnects keeps its slice for
`POLARIS_RELAY_LIVE_HOST_GONE_MS` (2 minutes), then the activity updates without it; a Daemon
that stops cleanly sends a last idle slice first. Slices are lost when the
relay restarts, and every host sends its slice again when it reconnects. The relay reads only
`active` and `alert`; each push logs `relay.live` with its outcome, host count and whether it
alerted, never the token or the slices.

| Variable | Value |
|---|---|
| `POLARIS_RELAY_PUSH_URL` | The push service, e.g. `https://polaris.lux.dev/api/push` |
| `POLARIS_RELAY_PUSH_SECRET` | The shared secret, the same value as the site's `POLARIS_PUSH_SECRET` for that environment: `openssl rand -base64 32` |
| `POLARIS_RELAY_WAKES_PER_MINUTE`, `POLARIS_RELAY_WAKE_BURST` | Per host relay address: 60 a minute, burst 20 |
| `POLARIS_RELAY_MAX_WAKES_IN_FLIGHT` | Wakes and Live Activity updates waiting on the service at once: 256 |
| `POLARIS_RELAY_MAX_LIVE_ACTIVITIES` | Live Activities the relay holds slices for at once: 10000 |
| `POLARIS_RELAY_LIVE_HOST_GONE_MS` | How long a disconnected host's Live Activity slices stay: 120000 |

Set both push variables or neither; one without the other stops the relay at start.

## Limits and close codes

| Limit | Default | Env |
|---|---|---|
| Auth timeout | 10 s | `POLARIS_RELAY_AUTH_TIMEOUT_MS` |
| Idle timeout: no traffic, pongs included; the relay pings in between | 60 s | `POLARIS_RELAY_IDLE_TIMEOUT_SECONDS` |
| Messages per socket | 500/s, burst 1,000 | `POLARIS_RELAY_MESSAGES_PER_SECOND` |
| Bytes per socket | 8 MiB/s, burst 16 MiB | `POLARIS_RELAY_BYTES_PER_SECOND` |
| Largest message | 65,611 B | (wire format) |
| Linked devices per host | 64 | `POLARIS_RELAY_MAX_PEERS` |
| Bytes queued to a slow receiver before it is closed | 16 MiB | `POLARIS_RELAY_BACKPRESSURE_LIMIT_BYTES` |
| Sockets per network address | 32 | `POLARIS_RELAY_MAX_CONNECTIONS_PER_IP` |
| New sockets per network address | 1/s, burst 20 | `POLARIS_RELAY_CONNECTS_PER_SECOND_PER_IP`, `…_CONNECT_BURST_PER_IP` |
| Sockets in all | 10,000 | `POLARIS_RELAY_MAX_CONNECTIONS` |

The idle timeout only drops dead sockets. Bun pings a quiet socket and any WebSocket client
answers, so an idle Daemon stays connected without sending anything itself (ADR 0080's
keepalive).

| Close code | Meaning |
|---|---|
| `4400` | Malformed or out-of-order message (the reason says which) |
| `4401` | Key proof failed |
| `4408` | No proof within the auth timeout |
| `4409` | Replaced by a newer socket with the same key |
| `4429` | Message or byte rate exceeded |
| `1009` | Message over the size limit |
| `1006` | Idle timeout, or the network dropped |

Refused upgrades get HTTP `429` (too many sockets, or too fast, from one address) or `503`
(the relay is full).

## Logging

One JSON line per socket on close (`relay.connection`): a random connection ID, role, whether
it authenticated, duration, frame and byte counts in and out, `unreachable` and `dropped`
counts, the close code and why the relay closed it. There are also `relay.start` and
`relay.refused {reason}` lines. Lines never contain payloads, relay addresses, keys or network
addresses. Network addresses are held in memory only while they have sockets open.

## Running

```sh
bun run --cwd apps/relay start                         # PORT (default 8080), POLARIS_RELAY_HOSTNAME
docker build -f apps/relay/Dockerfile -t polaris-relay .   # from the repository root
docker run -p 8080:8080 polaris-relay
```

TLS terminates in front of the relay: Railway's edge, or your own proxy. Behind a proxy, set
`POLARIS_RELAY_TRUST_PROXY=true` so per-address limits use the first `X-Forwarded-For` hop.
Without that, every client looks like the proxy. The relay is one process with in-memory
state, so run a single replica; spreading parties across replicas needs shared routing (not
built). `railway.json` builds the Dockerfile and health-checks `/healthz`.

`apps/relay-rs` holds the same relay in Rust, held to this contract by the tests below, and
the load generator that measures both (ADR 0104).

## Tests

`bun run --cwd apps/relay test`:

- `relay.test.ts`: two parties handshake and exchange protocol frames through a real relay
  socket, with checks that nothing they handed the relay and nothing it logged holds the
  plaintext or an identifier. Also linking, unlinking, presence, device and host reconnects,
  replacement, and the order of forwarded frames: mixed sizes in a burst, beside a refused
  forward, and before a party's `presence` offline.
- `push.test.ts`: wakes reach a fake push service signed, only with the device's ticket for
  that host and within the rate (across reconnects), and nothing a wake carries is logged.
- `abuse.slow.test.ts`: key proof failures, auth and idle timeouts, malformed messages, size,
  message and byte rates, per-address socket caps.
- `process.slow.test.ts`: the same exchange against the `bun src/main.ts` process, including a
  clean `SIGTERM` exit.
- `packages/protocol/src/relay`: the channel (tampering, replay, gaps, unlinked devices, wrong
  host key) and the wire format.

With `POLARIS_RELAY_COMMAND` set to a command that serves a relay on `$PORT`, every test above
starts that command instead of the in-process relay, configures it through the environment
variables of this README, and reads its log lines from stdout. It needs a build that binds a
free port for `PORT=0`, as the Rust relay does (`apps/relay-rs/README.md`).
