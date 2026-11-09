# Exemplar: Requests

Status: proposed (owner, 2026-11-09: decisions grilled, Q1–Q3 approved; not built)
Surface: Paper, "Requests (⌘6)" page: Q1 "Send with trace and data", Q2 "Send log,
an agent's failed send", Q3 "States". ENG-809.
Why exemplary: a familiar tool (Postman) cut down to the part that links into
Polaris's other views, so each send ends in a trace and the data it touched.

## Decisions worth repeating

### The answer sits beside the request
- What: the send pane stacks the response, a mini waterfall of the send's
  trace and the tables it touched, each with its "Open in …" shortcut.
- Evidence: Q1, Q2; owner: "native integration into these other two views
  is the distinguishing factor".
- Repeat when: an action produces something another view explains.

### A long list gets its own tab
- What: the send log is a sidebar tab (`Requests | Send log`), as Traces |
  Profiles, rather than a section squeezed under the requests.
- Evidence: Q2; owner, 2026-11-09: "the requests section is too small and
  hard to use if you have many requests".
- Repeat when: two lists compete for one sidebar.

### Approvals pre-select what the pending action needs
- What: the Origin Approval card reuses Data's anatomy and pre-selects
  "Reads and writes" when the waiting send is a POST, saying that Reads
  only denies it.
- Rules exercised: rule/glossary-lowercase ("this send is a POST").
- Evidence: Q3; owner, 2026-11-09: "Reads and writes make sense".
- Repeat when: an approval's scope choice would otherwise silently refuse
  the action that raised it.

### Failure states hand off
- What: no spans → "Ask an agent to add tracing"; connection refused →
  "Send again" and "Open a terminal"; no files → "Ask an agent to write
  requests for this app's routes" first.
- Evidence: Q3; follows Traces T4.
- Repeat when: the fix is a change to the user's code or a running process.
