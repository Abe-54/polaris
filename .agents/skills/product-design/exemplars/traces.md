# Exemplar: Traces

Status: proposed (owner, 2026-10-30: decisions grilled and mockups requested; not built)
Surface: Paper, "Traces (⌘5)" page: T1 "Waterfall", T2 "Profile under the
waterfall", T3 "Traces in Orchestrate", T4 "Setup". ENG-655.
Why exemplary: a debugging tool cut down to what helps an agent or helps you
audit one, with every object linking back into Edit, Data and Orchestrate.

## Decisions worth repeating

### Grouped by Turn, not by time alone
- What: traces sit under Turn kickers, "between turns · you" for the user's
  own; spans record the Turn they ran in and the Turn that started the process.
- Rules exercised: rule/context-is-quiet; rule/glossary-lowercase.
- Evidence: T1.
- Repeat when: listing anything agents produced over a session.

### Neutral bars, colour only for failure
- What: waterfall and flame frames are greys; only error spans are critical
  red, and a collapsed repeat count is tan. Selection is lightness, not hue.
- Rules exercised: rule/signals-are-rare; rule/colour-means-something.
- Evidence: T1, T2.
- Repeat when: any timeline or chart of agent work.

### Every object opens somewhere else
- What: a span opens its code (⌘3) or its query in Data (⌘4); a Tool Call chip
  opens its traces; ⌘L adds a trace, span or profile to an agent session.
- Evidence: T1, T3; owner: "without those links it's just a worse Jaeger".
- Repeat when: a new view's objects have a home in another view.

### Setup is handed to an agent
- What: the empty state installs a skill and starts an agent session rather
  than showing docs; a fixed exporter gets the one-line change and "Ask an
  agent to make this change".
- Evidence: T4; owner: "a preset skill that the agents can use... in one click".
- Repeat when: onboarding needs changes to the user's code.

## Scaffolding (not decisions)
The sample app (ledger, fx-rates, 214 lookups) is illustrative; T3's
conversation copy is a stand-in for the real conversation components.
