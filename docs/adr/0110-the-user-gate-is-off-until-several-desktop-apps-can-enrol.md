---
status: accepted (ENG-926)
---

# The user gate is off until several Desktop Apps can enrol

## Context

ADR 0100 (ENG-700) gated user-only requests behind a Desktop App's user key, enrolled by trust on
first use: the first key a Host saw was the only one it accepted. Each Desktop App install has its
own key, so a Host used from two Desktop Apps locked one of them out. One Mac that is both a Host
and a Client, reached from a laptop as well, always hit it: the second Desktop App was refused
approvals, Turns and new agent sessions with "another one holds user access". Deleting
`~/.polaris/user-access.json` only moved the lockout to the other Desktop App.

## Decision

- The Daemon no longer gates user-only requests. `UserAccessGate` is provided as a gate that lets
  every request through, and `hello` answers `userAccess: true` to every token-less Client.
- The Daemon no longer reads or writes `~/.polaris/user-access.json`. A file left by 0.9.0 or
  0.9.1 is ignored.
- `polaris extension pair` and `polaris extension revoke` work from a terminal again.
- The protocol keeps `USER_RPCS`, `USER_COMMANDS`, `UserAccessRequired` and `hello`'s `userKey`, and
  the Desktop App keeps sending its key. Older Daemons still need the key, and ENG-927 reuses it.
- Extensions keep their Grants (ADR 0075, 0078) and Linked Devices their allowlist (ADR 0080).

## Consequences

ENG-700's hole is open again: a process with access to the Daemon socket, including an agent's
shell, can approve its own Pending Approvals. ENG-927 closes it again by letting a Desktop App that
already holds user access approve a new one. `packages/spec/user-access.qnt` describes ADR 0100's
gate, which the Daemon no longer runs. ENG-927 revises it.
