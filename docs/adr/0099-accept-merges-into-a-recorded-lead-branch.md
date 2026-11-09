---
status: accepted
fixes: Accepting a Claim merges into whatever branch the Lead's shared checkout has (ENG-610)
---

# Accept merges into a recorded lead branch

## Context

Accept merged the claimed head into the Lead's checkout's current branch (`constellation/merge.ts`).
The Lead's checkout is usually the Workspace root, which other Agent Sessions share and switch
between branches. On 2026-10-30 an Accept landed on another session's feature branch, which was
then merged into local `main`; the next Accept was refused only because that checkout happened
to be dirty. Gates ran in the same checkout, and new worker branches started from its `HEAD`,
so they verified and built on whatever branch it had too.

## Decision

A Constellation records its lead branch (`Constellation.leadBranch`): the branch the Lead's
checkout is on when a Plan starts the graph, read in the runtime's preparation and passed to the
pure decider through its context. Nothing changes it afterwards.

Accept merges the claimed head into the checkout that holds the lead branch
(`constellation/leadCheckout.ts`):

- a worktree already on the lead branch (often the Lead's own checkout), because git checks a
  branch out in one worktree only and moving the ref under it would corrupt its index;
- otherwise a Daemon-owned worktree at `<Lead checkout>.worktrees/<Constellation>/@lead`, added
  on the lead branch when missing and switched back to it if it was moved.

The merge's checks are unchanged (no hooks, refuses on a dirty, detached or mid-merge checkout
or a conflict, ADR 0068 for signing). A deleted lead branch refuses with `E-LEAD-BRANCH`, a
directory git doesn't know at the lead worktree's path with `E-LEAD-WORKTREE`.

The same checkout hosts a Gate's session, a worker's default base is the lead branch, and
worktree cleanup checks that work is merged into the lead branch rather than the Lead's `HEAD`.

A graph started before the lead branch was recorded, or whose Lead checkout was detached at
start, keeps the earlier behaviour: its Lead's checkout and current branch.

## Consequences

- An Accept never moves the Workspace root's branch unless that branch is the lead branch.
- The lead worktree stays until the user removes it; Polaris doesn't clean it up yet.
- The Quint spec leaves git out of Accept (the merge is runtime preparation), so it is
  unchanged; its README's mapping names where the merge lands.
