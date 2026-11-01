# Exemplar: Traces

Status: proposed (owner, 2026-10-30: decisions grilled and mockups requested; not built)
Surface: Paper, "Traces (⌘5)" page: T1 "Waterfall" (Axiom-aligned), T2 "Profile under the
waterfall", T3 "Traces in Orchestrate", T4 "Setup", T5 "Service map", T6 "Table". ENG-655.
Why exemplary: a debugging tool cut down to what helps an agent or helps you
audit one, with every object linking back into Edit, Data and Orchestrate.

## Decisions worth repeating

### Grouped by Turn, not by time alone
- What: traces sit under Turn kickers, "between turns · you" for the user's
  own; spans record the Turn they ran in and the Turn that started the process.
- Rules exercised: rule/context-is-quiet; rule/glossary-lowercase.
- Evidence: T1.
- Repeat when: listing anything agents produced over a session.

### Service hues from the series palette, failure stays critical
- What: waterfall bars take their service's colour from the series hues
  (the context-category set, apart from every signal), named wherever they
  appear; error spans stay critical, slowness is a badge, a collapsed repeat
  count is tan, flame frames stay grey.
- Rules exercised: rule/context-categories; rule/no-colour-alone;
  rule/signals-are-rare.
- Evidence: T1, T2; owner, 2026-10-30: "we should use different colors on
  the traces to represent each service".
- Repeat when: a chart needs categories that aren't signals.

### The service map borrows the Hosts card
- What: one trace's services drawn as the Hosts card's isometric servers and
  dashed connectors, a light in the service hue, inferred databases dashed,
  the agent's command and Turn as the caller.
- Evidence: T5; owner, 2026-10-30: "We can use the hosts diagram as
  reference for the service map".
- Repeat when: drawing what connects to what; reuse the Hosts art.

### Axiom's workflow, Polaris's colour
- What: the waterfall follows Axiom's trace view (minimap, start and end
  times, tree connectors with descendant-count badges, FAST/SLOW, a right
  span panel with Fields/Events/Links and a field filter) so the owner's
  habits carry over; service colours come from the series palette.
- Rules exercised: rule/signals-are-rare.
- Evidence: T1, T2; owner, 2026-10-30: "I'm pretty used to Axiom's OTel
  UI/UX. It would be nice to be more aligned with this workflow."
- Repeat when: a view has a tool its users already know well; borrow the
  workflow and layout, keep Polaris's tokens.

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
