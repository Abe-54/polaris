# Data U0 + U1 fix round: screenshots (ENG-644)

UF1's fixes for [RU1's findings](../2026-10-30-data-U1.md), rendered in Electron through the fixture
Layer (`node scripts/dataSidebarScreens.ts --build --densities balanced --scenes …` from
`apps/desktop`), at Balanced in Midnight and light. 1440×900 unless noted.

| Scene | Finding | What it shows |
|---|---|---|
| `worst` | F6, F7, F12 | The bar's access words in text-subtle on a blue label; the capped kicker; RTL names in the tree |
| `card` | F1, F8, F16 | The instrument card; label text kept as typed, uppercase on screen |
| `narrow` (760×600) | F6, F7 | A 40-character red label on an unapproved remote: the kicker truncates, the access keeps "Not approved" |
| `manual` | F16 | Remove on a source the user added, confirmed in place with Cancel focused |
| `edit` | F16 | Edit with "Remove saved password" chosen |
| `name` | F5 | "Billing DB" refused in the form with the Daemon's rule |
| `gone` | F4 | A SQL tab whose source isn't listed: "Not in this checkout", no label colour |
| `params` | F3 | A re-run's params in the run bar, with Unbind |
| `keys` | F10 | The tree after Home and ↓↓↓: one row focused, the focus ring on it |
| `log` | F13 | The Query log with the outside-Polaris row keeping its source |
