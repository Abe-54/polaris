# The gateway

The Daemon's second listener (ENG-399): `ServerRpcs` over a WebSocket on `127.0.0.1`, for Extensions (ADR 0075) and, through Tailscale, for Extensions away from the machine (ADR 0076). The Unix socket stays the Client's way in.

| File | What |
|---|---|
| `server.ts` | `startGateway`: `Bun.serve` on loopback; `GET /polaris/rpc` upgrades to a WebSocket, `POST /polaris/identity` proves the private secret; writes `gateway.json`; retries a busy port briefly, then runs without a gateway and says so. |
| `request.ts` | `admitRequest`: peer, path, method, Host and Origin checks before a request is served. |
| `transport.ts` | A server WebSocket as a ByteTransport (`GatewaySocketStream`), and the WebSocket handlers: bounded ingress, no pings, no authenticated idle timeout, binary only. |
| `config.ts` | The port (`daemon.json`, `POLARIS_GATEWAY_PORT`, default 7477), the record (`gateway.json`), the secret. |
| `client.testing.ts` | A WebSocket as a Client ByteTransport, for tests; the SDK has its own. |

## Contract

- URL `ws://127.0.0.1:7477/polaris/rpc`; behind Remote Access `wss://<machine>.<tailnet>.ts.net/polaris/rpc`, which `tailscale serve` proxies to `http://127.0.0.1:<port>/polaris` so the gateway still sees `/polaris/rpc` (ENG-400).
- The bytes are the socket's: binary WebSocket messages form one byte stream, framed by `packages/protocol/src/frame.ts`, in whatever pieces they arrive. The Wire framing and blobs in both directions are shared, with tighter gateway limits below; `transport/server.ts` serves a gateway connection with the same `serveConnection` as a socket one, with `tokenRequired`. A text message closes the connection (1003).
- `hello` first, with an `extensionToken` and `protocolVersions: { min, max }`. A token-less `hello` fails with `ExtensionTokenRejected` (`missing`), any request before a successful `hello` is refused with `NotGranted`, and both close the connection after the error is flushed (ADR 0078, `extensions/admission.ts`). A range the Daemon's `PROTOCOL_VERSION` falls outside of, or none at all, fails `hello` with `ProtocolMismatch`, whose message says whether to update Polaris or the Extension; the connection stays open for a `hello` that fits, but its granted RPCs remain blocked until that succeeds.
- No pings from the Daemon and no authenticated idle timeout: an idle Extension must not wake an idle Daemon (the `idle` bench). A dead peer is noticed by the Wire's own ping, sent only while a reply is due, as over the socket.
- Close codes: 1000 after a Daemon-side close (a refusal, a revoked Pairing), 1001 when the Daemon stops, 1003 for a text message, 1008 for an expired hello, 1009 for excess input and 1013 for a full connection queue.

## Who gets in

The token in `hello` is the real check; the request checks keep browsers out, since a page can open a WebSocket to loopback:

- **Host** must be `127.0.0.1`, `localhost` (any port) or end in `.ts.net`: a page that resolved its own name to 127.0.0.1 (DNS rebinding) names itself. Tailscale serve passes the original Host, so the serve name passes.
- **Origin** absent (an SDK outside a browser) or `http://127.0.0.1:<port>`: the Even app's WebView, whose port changes every launch (ENG-406). Anything else is a browser page and is refused.
- The peer must be loopback (the listener binds it anyway). `X-Forwarded-*` headers are not read: nothing needs them, and only loopback could send them.

## Identity

Remote Access proxies tailnet traffic to `127.0.0.1:<port>`. Each start writes `{ port, secret }` to `~/.polaris/gateway.json`: the secret is 32 random bytes encoded as unpadded base64url, kept only in this file and memory. The file is mode 0600 in a 0700 directory, replaced atomically through an exclusively created temporary file, and removed on stop.

Remote Access generates a fresh random 32-byte challenge for each check and sends `POST /polaris/identity`, `Content-Type: application/json`, body `{ "challenge": "<base64url>" }`. Both secret and challenge are decoded to their 32 bytes. The response is exactly `{ "mac": "<base64url HMAC-SHA256(secretBytes, challengeBytes)>" }`, with `Cache-Control: no-store`. Remote Access computes its own expected MAC from the private file and compares in constant time. A MAC recorded for an earlier challenge proves nothing for a fresh one; a repeated challenge intentionally produces the same MAC, so freshness belongs to the verifier (C, ENG-400).

GET and OPTIONS return 405. The challenge must be canonical, unpadded base64url of exactly 32 bytes; other JSON shapes (including extra fields) return 400, other content types 415, and bodies over 256 bytes 413. A body must finish within five seconds, even if bytes keep trickling in. The same Host/Origin checks apply and there are no CORS headers. The secret and challenges are never logged.

## Resource limits

- At most 16 gateway WebSockets; additional upgrades receive 503. A separate 16-entry connection queue also refuses overflow. Upgrade attempts share a burst of 32 and refill at two/second; identity requests have a separate burst of 32 and refill at four/second (429 on exhaustion). Budgets refill on requests, without timers; proxy peer addresses are not treated as separate users.
- A successful `hello` must finish within ten seconds of opening (1008), with at most 64 KiB cumulative input before success (1009). This bounds partial frames and pre-offered blobs before authentication. The timer is cleared on success or close; authenticated idle connections do not expire.
- A WebSocket message is at most 16 MiB plus framing overhead. The receive queue is capped at 64 messages and 32 MiB; overflow closes with 1009 and drops the queue. Reads are bounded rather than pretending that a WebSocket can pause.
- Gateway Wire limits: 16 MiB per blob, 32 MiB buffered blob bytes, 1 MiB outgoing JSON queue, ten-second blob inactivity and unclaimed TTL. These accommodate the 9,600,000-byte voice limit. Local socket Wire defaults stay unchanged.
- The HTTP listener has a ten-second idle timeout; WebSocket pings stay off. Before any HTTP request reaches `fetch`, Bun owns raw socket/header buffering. The application does not impose a global raw TCP connection cap. Authenticated RPC concurrency and zero-byte blob metadata also retain the shared Wire/RPC implementation's limits; see the review report.

## Exposure before HTTP

Every limit above starts once Bun hands the gateway a request. Before that, `Bun.serve` (1.4.4) has no maximum connection count and no total deadline for request headers; only the idle timeout applies, which a peer trickling one byte at a time resets. A peer that reaches the listener can therefore hold many unfinished connections, up to the process's descriptor limit (`rawHeaders.probe.ts` held 32 at once while the WebSocket cap is 16; trickling a byte a second, each closed after about 12 s).

What keeps such a peer out is who can reach the listener at all: it binds `127.0.0.1` only, so locally it is a process already running on the Host, and remotely it is a tailnet member that Tailscale's ACLs let reach this Host through `tailscale serve`. Keep those ACLs narrow. Polaris adds no proxy or polling of its own; the request to Bun for raw connection admission is tracked on ENG-421.

## Settings

`~/.polaris/daemon.json` is the Daemon's settings file; `{ "gateway": { "port": 7477 } }` is all it holds for now. `POLARIS_GATEWAY_PORT` overrides it (dev Daemons side by side; `0` asks for an ephemeral port, what tests and the benches use). A port that cannot be bound after three retries leaves the Daemon running without a gateway and a `no gateway:` warning in its log; `gateway.json` is then absent.

## Tests

`request.test.ts` (the checks), `config.test.ts` (settings, record, secret), `transport.test.ts` (a 1 MiB blob there and back through the real listener, a text frame), `gateway.slow.test.ts` (end to end against `startServer`: token and range required, mismatch messages, an Extension's Grant and actor, revoke cutting the connection, browsers refused, 1001 on stop, handshake expiry, voice-sized blob limits); `identity.test.ts` (challenge-response), `limits.slow.test.ts` (capacity, rate, message and body limits).
