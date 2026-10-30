# The Browser on the Daemon

The Browser runs in the Desktop App (ADR 0092); the Daemon hosts it for agents. This folder holds the hosting contract's Daemon side and the per-session CDP relay (ENG-616).

## The relay

`CdpRelay.layer({ home, version, port? })` serves one loopback WebSocket endpoint per Agent Session:

```
ws://127.0.0.1:<port>/browser/<sessionId>/<token>
```

`issue(sessionId)` returns the session's URL, minting a 256-bit token on first use and the same URL until `revoke(sessionId)`; it fails with `CdpSessionNotLive` for a session the Daemon doesn't know or has archived. Only the token's SHA-256 is stored (`browser-cdp.sqlite`, 0600, `relayStore.ts`), as `mcp/tokens.ts` does for the MCP server; a Daemon restart still authenticates issued tokens, but with `port` unset the port changes and the URL with it, so sessions must take a fresh URL after a restart. Archiving a session revokes its URL: the live `SessionStateChanged` event closes its sockets with 1008 and the path answers 401; a Daemon that was down for the archive sweeps its stored tokens against Session State at startup (`relaySessions.ts`); and every admission (discovery or upgrade) checks the session is still live, revoking on the spot if not.

Requests must arrive on `127.0.0.1` with no Origin or a same-host `http://127.0.0.1` one (403 otherwise), on a known path (404) with a live token (401). `/json/version` and `/json/list` under the token answer what agent-browser expects of a Chromium; `/json/list` is only the session's own tabs, as the Desktop App last reported them. Without a Desktop App they answer 503 with `NO_DESKTOP_APP_MESSAGE`.

Never log a relay URL: its path is the credential. The MCP side (`harness/browser`) hands it to agent-browser through a private per-session config file.

## A socket

Each agent WebSocket (`relaySocket.ts`) opens a `cdp` Browser stream through `BrowserHosting.open(sessionId, "cdp")`. While the stream opens, the agent's commands queue; if no Desktop App hosts the session, each queued command gets an error reply with `NO_DESKTOP_APP_MESSAGE` and the socket closes with 1011 and the same reason, so agent-browser shows the user the product copy.

Messages are re-serialized compactly at both ends (`@polaris/protocol` `cdpFraming.ts`): the byte stream carries one compact JSON message per `\n`, so a pretty-printed message from the agent is safe. Binary frames close the socket (1003); a frame that isn't a CDP message gets an error reply. The agent's side is bounded: 64 commands or 1 MiB held while the stream opens, 256 queued messages toward the Desktop App (1009 when full), 8 sockets per session and 64 per relay (1013 past that), and sends wait for the socket's backpressure to drain.

## Private vocabulary

The relay and the Desktop App's facade talk with two messages the agent never sees: the relay opens every stream with `Polaris.hello { tabs }`, the tabs it remembers for the session, so a Desktop App that takes the Browser over reopens them; the facade sends `Polaris.tabs { tabs }` after every change, which the relay remembers for `/json/list` and the next hello. `Polaris.*` from the agent is refused.

## Hosting

`hosting.ts` is the `BrowserHosting` service: which Desktop App connection hosts a session's Browser, and the byte streams to it. The relay only consumes `open` and `current`; the implementation is ENG-613's.

In the Daemon (`transport/serve.ts`) the relay is built under the Engine, because the Harness drivers hand sessions their relay URL, while the hosting the byte-stream handlers use needs `HostPresence`, which only the transport provides. `hostingSlot.ts` bridges the two: the relay gets `browserHostingSlot().layer`, whose calls wait for the hosting, and the handlers' layer composes `.bind`, which fills it with the instance they use. A call that arrives before the transport is up waits rather than failing `NoDesktopApp`.

`smoke.e2e.test.ts` runs the whole path with nothing faked but the Desktop App's window: agent-browser, the relay, `BrowserHosting` behind a real Daemon transport (`transport/byteStreamsHarness.ts`), byte streams over the local socket, and a stand-in Desktop App in Electron running the real `serveBrowserHost` and facade over a real `WebContentsView`. It needs Electron installed in `apps/desktop` and `AGENT_BROWSER_BIN`.
