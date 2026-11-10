---
status: accepted
---

# Tailscale is the only way in from the network

## Context

The G2 app runs in the Even app on a phone, often away from the Mac, and Even Hub expects HTTPS
origins listed exactly in the app's manifest. Extensions authenticate with bearer tokens. The
alternatives were a plain-HTTP listener on the LAN (even-terminal's default), public tunnels
(ngrok, bore), or Tailscale.

## Decision

The gateway listens only on `127.0.0.1`. Remote Access runs
`tailscale serve --bg --https=443 --set-path /polaris http://127.0.0.1:<port>/polaris` (serve
strips the prefix, so the target names it again), which gives a
`https://<machine>.<tailnet>.ts.net/polaris` origin with an automatic certificate. The tailscale
module is adapted from T3 Code; it also finds the macOS app's bundled CLI.

## Consequences

- Tokens never cross a network in the clear, and nothing listens on the LAN.
- Remote Access needs Tailscale with HTTPS enabled for the tailnet; without it, only local
  Extensions work.
- `--set-path` shares port 443 with other HTTPS Serve paths (such as T3 Code), but enabling
  Serve clears Funnel for the entire listener. Polaris refuses enable with `funnel-on` when
  Funnel is on for this Host's port 443; it leaves the config alone and publishes no pairing
  URL. Turning off still removes only `/polaris` and its trailing-slash form, preserving
  other paths and their Funnel setting.
- A foreground Serve or background HTTP listener on port 443 blocks enable and disable with
  `port-in-use`; neither is rewritten or removed. Status is unavailable with this reason
  unless our proven gateway is already served at `/polaris`, in which case it stays on with
  its URL (Funnel still suppresses the URL).
- These guards read `serve status --json` and then run `serve` in a separate process, so they
  cover only the config Tailscale held at that read. A Funnel, foreground Serve or HTTP
  listener another CLI adds in between is not seen, and `serve` clears such a Funnel; the
  CLI's own config check starts after ours. Tailscale has no conditional update Polaris can
  use without replacing the user's whole Serve config, so concurrent edits of port 443 while
  turning Remote Access on are unsupported (ENG-422). Status reads back what Tailscale then
  serves. `remoteAccess.slow.test.ts` pins this race against the fake CLI.
- A file, text or trailing-slash handler at `/polaris` also counts as exposed. Unreadable
  Serve config is unavailable, never off.
- Remote Access serves only a gateway that answers a fresh challenge with the HMAC of
  `gateway.json`'s secret, and status reads what Tailscale actually serves, so a stale or foreign
  `/polaris` shows as exposed rather than off (ENG-400).
- Machine names appear in Certificate Transparency logs, as with any Tailscale HTTPS.
- Remote Access proxies to a port, so it checks the port is this Daemon's before serving it:
  the gateway writes a fresh private secret to `~/.polaris/gateway.json` at every start and
  proves it on `POST /polaris/identity` by HMAC-SHA256 over a fresh challenge. Both secret
  and challenge are decoded 32-byte base64url values; only the MAC is returned. A public
  nonce could be fetched and replayed by an impostor after the gateway stopped.
  See `apps/daemon/src/gateway/README.md` for limits and the verification contract.

Gateway proof requests refuse redirects: the recorded port itself must answer the challenge.
