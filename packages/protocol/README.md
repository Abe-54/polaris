# @polaris/protocol

The wire contract every Client and the Daemon share: the Effect Schema domain (`domain.ts`, `review.ts`), persisted events (`events.ts`), Client commands (`commands.ts`), the `DaemonRpcs` group (`rpc.ts`), capabilities (`capabilities.ts`) and the frame codec (`frame.ts`, `wire.ts`). Names follow `CONTEXT.md`.

**Compatibility.** Changes are additive. A field added to something already in a Host's log decodes when absent (`addedNullable`, `addedArray`, or `optionalNullable` / `optionalArray` when constructors may leave it out too). A new event, command or RPC comes with a capability: a Client only sends a command or calls an RPC the Daemon announced, and the Daemon only sends an event to a Client that announced its capability (the Daemon's `eventCapability`). Unknown capability names are dropped on decode, so either side may be newer. `contract.test.ts` and `review.test.ts` hold both directions.

## Review

M2's Review (Linear ENG-217; decisions ENG-185, ENG-218–230). A Review judges one **subject** (`ReviewSubject`): an open pull request (`PullRequest`: the base repository, number and base branch), or an Agent Session's Turns (`SessionTurns`: one, a contiguous run, or all).

**Who owns what.** The Desktop App holds GitHub accounts and tokens and makes every GitHub call (pull request lists, pending reviews and their comments, Viewed state, submitting, merge and close detection); none of that crosses this protocol. The Daemon holds what lives on the Host: Review Checkouts (fetched with the Host's own git credentials), Rules and Reviewer runs, Risk Summaries, Verdicts, and accepting an Agent Session's Turns. So the Client tells the Daemon what it learned from GitHub (`OpenReviewCheckout`'s head and base, `ReportReviewHead`, `RemoveReviewCheckout` with `merged` / `closed`).

### Domain (`review.ts`)

| Type | What |
|---|---|
| `RepoRef`, `PullRequestRef`, `repoKey` | A GitHub (or GHE) repository and pull request; `repoKey` is the lowercase `host/owner/name` summaries and Verdicts are kept under. |
| `ReviewCheckout` | A detached, locked worktree at `<worktreeRoot>/.review/pr-<n>` (or `…/session-<id>`). `state`: `fetching` → `ready` ↔ `stale` → `fetching` …, `blocked` (`ReviewCheckoutBlock`: what was blocked and why: `Dirty`, `LocalCommits`, `InUse`, `ShallowClone`, `FetchFailed`), `removing`. `head` / `mergeBase` are what is checked out, `latestHead` / `latestBase` what the code host last reported, `reviewedHead` / `reviewedMergeBase` what the last Risk Summary covered ("only the new changes"). |
| `ReviewCheckoutStatus` | What `review.checkoutStatus` sees on disk: dirty paths, local commits, sessions and terminals inside, size. |
| `RiskFinding` | One flagged place: `source` (`rule`, `classifier` (M6), `agent`), `ruleId`, `path`, `lines` (`LineRange`, 1-based inclusive, `new` or `old` side), `severity` (`critical`, `high`, `medium`, `low`; `SEVERITY_RANK`), `confidence` 0–1, `title`, `reason`, `suggestion`, `status` (`open`, `dismissed`, `resolved`) and `resolution` (`withdrawn` by the Reviewer, or `fixed`: a later summary no longer finds it). `identity` is stable across commits: source, rule, file and a hash of the flagged code with its context, never line numbers. |
| `RiskSummary` | The Findings for one `RiskSummaryKey` (`repo`, `mergeBase`, `head`, and `since` for an incremental one), with each layer's `LayerRun` (`rules`, `agent`), the `ReviewerRun` (Harness, Model, effort, its own Agent Session), the cost line (`ReviewCost`) and a `note` ("Rules only: no Reviewer is available"). `rankFindings` orders them: Severity, confidence, rules before the agent. |
| `Verdict` | A thumbs-up or thumbs-down on a Finding, keyed by repo, with the `JudgedFinding` as it was (so learning never needs the summary), `reasons` (`false-positive`, `not-important`, `intended`, `already-handled`, `wrong-severity`, `out-of-scope`, `other`), `text`, `scope` (`change`, `repo`, `everywhere`) and the device. In M2 a thumbs-down only moves the Finding to Dismissed. |
| `ReviewContext` | A pull request's title and description, which the Client passes to `review.runRiskSummary` (the Daemon has no GitHub token). |
| `ReviewerChoice`, `ReviewerSettings`, `ResolvedReviewer` | Settings → Harnesses → Reviewer, kept on the Host: a default and per-Workspace overrides (Harness, Model, effort). `ResolvedReviewer` is what a Workspace's Reviews run: the override, else the default, else automatic (Claude Code Opus 5.5 high, else Codex GPT-6.1-Sol), else none (Rules only, with a `note`). |
| `FeedbackBatch`, `FeedbackComment`, `feedbackPrompt` | Comments on an Agent Session's diff, sent as one Turn: the message, then each comment as `path:lines`, the quoted code and the note. Drafts stay in the Client until sent; the sent batch is kept on its `Turn` (`Turn.feedback`), which is how the diff marks a comment "sent with Turn N". |

Additions to existing types: `AgentSession.acceptedThroughIndex` and `AgentSession.pullRequest`, `Turn.feedback`, `SessionPlacement.ReviewCheckout` (the Reviewer's own session works in a Review Checkout), `review.runRiskSummary`'s `context`, `HostStreamItem.Snapshot.reviewCheckouts`, `git.diff`'s `fileIndex` and its `Turns` spec.

### Commands, events, RPCs

| Capability | Commands | Events | RPCs |
|---|---|---|---|
| `session.feedback` | `SendFeedback` | (a `TurnStarted` whose Turn has `feedback`) | |
| `session.accept` | `AcceptTurns` (through a Turn; refused with a Turn in flight or before one already accepted), `LinkPullRequest` | `TurnsAccepted`, `TurnsReverted`, `SessionPullRequestLinked` | `session.acceptPlan` (the not yet committed Turns through one, the branch, default branch and remote), `session.draftAccept` (the commit message and pull request text, drafted by the session's own Harness, else a template), `session.commitAccepted` (commits only those Turns' own changes, onto the current branch or a new one; `AcceptRefused` until they're accepted), `session.pushAccepted` (the Host's git credentials) — types in `accept.ts` |
| `review.checkouts` | `OpenReviewCheckout`, `ReportReviewHead`, `UpdateReviewCheckout`, `RemoveReviewCheckout` | `ReviewCheckoutOpened`, `ReviewCheckoutChanged`, `ReviewCheckoutRemoved` (the whole checkout each time; on the Host stream) | `review.checkoutStatus` |
| `review.risk-summary` | | `RiskSummaryStarted`, `RiskSummaryLayerChanged`, `RiskFindingsRecorded`, `RiskFindingResolved`, `RiskSummaryEnded` (review-only: off the Host stream) | `review.runRiskSummary`, `review.riskSummary`, `review.watchRiskSummary` |
| `review.ask` | | | `review.askFinding` (continues the Reviewer's Agent Session) |
| `review.reviewer-settings` | | | `review.reviewerSettings` (the settings and the Reviewer a Workspace would run), `review.setReviewerSettings` |
| `review.verdicts` | `RecordVerdict` | `VerdictRecorded` (review-only) | `review.verdicts` |
| `review.latest-summary` | | | `review.riskSummary` by `RiskSummaryRef.LatestAt` (`repo`, `head`): the newest summary at that head, incremental ones included (the PR list's risk lane) |
| `session.accept-latest` | | | `session.acceptPlan` with `throughTurnId: null`: through the latest Turn (the PR list's changes for a ready Agent Session) |
| `git.diff-files` | | | `git.diff`'s `fileIndex`: each file's byte range in the patch, status and counts, for parsing in batches and very large Reviews |
| `git.diff-turns` | | | `git.diff` with `GitDiffSpec.Turns`: a run of Turns, first before-checkpoint to last after-checkpoint |
| `git.show` | | | `git.show`: a file at a revision (Pierre's context expansion) |

Daemon-side events with no command (the Checkout, Rules and Reviewer modules commit them): `ReviewCheckoutChanged` after a fetch or a blocked update or removal, `ReviewCheckoutRemoved`, every Risk Summary event, `TurnsReverted` (after `AcceptTurns` with `revertLaterTurns`).

**Accepting ends in a pull request** (ENG-224): the Client accepts (`AcceptTurns`), commits and pushes through the Daemon, opens the pull request itself as the routed GitHub account, then sends `LinkPullRequest`. Its Turns are committed once each (the Daemon marks them under `refs/polaris/committed/`), so later Turns, e.g. from the pull request's review comments, commit and push onto the same branch.

### Extensions (`extensions.ts`, `grants.ts`, `hello.ts`)

Capability `extensions` (ENG-398, ADR 0075 and 0078). `hello` takes an optional `extensionToken` (`pol_ext_` and base64url of 32 bytes); with a valid one the connection acts as that Pairing, within its Grant, and an invalid or revoked one fails `hello` with `ExtensionTokenRejected`. `extensions.pair({ name, grant })` returns the Pairing and its token once; `extensions.list`; `extensions.revoke({ id })` closes the Pairing's live connections. A Grant is a set of `read | approve | turn | start | voice`. `RPC_GRANTS` and `COMMAND_GRANTS` map every RPC and `dispatch` Command to what it needs (exhaustive by type); `decideAccess` is the rule (a `StartSession` that is not `supervised` also needs `approve`), and `NotGranted` the refusal, naming the missing Grant (null for what is not available to Extensions). `ExtensionDaemonRpcs` is `DaemonRpcs` with that refusal in every RPC's error type, for the SDK. `SessionCreated`, `TurnStarted` and `ApprovalResolved` carry an optional `actor` (`Client`, or `Extension` with its Pairing id and name).

### Remote Access (`remoteAccess.ts`)

Capability `remote-access` (ENG-400, ADR 0076). `remoteAccess.status` answers `RemoteAccessStatus`: `state` (`on | off | unavailable`), `url` (`wss://<machine>.<tailnet>.ts.net/polaris/rpc`, null unless on), `hostName` (the MagicDNS name) and `reason` when unavailable (`not-installed | not-running | not-logged-in | https-disabled | needs-operator | failed`) or when no gateway answered its nonce (`gateway-not-running`, off; on with a null `url` when `/polaris` is still served) or `/polaris` is served to anything but the running gateway (`serving-elsewhere`, on with a null `url`). Status reads what Tailscale serves, so an exposed path never reads as off. `remoteAccess.enable` and `remoteAccess.disable` answer the new status or fail with `RemoteAccessError` naming the reason. All three are for token-less Clients only.

### Computer use (`computerUse.ts`, `computerUsePolicy.ts`)

Capabilities `computer-use` and `computer-use.preview` (ENG-846, ADR 0107). [`computer-use.md`](./computer-use.md) is the contract other work builds against: each Host's status and its feed (`computerUse.status`, `watch`, `enable`, `disable`, `openSetup`), the `app` and `headed-input` ApprovalKinds with `ApprovalRequest.app`, the always-allowed list (`computerUse.allowedApps`, `removeAllowedApp`, `allowedApps.add`), the preview (`computerUse.preview.watch`, `preview.latest`), `ToolCall.computerUse`, and the policy as pure functions (`decideAppUse` and what changes an `AppPolicy`). The Daemon answers all of it `Unsupported` until each part lands.

### Status

On `m2/protocol`: the Daemon records every command above (the checkout machine and the session machine decide them), folds and persists the events, serves `review.riskSummary`, `review.watchRiskSummary` and `review.verdicts` from the store, `git.show`, `fileIndex` and `Turns` diffs, and gates events per Client. It announces `session.feedback`, `review.verdicts`, `git.diff-files`, `git.diff-turns` and `git.show`. Still answering `Unsupported`, with TODO owners in the code: `review.checkoutStatus` and the checkout reactors (M2-C), `review.runRiskSummary` (M2-R, M2-V), `review.askFinding` (M2-V), and `revertLaterTurns` (M2-A). Each slice announces its capability once it lands.

On `m2/reviewer` (M2-V): `review.runRiskSummary`, `review.askFinding` and the Reviewer settings are served by `apps/daemon/src/reviewer/`; the Daemon announces `review.risk-summary`, `review.ask` and `review.reviewer-settings`.

### Requests (`requests.ts`)

Capability `requests` (ENG-809, ADR 0098), announced once the Daemon serves it; until then every RPC answers `Unsupported`. Every RPC acts on the checkout of its `sessionId`. Domain: `HttpRequest` (a saved Request, `{{variables}}` unresolved, `RequestRef` `{file, name}`), `AdHocRequest` (no file), `RequestFile` (`path`, `requests`, `parseErrors`), `RequestsSnapshot` (files and the environment names of `http-client.env.json`), `ResolvedVariable` (`value` only when not `masked`, `origin` `local | remote` for a URL-valued one, `file` the `.env` file a `dotenv` value came from), and `Send` (masked URL and request headers, response capped at `SEND_BODY_CAP_BYTES` with `responseTruncated`, `traceId`, `by`: `SendAuthor`, `outcome`: `ok | http-error | refused | timeout | denied | failed`). `RequestTarget` is `Saved` (a ref) or `Inline` (an `AdHocRequest`). Errors are `RequestsError` (`code`, `message`, `fix`).

RPCs (`RequestsRpcs`): `requests.watch` (stream of `RequestsSnapshot`), `requests.save`, `requests.send` (the user's Send, never gated), `requests.variables` (a target's variables in an environment), `requests.sendLog.page` (cursor `before`, `filter`), `requests.sendLog.watch` (latest 100), `requests.send.get` (`SendLookup`: `ById` or `ByTrace`), `requests.curl.parse` and `requests.curl.format` (secrets masked). All are Desktop-only (`client` in `RPC_GRANTS`, `local` in `DEVICE_RPCS`).

An agent's Send to a Remote Origin asks with `ApprovalRequest.origin` (`OriginApproval`: `origin`, `variable`, `environment`, `method`, `path`, `write`, `tokenSource`); the user answers `Allow` with `originScope` (`reads | reads-and-writes`, absent means `reads`).
