# Exemplar: Data

Status: proposed (owner, 2026-10-30: decisions grilled and mockups reviewed; not built)
Surface: Paper, "Data (⌘4)" page: D1 "Data · Table · Midnight", D2 "SQL tab · live
completion", D3 "Approvals", D4 "Data in Orchestrator and Review". ENG-643.
Why exemplary: shows how a borrowed tool (TablePlus) becomes a Polaris view by
adding what only Polaris knows: which agent, which Turn, which worktree.

## Decisions worth repeating

### Colour on the connection bar is the user's label
- What: a preset colour per Data Source, on the connection bar only, chosen
  from its click card; defaults local uncoloured, detected branch tan, remote red.
- Rules exercised: rule/data-source-label; rule/colour-means-something.
- Evidence: owner: "We can choose from preset colors so that it is
  distinguishable at a glance, not that the red should represent being
  unapproved for agents"; "By default, remote can show as red... a branch a la
  Planetscale... tan (sort of like a traffic light)."
- Repeat when: a user-named environment needs telling apart at a glance.

### Agents in the chrome, attributed everywhere
- What: "Agents in this worktree" in the sidebar, a Working strip over a table
  an agent reads, and a Query Log row per Query with its session and Turn;
  bypassing `psql` calls are logged and marked "outside Polaris".
- Rules exercised: rule/only-working-moves; rule/needs-you-is-loudest (the
  pending write row).
- Evidence: D1.
- Repeat when: any view over a resource agents also touch.

### Writes are approved on evidence, not on SQL
- What: an agent write shows a rolled-back dry run (count, before/after rows);
  the user's own grid edits stage in tan and only remote bulk commits confirm.
- Rules exercised: rule/git-is-a-letter (staged is modified tan);
  rule/buttons-where-you-click (the count is on the button).
- Evidence: D3; owner: "only showing up for bulk actions... small one-off
  changes... shouldn't need a confirmation."
- Repeat when: approving any destructive action an agent proposes.

### Loops into the other views, not a parallel app
- What: Output's Data tab beside Changes with "Open in Data ⌘4" (Terminal stays
  the bottom subpanel); Review's Data section with the Schema Diff beside the
  migration.
- Evidence: D4; owner: "Terminal is a smaller subpanel at the bottom, not a
  full panel of its own."
- Repeat when: a new view's facts belong in a Turn's outcome.

## Scaffolding (not decisions)
D2 lacks the connection bar and functions group D1 has; the sample data
(ledger, invoices, currencies) is illustrative.
