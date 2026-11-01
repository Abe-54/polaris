# Review's Data section and Schema Diff: screenshots (ENG-645)

RV's Review Data section (Paper D4, DESIGN.md Data → In Review), rendered in Electron on fixtures
(`node scripts/reviewSchemaScreens.ts --build --out <dir>` from `apps/desktop`; scenes in
`features/review/preview/schemaScenes.ts`). 1440×900, Balanced unless named.

| Scene | What it shows |
|---|---|
| `session-data-{dark,light}` | "Data · app" right after the Prisma migration with "+1 ~1 →1 −1" and rows per table; the body: added, changed, renamed and removed tables with columns, an index and a constraint before → after; the rows card with exact (split by agents and you), estimate and unknown |
| `session-data-diff-{dark,light}` | The diff with the migration's header link "Schema diff" |
| `session-data-worst-{dark,light}` | 240 tables on a long-named source: truncated note, previous-turn-end baseline, long names truncating, 30 tables then "Show 210 more tables", five rows then "+ N more tables" |
| `session-data-pending-{dark,light}` | "Capturing schema…" in the body, "capturing…" in the list |
| `session-data-unavailable-{dark,light}` | Why: no snapshot at the start of the turn |
| `session-data-dark-{calm,compact}` | The other densities |
| `session-data-light-cvd` | The colourblind diff palette |
| `session-data-unsupported-dark` | A Daemon without `data.schemaDiff`: no Data section |
