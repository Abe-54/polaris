# The write approval card and Output's Data tab: screenshots (ENG-645)

OD's write approval card (Paper D3, DESIGN.md Data → In Orchestrate) and Output's Data tab, rendered
in Electron on fixtures (`node scripts/dataWriteScreens.ts --build --out <dir>` from `apps/desktop`;
scenes in `features/session/preview/dataWriteScene.ts`). 1440×900, Balanced unless named.

| Scene | What it shows |
|---|---|
| `write-card-{dark,light}` | A pending 214-row update on a local source: SQL, "$1 = 2026-01-01 · $2 = NULL", "Dry run · rolled back · 214 rows", "showing 20 of 214", before/after with changed cells in the diff colours and NULL faint, Why, "Deny and tell the agent why" and "Run 214-row update ⌘↵" |
| `write-settled-{dark,light}` | Turn 4's writes collapsed to one line each: ran, running, failed (with the database's error), "Denied: <reason>", "Expired: the turn ended before you answered" |
| `write-deny-{dark,light}` | Deny opened: the reason field, "A reason is required", Deny disabled until there is one |
| `write-worst-{dark,light}` | A 1,204,118-row update on a remote PlanetScale branch (tan top bar): long title, 40-line SQL folded with "Show the whole statement", 256 columns cut to the changed ones, huge cells, binary by length, NULLs |
| `write-insert-unpreviewed-{dark,light}` | An insert ("3 new rows", after only) and a write with no preview ("Not previewed: this table has triggers", "Run without preview") |
| `output-data-{dark,light}` | Output's Data tab beside Changes: the write card linked to its approval, the schema change with "Schema diff", "12 reads · Query log", "Open in Data ⌘4" on each |
| `write-card-dark-{calm,compact}` | The other densities |
| `write-card-light-cvd` | The colourblind diff palette |
| `output-data-dark-reduce-motion` | Reduce Motion |

The script also checks that a session whose Turn touched no data has no Data tab.
