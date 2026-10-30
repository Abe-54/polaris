---
status: accepted (owner, 2026-10-30; built in ENG-612)
---

# Host addresses travel in the Polaris protocol, not over SSH forwarding

## Context

A Browser on one machine must open Host addresses (`localhost`, `*.localhost` such as Portless
apps, loopback IPs) on another. The SSH transport clears all forwardings by design, and Hosts
are also reached over WSL, Windows pipes, and later the Polaris Relay for Linked Devices.

## Decision

A remote Host's Browser partitions send Host addresses (bypass rules with `<-loopback>`;
Chromium never runs a PAC script for loopback) to an HTTP proxy on 127.0.0.1 in the Desktop
App's main process. The proxy requires a per-launch secret, which Electron's `login` event
supplies for that Host's partitions only, so no other local process can use it to reach the
Host's loopback; if the proxy is down, Host addresses fail closed. Each proxied connection becomes a byte stream in the Polaris protocol that the Daemon
opens to its own loopback, passing the hostname through unresolved so Portless can route by
SNI and Host header. The page keeps its origin (`localhost:3000`, `https://app.localhost`), so
cookies, OAuth redirects and HMR WebSockets keep working. A Host address accepts any TLS
certificate: its bytes travel only over Polaris's authenticated link and the Host's loopback.

## Considered Options

- A PAC script sending Host addresses to the proxy: Chromium resolves loopback `DIRECT`
  before any PAC script runs (checked in Electron 44).
- An unauthenticated SOCKS5 proxy (the first design): any local process could tunnel into the
  Host's loopback, and Chromium cannot send SOCKS5 credentials.
- SSH dynamic forwarding (`-O forward -D`) on the private ControlMaster: a free SOCKS5 proxy,
  but SSH Hosts only, and it reverses the "no forwardings" stance of `packages/client/src/ssh.ts`.
- Rewriting Host addresses to local forwarded ports: changes the origin and breaks cookies and
  OAuth redirects.
- Trusting each Host's dev CAs (Portless, mkcert) in the partition: tool-specific, and adds
  nothing on this path.

## Consequences

- Page traffic shares the Client's connection to the Daemon with RPC frames; a large HMR
  reload must be benchmarked for head-of-line delay before this ships.
- The same stream carries over to the Polaris Relay when the Mobile App gets a Browser.
- Non-Host URLs in a remote Host's partition skip the system proxy, as PAC `DIRECT` would.
- Names a Host's `/etc/hosts` maps to loopback (Portless `.test`, custom domains) are not Host
  addresses yet.
