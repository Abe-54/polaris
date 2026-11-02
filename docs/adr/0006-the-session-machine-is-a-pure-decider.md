# The session machine is a pure decider over the event log

Every Session State change goes through one XState statechart (`apps/daemon/src/engine/session.ts`), used as a pure decider and never as a live actor. For each input the Engine derives the machine snapshot from the session's folded record, runs one `transition`, commits the domain events it emits and then runs its effects. The transition's context update is `foldSession` of those same events.

## Why

The event log is the source of truth. A live actor would hold a second copy of each session's state that a restart loses and that can drift from what the log folds to. Deriving the snapshot from the folded record means a restart rebuilds exactly the machine state the session was in, by the same fold the read model already does, and the recorded `SessionStateChanged` and the machine's state cannot disagree (`session.test.ts` checks this for every reachable snapshot and input).

A statechart rather than hand-written `if (state === …)` checks gives one place for every guard and transition, a diagram that stays in step with the code, and model-based tests generated from the machine (`session.graph.slow.test.ts`) that replay every transition against the real Engine.

## Considered Options

- **A live actor per session.** Rejected: state outside the log, and a restart would need to rehydrate it anyway.
- **Ad-hoc checks in the decider and reactors.** What the Engine had before; the races it let through are listed in `apps/daemon/src/engine/README.md`.

## Consequences

- Snapshots are cached per record (`WeakMap`), so a record is resolved once; one decision costs about 10 µs, and deltas and item events never touch the machine.
- Anything that changes the lifecycle changes `session.ts`, its model (`session.testing.ts`), the counts in the README and the Mermaid diagram together.
