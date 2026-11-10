---
status: accepted
---

# User-only RPCs need a Desktop-held user key

## Context

ENG-700: any process running as the user can connect to the local Daemon socket, and so can an
agent's Bash commands and their children. Before this change, such a process could send
`RespondToApproval` without a credential and approve its own Pending Approvals. That defeated the
approval gate for every Harness and Polaris MCP tool. The owner chose a middle option on
2026-11-09: user-only requests need a credential the Desktop App holds and no agent environment
ever carries.

## Decision

- **The user key.** Each Desktop App install makes a 32-byte master key and keeps it in
  `SecureStorage` as `user-access/key`. On Linux without a keyring, it lives in a 0600 file under
  `userData`. Each Host gets its own key, `HMAC(master, hostKey)`, where `hostKey` is the Desktop
  App's own name for the Host (`local`, the SSH alias), never one the Daemon reports. A key
  captured on one Host, for example by a replaced Daemon, opens no other Host. Renaming a Host's
  alias changes its key, so that Host needs recovery (below). The Desktop App sends the Host's
  key in `hello` (`userKey`). It never puts the key
  in an environment, and the Daemon never holds it in plaintext, so nothing in `childEnv` or a
  Harness, terminal or agent environment can leak it.
- **Enrolment is trust on first use.** The Host stores SHA-256 digests (bound to its `hostId`)
  in `~/.polaris/user-access.json` (0600). The first key it sees is enrolled. A later unknown key
  is not enrolled: its connection works, but `hello` answers `userAccess: false`. Unknown keys
  are never auto-enrolled, because any process could then enrol itself.
- **The user gate** (`UserAccessGate`, `transport/userAccess.ts`) runs in front of every handler.
  For a token-less connection without user access, it refuses with `UserAccessRequired` whatever
  `USER_RPCS` and `USER_COMMANDS` (`@polaris/protocol` `userAccess.ts`) mark `user`. Both tables
  are exhaustive, so a new RPC or Command fails typecheck until someone classifies it. Unknown
  tags count as `user`, so the gate fails closed.
- **Other Clients keep their own auth.** Extensions are decided by their Grant (ADR 0075, 0078),
  and Linked Devices by their allowlist over the Relay (ADR 0080). The user gate doesn't apply to
  either, including on the gateway.

### What is gated, and why

| Group | Gated | Why |
|---|---|---|
| Approvals | `dispatch:RespondToApproval`, `profiles.attach`, `profiles.restartWithProfiling`, `data.edits.commit`, `data.source.access` | These resolve, or stand in for, a decision the user is asked for. `profiles.*` share RespondToApproval's trust (ENG-657 UF14). |
| Escalation | `dispatch:SetPermissionMode`, `dispatch:StartSession`, `dispatch:SendTurn`, `dispatch:SendFeedback`, `dispatch:Steer`, `dispatch:Continue`, `dispatch:SetResumeAtReset`, `dispatch:Retry`, `dispatch:RunShellCommand` | Each one switches a session to a self-approving mode, makes another session (possibly a self-approving one) act on new input, or runs a command outside any approval. |
| New authority | `extensions.pair`, `extensions.revoke`, `remoteAccess.enable`, `remoteAccess.disable`, `relayRoute.enable`, `relayRoute.disable`, `devices.link`, `devices.awaitLink`, `devices.cancelLink`, `devices.add`, `devices.unlink` | A paired Extension with the approve Grant, or a linked "device", would be a second way to approve. Reach changes are the user's call. |
| Secrets | `secret.provide`, `voice.setKey`, `data.source.save`, `data.source.saveFile` | These answer a Secret Request or store a credential as the user. |
| Accepting work | `session.commitAccepted`, `session.pushAccepted` | They commit and push agent work under the user's name. |
| Trust | `languages.trust.set`, `languages.trust.change` | Trusting a checkout lets its own code run. |
| Terminals | `terminal.input` | A Harness in a terminal answers its own approval prompts from typed input. |
| Agent instructions | `traces.installSkill` | It writes a skill into every Harness's global config, which steers all future agents. |
| Constellations | `constellation.answer`, `constellation.review` | These are the user's answers and reviews. Leads and Workers act through the Polaris MCP tools in the Daemon, which never go through the socket. |
| Computer use | `computerUse.enable`, `computerUse.allowedApps.add`, `computerUse.openSetup`, `computerUse.preview.watch`, `computerUse.preview.latest` | Turning computer use on lets agents control apps on the Host, and an always-allowed app skips its app approval (ADR 0104, ENG-846). The preview shows the window a session drives, so another agent's shell could watch apps it was never approved for. `openSetup` puts System Settings and a Finder window on the user's screen. Status, the feed, `app`, turning it off and removing an app stay `any`: they read or narrow. A Linked Device still fetches `preview.latest` through its own allowlist. |

Everything else stays `any`: reads, the Daemon's own CLIs (`polaris lease`, `polaris
constellation stats`, `polaris extension list`), traces ingest, files, git, settings.

### The CLI

`polaris extension pair` and `polaris extension revoke` no longer work from a terminal. A
terminal holds no user key, and an agent running the CLI could otherwise pair itself an
Extension with the approve Grant. They print "pairing and revoking Extensions needs the Desktop
App: use Settings › Extensions", and the CLI's usage says so too. `polaris extension list` still
works. Headless Hosts pair from the Desktop App's Extensions page over SSH.

### Recovery

To move user access to another Desktop App, or after a lost key, delete
`~/.polaris/user-access.json` on the Host. The next Desktop App to connect with a key is
enrolled. Live connections keep what they held until they reconnect. A follow-up will let an
enrolled Desktop App approve another one.

## What this does not stop

This gate stops casual or accidental self-approval: an agent, a script it wrote, or a tool that
sends `RespondToApproval` over the socket. It does not stop a determined agent running as the
same user. Such a process can delete the enrolment file, restart the Daemon and enrol its own
key, or read the key file on Linux without a keyring. The Desktop App then loses user access,
which the user can see.

Trust on first use also leaves a window. A Host that no Desktop App has connected to since this
change enrols the first key-bearing Client, whatever it is.

The Daemon can't tell a same-user agent from the user. Closing these gaps needs an anchor
outside the user's reach (an OS-protected store with per-app ACLs, or a separate account for
agents), and that would be its own decision.

## Considered

- **Approvals are advisory against a same-user agent** (option 1). Rejected: one RPC defeats
  every gate.
- **Per-Client pairing on the local socket too** (option 2). This would give the same protection
  at more cost: every Client and CLI would pair, and the socket path would come out of every
  environment.
- **A token file the Daemon writes and the Desktop App reads.** Rejected: an agent reads it with
  one `cat`. A key that only the Desktop App holds forces the attacker to tamper with Polaris's
  state instead.
- **Deny by default for token-less connections.** Rejected for now: CLIs, traces ingest and
  `polaris lease` would all need keys. The exhaustive table gets the same per-RPC review.
