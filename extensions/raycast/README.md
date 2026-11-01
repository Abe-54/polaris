# Polaris for Raycast

Supervise your Polaris agent sessions from Raycast: see what needs you, approve or deny,
send turns, interrupt, and start agent sessions on any paired host. It is an Extension on
[`@polaris/sdk`](../../packages/sdk), so it can do only what its pairings allow.

## Pair it

In Polaris, open Settings → Extensions, pair Raycast with what it may do, and copy the
pairing string (`polaris-pair:v1:…`). In Raycast, run **Hosts** → Add Pairing and paste it.
Add one pairing per host; a host reached two ways (the Daemon's socket and its gateway) can
have both, tried in that order. Pairings are kept in Raycast's LocalStorage for this
extension, in its [encrypted database](https://developers.raycast.com/api-reference/storage).
Removing one in Raycast doesn't revoke it: revoke it in Polaris. Pairing strings are
never offered as clipboard actions; transport and validation errors redact credentials.

## Commands

| Command | |
|---|---|
| Search Agent Sessions | Sections Needs You, Working, Idle; Archived while you search. Accessories: session state, workspace, host, last turn. A host dropdown when more than one is paired. |
| Pending Approvals | Every approval waiting on you, oldest first, with what the agent wants to run. |
| Search Workspaces | New Agent Session ↵, Open in Polaris ⌘O, Show in Finder (hosts on this Mac), Copy Path ⌘⇧. |
| New Agent Session | Workspace, Harness, first turn (prefilled from the command's argument), permission mode, worktree branch. |
| Hosts | Each pairing with its Connection State: Connected, Reconnecting, Needs attention (revoked, version mismatch) or Offline. |

On an agent session: Open in Polaris ↵ (`polaris://session/<hostId>/<sessionId>`), Send Turn ⌘T,
Approve ⌘⇧A (Answer, for a question), Deny ⌘⇧D, Interrupt ⌘., Show Details ⌘D, Pin ⌘⇧P,
Copy Session ID ⌘⇧C. Pins stay in Raycast.

When no paired host can be reached, or its Polaris speaks another protocol version, a
command shows why instead of its list. A refusal names the Grant the pairing lacks
(“This pairing can't send turns”, pair again with “Send turns” on).

## Develop

The extension is a root workspace, so it resolves `@polaris/sdk` from source.

```sh
bun run --cwd extensions/raycast dev        # ray develop: load it into Raycast
bun run --cwd extensions/raycast ray:build  # bundle into extensions/raycast/dist and type-check
bun run --cwd extensions/raycast test       # the models, and against a real Daemon
bun run --cwd extensions/raycast e2e        # the release's project, built by ray, against a real Daemon
```

`e2e` is what the release runs before it attaches the zip: it installs the project as a
user would (the SDK from npm), builds it with `ray build`, and drives the built SDK under
Node through pairing, a session and its approval.

Before publishing a new SDK version, test the same project against its local tarball:

```sh
bun run --cwd packages/sdk pack
POLARIS_SDK_TARBALL="$PWD/packages/sdk/build/doellsoftware-polaris-sdk-0.2.0.tgz" bun run --cwd extensions/raycast e2e
```

The override installs that tarball under `@polaris/sdk`; without it, the project installs
from npm at the version in `packages/sdk/package.json`.

`src/lib/` is the model (sections, approvals, pairings, Connection State, copy) and has no
Raycast imports, so it runs under `bun test`; `src/lib/daemon.test.ts` drives it through the
SDK against `polaris serve` from source. Publishing to the Raycast Store waits for the SDK
on npm (ENG-420).

Send Turn appears only at a session's turn boundary, once approvals and worktree setup
have cleared. It does not queue or steer a turn already in progress. Grant refusals are
still checked by the Daemon and shown by name.

The Desktop deep-link integration test lives in `apps/desktop/src/shared/raycastLinks.test.ts`;
the extension has no dependency on the Desktop package. Store submission still needs the
workspace SDK dependency replaced by its published version and the development-only test
dependencies packaged separately. The live Raycast smoke is deferred to gate K (ENG-408).
