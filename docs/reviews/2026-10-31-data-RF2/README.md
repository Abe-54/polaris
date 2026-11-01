# RF2 screenshots (ENG-645)

The RRV fix round on the preview fixtures at 1440 × 900, in both themes and all three densities
(`<state>-<theme>-<density>.png`).

| File | Shows |
|---|---|
| `write-card-*` | A pending update: the dry-run kicker, and Run as the primary button |
| `write-settled-*` | Ran, running, failed, denied, outcome unknown (icon, copy, Open in Data), expired by Stop (F5, F6) |
| `write-worst-*` | The 1,204,118-row update on the tan PlanetScale branch, with notes from the typed facts (F8) |
| `write-insert-*` | An insert whose serial `id` reads "assigned on run", with the skipped-IDs note (F8, F9) |
| `write-unpreviewed-*` | Not previewed: its own kicker and warning, and a secondary Run without preview (F1, F4) |
| `write-credential-*` | A password reset: the credential cell reads "redacted · changed" in the diff colours (F3) |
| `output-data-*` | The Data tab: outcome unknown with its icon, an expired write that says why, ⌘4 only in the tooltip (F5, F6, F15) |
| `review-worst-*` | The files list: "Schema diff" at full width, rows read "matched" and "est." (F10, F14) |
| `review-worst-end-*` | The files list scrolled to its end, stopping above the moon (F17) |

Taken by `node apps/desktop/scripts/dataWriteScreens.ts --out …` and
`node apps/desktop/scripts/reviewSchemaScreens.ts --out … --rf2`.
