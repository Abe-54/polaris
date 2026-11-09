# Polaris

A native, GPU-rendered IDE and agent orchestrator (codename). It combines a code editor with a view for running and supervising coding agents across local and remote machines.

## Language

### Machines

**Host**:
A machine where code lives and agents run: the local Mac or a remote machine such as a Linux VM.
_Avoid_: Server, box, remote

**Daemon**:
The headless Polaris process running on a Host; it owns that Host's Agent Sessions, files, and language tooling.
_Avoid_: Backend, agent server

**Client**:
A user-facing Polaris front end (the Desktop App, and later the Mobile App) that connects to one or more Daemons.
_Avoid_: Frontend, UI

**Desktop App**:
The macOS Client: a single main window in which the user moves between orchestrating, reviewing, and editing across all connected Hosts.
_Avoid_: IDE window, workspace window

**Mobile App**:
The iPhone Client (a Linked Device): for starting, continuing, and supervising Agent Sessions on any of the user's Hosts away from the desk; it has no Editor.

**Linked Device**:
A Client the user links once through the Desktop App, after which it sees every Host the Desktop App knows; it reaches them through the Polaris Relay.
_Avoid_: Pairing (that is an Extension's), paired phone

**Polaris Relay**:
A service that a Host's Daemon and the user's Linked Devices both reach out to, so a phone can reach a Host on another network; it carries their end-to-end encrypted traffic and wakes the phone for notifications, and can read neither.
_Avoid_: Proxy, tunnel, server

**Extension**:
A program outside Polaris, written by the user or a third party, that reads and drives Daemons through the published SDK, such as a Raycast extension or a smart-glasses app; it can do only what the user allowed it.
_Avoid_: Plugin (that is a Harness's), add-on, integration

**Pairing**:
An Extension's link to one Host, made once by the user and revocable at any time; an Extension that sees several Hosts has one Pairing per Host.
_Avoid_: Connection (that is a Client's), login

**Grant**:
What a Pairing allows its Extension to do on that Host: read, approve, send Turns, start Agent Sessions, or use voice. Anything outside it is refused.
_Avoid_: Permission (that is a Harness's permission mode), scope

**Remote Access**:
A Host the user has made reachable from their other devices, over Tailscale (for Extensions) or the Polaris Relay (for Linked Devices); each route is off until the user turns it on.
_Avoid_: Port forwarding, tunnel

**Connection State**:
How a Client's link to one Host's Daemon stands right now: exactly one of Connected, Reconnecting, Needs Attention, or Offline; independent of any Session State on that Host.
_Avoid_: Status (unqualified), online/offline (as the only states)

**Connected**:
The Connection State in which the Client has a live link to the Host's Daemon.

**Reconnecting**:
The Connection State in which the link dropped and the Client is retrying on its own, without prompting, while showing the Host's last known state dimmed.
_Avoid_: Disconnected

**Needs Attention**:
The Connection State in which the Client cannot reconnect or install without the user, such as a changed host key, a password or 2FA prompt, or a first install awaiting approval; shown inline on the Host, never as a blocking dialog.
_Avoid_: Error, disconnected

**Offline**:
The Connection State of a Host the Client has stopped retrying, such as a machine that is shut down.

**Release**:
A published version of Polaris: one version number shared by the Desktop App and the Daemon builds it carries.
_Avoid_: Build (for a published version), drop

**Update**:
The Desktop App replacing itself with a newer Release.
_Avoid_: Upgrade (for the Desktop App)

**Daemon Upgrade**:
A Host's Daemon replaced by the build the Desktop App carries.
_Avoid_: Update (for a Daemon), reinstall

### Agents

**Harness**:
A third-party agent program (Claude Code, Codex, OpenCode) that performs agent work; Polaris drives Harnesses and never reimplements one.
_Avoid_: Agent runtime, backend

**Model**:
A language model a Harness offers to run on, named as that Harness names it; chosen when an Agent Session starts and changeable between Turns, and each Turn records the Model it ran on.
_Avoid_: LLM, provider (when meaning the model)

**Usage**:
The tokens, and the cost where known, consumed by Harness work on a Host, whether or not it ran in an Agent Session, grouped by Harness and Model; a cost the Harness did not report is an estimate, and subscription Usage is shown as its API-equivalent, never as money spent.
_Avoid_: Spend, billing, credits

**Plan Limit**:
A cap a provider's subscription puts on Usage over a time window (such as five hours or a week), shown as how much is used and when it resets; known only from what the Harness reports.
_Avoid_: Rate limit, quota, allowance

**Skill**:
A packaged set of instructions a Harness loads by name when asked (a `SKILL.md` folder for Claude Code and Codex); the user invokes one from the composer and it rides in the Turn.
_Avoid_: Plugin, tool (when meaning a Skill)

**Slash Command**:
A named action a Harness offers as `/name` (built in, the user's own, the Workspace's, or a plugin's); Polaris runs each the way the Harness expects: as Turn text, through the Harness's own call, as a Polaris action, or not at all when only its terminal UI can.
_Avoid_: Command (that is what a Client sends the Daemon), macro

**Workspace**:
A directory on a Host that the user has registered with Polaris, usually a git repository; Agent Sessions and Review Checkouts belong to one. It persists (hidden when idle) until the user removes it.
_Avoid_: Project, folder, repo (when meaning the registered directory)

**Agent Session**:
One durable conversation with one Harness in one Workspace, as supervised by Polaris; it outlives the Harness process and Daemon restarts, and never changes Harness.
_Avoid_: Thread, chat, run

**Worktree**:
A git worktree of a Workspace, tracked by Polaris wherever it lives on disk (whether Polaris, the user, or a Harness created it) and shown under the Agent Session that created it.

**Turn**:
One message from the user plus everything the Harness does in response; the unit that gets a checkpoint, a diff, and a Review.
_Avoid_: Step, exchange

**Tool Call**:
One use of a tool by an Agent Session within a Turn: a built-in tool, an MCP server's tool, or a Skill being loaded.
_Avoid_: Activity, step, action

**Secret Request**:
A request an Agent Session makes for a value the user types, such as an API key, kept out of the conversation and the event log; the agent receives a file path, never the value.
_Avoid_: Credential prompt, password question

**Tool Run**:
Consecutive finished Tool Calls in a Turn, shown as one summary line that expands to each call.
_Avoid_: Run (alone, which reads as an Agent Session), group, batch

**Visualization**:
An interactive page the agent writes during a Turn and the user uses in place in the conversation: a calculator, a flow chart, a comparison. It can't reach the network or message the agent. A later Visualization can replace it.
_Avoid_: Artifact, widget, render, canvas

**Goal**:
A standing objective one Agent Session's Harness pursues across Turns until it is met, paused or cleared, as with Codex's and Claude Code's `/goal`.
_Avoid_: Task (a Constellation's unit of work), objective, mission

**Fork**:
A new Agent Session started from a checkpoint of another, linked to its parent; the way to switch Harness or retry differently.

**Celestial**:
The celestial body that identifies one Agent Session, drawn in its Harness's hue and fixed for the session's life: a planet for most sessions, a star for a Constellation's Lead, a moon of its parent's for a Subagent. A Fork gets its own; no two active sessions in a Workspace share one.
_Avoid_: Avatar, icon, asterism, sigil

**Session State**:
Where an Agent Session stands right now: exactly one of Starting, Working, Needs You, Idle, In Terminal, Dormant, Failed, Limited, or Archived.
_Avoid_: Status (unqualified), phase

**Starting**:
The state of an Agent Session whose Harness process is being launched or resumed and cannot yet take a Turn.

**Working**:
The state of an Agent Session whose Harness is in the middle of a Turn.
_Avoid_: Running, busy, thinking

**Needs You**:
The state of an Agent Session whose Harness is blocked on the user, waiting for a permission grant or an answer.
_Avoid_: Waiting, pending, or Blocked as a Session State (Blocked is an Attempt state).

**Idle**:
The state of an Agent Session whose last Turn has finished while its Harness process is still running.
_Avoid_: Done, complete

**In Terminal**:
The state of an Agent Session the user has taken over in the Harness's own terminal UI; Polaris follows along but does not send Turns until the user hands it back.
_Avoid_: Detached, external

**Dormant**:
The state of an Agent Session whose Harness process is not running but which can be resumed on demand or automatically.

**Failed**:
The state of an Agent Session whose Harness process crashed or errored out of a Turn.
_Avoid_: Errored, dead

**Limited**:
The state of an Agent Session whose Harness stopped a Turn at a usage limit; the Turn is Interrupted, and Continue picks it up once the limit resets, or Polaris does if the user turned on Resume at reset.
_Avoid_: Rate limited, throttled, out of credits, or Failed for a usage limit

**Archived**:
The state of an Agent Session the user has put away after reviewing or merging its work, or that Polaris put away after it sat Dormant with no activity for the Host's auto-archive period; there is no "Done".
_Avoid_: Closed, deleted

### Constellations

**Constellation**:
A directed acyclic graph of Tasks owned by one orchestrating Agent Session, mapped by that session or the user, that says what work exists, in what order, and what must pass before it ships; a Workspace can have several at once.
_Avoid_: Plan, run, workflow, pipeline

**Lead**:
The Agent Session that owns a Constellation: it maps the Tasks, starts their Attempts, hears their outcomes and can hand the Constellation over to a new Lead.
_Avoid_: Orchestrator (that is the view), conductor, parent

**Worker**:
An Agent Session that carries a Constellation's Attempts and isn't its Lead. It belongs to its Constellation: session lists leave it out and reach it through its Lead, and it notifies the user only when it Needs You.
_Avoid_: Child session, subagent (that is a Harness's own helper)

**Task**:
A stable unit of work in a Constellation, with dependencies on other Tasks; it is carried out by one or more Attempts, and its state follows its latest Attempt.
_Avoid_: Job, step, ticket

**Parent**:
A Task that contains Tasks, nested to any depth. A Parent is a container with at least one non-canceled child; its state rolls up from its children, and it never carries an Attempt or acts as a Gate.

**Attempt**:
One try at a Task, carried out by one Agent Session and linked to the earlier Attempt it follows (for example, sent back after review); a retry is a new Attempt, never a rewrite of an old one. An Agent Session carries at most one active Attempt at a time, but may carry Attempts on several Tasks over its life.
_Avoid_: Retry, run

**Blocked**:
An Attempt waiting on other Tasks, or on the Lead when no Tasks are named. Acceptance of every named Task or a Lead message starts its next Turn. This is distinct from Needs You, the Session State for user input.

**Waiting on Background Work**:
A working Attempt whose worker ended its Turn with its own background work out: background tasks its Harness wakes it for, or a wait it declared with `waiting_on`. It is derived from the log, not a Session State or an Attempt state; it isn't stopped or stalled, nobody nudges it, and it never Needs You. It ends with the worker's next Turn or its Claim; if no Turn starts by the time the wait runs out, the worker is nudged as after any silent end.
_Avoid_: Blocked (that waits on Tasks or the Lead), idle

**Claim**:
A worker's typed statement that its Attempt is done, carrying its report (branch, head, checks run, what isn't done, questions); it puts the Attempt in review until the Lead or the user accepts it or sends it back.
_Avoid_: Report ready, done (a claim isn't done until it's accepted)

**Area**:
The paths a Task expects to change, declared so that overlapping work in the same Constellation is visible before it conflicts.
_Avoid_: Ownership, scope

**Gate**:
A Task that waits for several other Tasks to finish (fan-in), such as "tiles merged to main", before the Constellation moves on.
_Avoid_: Milestone, checkpoint

**Future**:
Intent for work not yet started. In Constellations v1, a pending Task proposal shows this intent; a mapped unstarted Task projects ready or waiting from its dependencies, without a separate Future state.

**Subagent**:
A helper a Harness spawns inside an Agent Session; Polaris shows it under its parent and lets the user view it on its own.

### Views

**Orchestrator**:
The view for launching, monitoring, and steering Agent Sessions.
_Avoid_: Dashboard, agent manager

**Review**:
The view for judging a set of changes (an open pull request or an Agent Session's work) before accepting it, guided by a Risk Summary.
_Avoid_: Code review panel, diff viewer

**Review Checkout**:
A separate worktree on the Host holding the changes under Review, so they can be run locally without touching the user's own working tree.
_Avoid_: Checkout, PR branch

**Risk Summary**:
A ranked set of Risk Findings for the change under Review, combining rules, classifiers, and an agent's judgement, pointing a human at what most needs their eyes.

**Risk Finding**:
One flagged location in a change, with its source (Rule, Classifier, or Agent), Severity, confidence, reason, and status (Open, Dismissed, Resolved).
_Avoid_: Issue, warning, comment

**Reviewer**:
The Harness and Model the user chooses to write the Agent part of every Risk Summary, set once in Settings and independent of the Harness that made the change.
_Avoid_: Review agent, review bot

**Classifier**:
A decision model that answers narrow, written questions about a change (does this hunk break this rule?) with typed answers and a confidence, never prose; it adds its own Risk Findings and may raise the Reviewer's, but never hides, lowers or demotes any Finding.
_Avoid_: Decision model, System One (in anything a user reads), judge

**Classifier Backend**:
The service a Classifier's questions go to (a hosted model, Cloudflare Workers AI, or a server the user runs themselves), chosen once in Settings; with none chosen there is no Classifier.
_Avoid_: Provider, engine

**Walkthrough**:
Polaris's read-only account of a change under Review, written by its own session beside the Reviewer: why the change, the few things to note, and an outline of only the views that explain it. Kept per head commit; a re-review adds a short one covering only the new commits.
_Avoid_: Summary (that is the Risk Summary), PR description

**Overview**:
The tab a Review opens on: a pull request's description, a review bot's pinned summary and the Walkthrough, or an Agent Session's prompts and the Walkthrough.
_Avoid_: Summary tab, details

**Severity**:
How bad a Risk Finding would be if real: exactly one of Critical, High, Medium, or Low; a Risk Summary ranks by Severity, then confidence.
_Avoid_: Priority, P0–P3 (in anything a user reads), level

**Critical**:
The Severity for secrets, security holes, and data loss; no Risk Memory may ever hide a Critical Finding. A secret is Critical when the scanner is confident it is a credential; its low-confidence generic matches (a word like "password" in a label) are Medium, so they can be dismissed.
_Avoid_: Blocker, P0

**High**:
The Severity for a likely bug or breaking change.

**Medium**:
The Severity for something worth a human's look, such as a risky pattern or hard-to-maintain code.

**Low**:
The Severity for nits, style, and unnecessary comments.
_Avoid_: Nit (as a Severity name), info

**Verdict**:
The user's thumbs-up or thumbs-down on a Risk Finding; a thumbs-down carries reason badges or free text and a scope (this change, this repo, everywhere), and Verdicts are what the reviewer learns from.
_Avoid_: Dismissal, feedback, rating

**Risk Memory**:
A scoped review instruction learned from Verdicts that only takes effect once the user approves it; kept either committed in the repo or privately on the Host.
_Avoid_: Learning, suppression rule

**Editor**:
The view for reading and editing code, including inline chat and tab completion.

**Edit Prediction**:
One change that tab completion suggests near the cursor (an insertion, replacement, deletion, import, or a jump to the next place to edit), shown before it is applied and applied only by the user accepting it.
_Avoid_: Next edit suggestion, NES, ghost edit, autocomplete

**Command Palette**:
The searchable list of every command in the Desktop App, opened with ⌘⇧P; a surface of its own, separate from the jump menu.
_Avoid_: Command menu, action bar

**Data**:
The view for browsing and querying the Data Sources of the selected Agent Session's checkout, and for inspecting the Queries its agents ran.
_Avoid_: SQL client, database view, DB tab

**Traces**:
The view for inspecting the Traces that code run in the selected Agent Session's checkout sent to Polaris, by its agents or by the user, and the Turns that produced them.
_Avoid_: Runtime view (Runtime is avoided for Harness), APM, observability tab

**Requests**:
The view for writing the Requests in the selected Agent Session's checkout, sending them from its Host, and inspecting the Sends that the user and its agents made.
_Avoid_: API client, Postman, HTTP tab

**Browser**:
An Agent Session's web browser in its Output, holding that session's own tabs, which the user and the session's agents (Subagents included) both use; its logins and cookies are shared across the Workspace.
_Avoid_: Preview (that is the Markdown or diff preview), webview, web tab

**Host address**:
A loopback URL opened in a Browser (`localhost`, any `*.localhost` name such as a Portless app, or a loopback IP), which always means the Agent Session's Host, never the machine the Client runs on; any other URL loads from the Client's own network.
_Avoid_: Forwarded port, tunnel, local URL

**Developer Mode**:
The setting that shows Polaris's own internals (its Self-Traces and its Daemon Sources) for the work of building Polaris itself; it is on or off for all of the user's Hosts at once. Off by default, but always on while a development build of Polaris is connected.
_Avoid_: Debug mode, dev mode

### Data

**Data Source**:
A database a checkout (a Worktree or the Workspace's own directory) can reach, found in its environment files, framework configuration or compose file, or added by the user. Agent Sessions in the same checkout share its Data Sources. An agent names a Data Source and never sees its credentials.
_Avoid_: Connection (that is Connection State), database URL, datasource, DB

**Local Data Source**:
A Data Source on the Host itself: a loopback or Unix-socket listener owned by a known database server, or a verified proxy for a compose database published from this checkout. Agents may read it without asking. Tunnels and unknown listener owners are Remote.

**Remote Data Source**:
Any Data Source that is not Local; no agent reaches it until it has a Data Source Approval, and no agent writes to it unless the user has also allowed writes there.

**Data Source Approval**:
The user's remembered, per-Host choice that lets agents read one Remote Data Source (its exact server, database and user) or every database on one server; a Data Source that starts pointing somewhere else needs a new one.
_Avoid_: Trust (that lets Polaris run a Workspace's code), allowlist

**Query**:
One SQL statement run against a Data Source, by the user in Data or by an agent through Polaris, recorded with who ran it and in which Turn.

**Query Log**:
The record of every Query against a checkout's Data Sources, attributed to its Agent Session and Turn, which the user can inspect and run again; agent queries that bypassed Polaris (a `psql` Tool Call) appear in it, marked as such.
_Avoid_: Query history (alone), audit log

**Schema Diff**:
What changed in the tables, columns and indexes of a Data Source an Agent Session used, between the start and end of a Turn; Review shows it beside the code that caused it, such as a migration.
_Avoid_: Migration diff, DDL diff

**Daemon Source**:
A Data Source over one of the Daemon's own databases on its Host, which can never be written to and exists only in Developer Mode.
_Avoid_: Internal database, state DB

### Traces

**Trace**:
The record of one operation through running code, such as an HTTP request or a test, made of Spans, sent to Polaris by code that runs with Polaris's endpoint.
_Avoid_: Request (that is a saved definition; an HTTP request in a Trace is a Span, and one made from Requests is a Send), log

**Span**:
One timed step of a Trace, with its attributes and the log records written during it; a Span whose operation failed is an error Span.
_Avoid_: Event (that is the event log's)

**Profile**:
A CPU profile of one process Polaris launched, recorded over a stretch of time and shown as a flame chart beside the Spans it overlaps.
_Avoid_: Flame graph (that is how a Profile is drawn), trace

**Self-Trace**:
A Trace that Polaris itself produced in the Daemon, the Desktop App or the Mobile App, sent while Developer Mode is on; it appears with the Traces of the Workspace that holds Polaris's own code, or under its own toggle when no such Workspace exists.
_Avoid_: Internal trace, Polaris telemetry

### Requests

**Request**:
A saved HTTP request (its method, URL, headers and body, with variables) kept in a `.http` file in the checkout; it describes what to send and has never happened.
_Avoid_: Call, endpoint, collection item

**Send**:
One execution of a Request from the checkout's Host, by the user or by an agent, with its response, its timing, who sent it and in which Turn, and the Trace it started.
_Avoid_: Request (that is the definition), call, run, execution

**Send Log**:
The record of every Send in a checkout, attributed to its Agent Session and Turn, which the user can inspect and send again.
_Avoid_: Request history, history

**Local Origin**:
An origin (scheme, host and port) on the Host itself: a loopback address or `*.localhost` name whose listener is not a known tunnel. Agents may send to it without asking.

**Remote Origin**:
Any origin that is not Local, including loopback listeners owned by a tunnel such as `ssh -L` or `kubectl port-forward`; no agent sends to it until it has an Origin Approval.

**Origin Approval**:
The user's remembered, per-Host choice that lets agents send to one Remote Origin, with writes (methods other than GET, HEAD and OPTIONS) allowed separately; Sends the user makes never need one.
_Avoid_: Allowlist, network approval, Trust

### Language tooling

**Language Integration**:
The Editor's configured support for one language, combining syntax highlighting with language servers and companion tools.
_Avoid_: Language plugin, language pack

**Trust**:
A user's remembered, per-Host choice that lets Polaris run a Workspace's own code: its tooling, plugins, and formatters for Language Integrations, and the setup command a worker's worktree runs before its first Turn. A Worktree inherits its Workspace's Trust, a Review Checkout never does. Language Integrations that run no Workspace code need no Trust.
_Avoid_: Workspace trust, checkout trust, execution trust, scoped trust

**Prerequisite**:
A runtime or toolchain on the Host that a Language Integration needs and Polaris does not provide, such as a Python interpreter or a Rust toolchain.
_Avoid_: Dependency, requirement
