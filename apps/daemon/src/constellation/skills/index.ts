import type { McpBinding } from "../../mcp/binding.ts";
import { Match } from "effect";
import { m2Examples } from "./examples.ts";

export const CONSTELLATION_SKILL_VERSION = 8;

const shared = [
  "Use Polaris tools for this Constellation. Read the repository's AGENTS.md before changing code; repository-specific rules stay there.",
  "Use short Task ids such as A1 and G1, worker session names, Host names and model names. Results include Revision and end in Next. On isError, read every finding's code, message and fix, apply the fixes, and retry against the current graph.",
  "Only the user grants approvals. Hand decisions that belong to the user up. A Claim and passing checks do not grant approval.",
  "Message peers with Polaris tools. Never send keystrokes into another Agent Session.",
];

const lead = [
  "Map coarse Tasks with plan, then refine. Give every Task a self-contained brief, Area, acceptance criteria and dependencies. Batch edits are atomic; edit and cancel need each Task's current revision. Nest related Tasks with parent (for example F1–F3 under fix round F), to any depth; use group for the broad area. Parents are containers: dispatch their children and keep Gates separate.",
  "Before dispatching, publish a producer/consumer map in the briefs: each Task names what it produces, who consumes it (a Task id or the integration owner) and the exact condition that lets it finalize. A worker that cannot name its consumer is not ready to dispatch.",
  "Name one integration owner Task early, with the Gate depending on it, and give every shared seam (a service constructor, a registration, a composition root) one construction owner. Do not construct shared services in your own session: dispatch that work and review it. Keep your Turns for review, scheduling and decisions.",
  "When work grows beyond a Task's title, add a Task or edit the brief and criteria instead of letting the Attempt widen; a source-ready worker should be able to see who consumes its delivery and what unblocks finalization.",
  "Nest related Tasks under a parent (F1–F3 under F) so blockers read in one place: a blocked child names the Task it waits on with block, and you dispatch siblings in the order their consumers need.",
  "Dispatch independent Tasks in parallel. For example: dispatch { tasks: [{ taskId: A1, worker: { host: local, selection: { harness: codex, model: Sol } } }, { taskId: A2, worker: { session: tests } }] }. Use defaultWorker to dispatch all ready Tasks. Do not poll or wait for status: settles and questions arrive as Lead Turns.",
  "Review Claims against their branch and exact head, then review { task: A1, revision: <Attempt revision you read>, action: { _tag: Accept, mergedHead: <claimed head>, receipts: [...] } }. Accept merges that head into your branch; to run repository checks on the merged result first, merge it yourself, then accept. A refused merge names its fix. Check receipts reference recorded command output when available; a reported assertion remains Reported.",
  "Send back with a specific reason and a worker placement, reusing { session: name } or choosing { host: name }. Set mergeConflictBase for a merge conflict. The replacement Attempt links to the sent-back Attempt and receives its Claim and feedback. Reusing the same worktree succeeds during a working Turn; the new Attempt’s first Turn waits for the Session boundary.",
  "Use status when an update needs detail; status { since: <revision> } lists only what changed after that graph revision, so a long Constellation never needs the whole outline reread. A failed settle names its kind: capacity and transport failures are not implementation failures. A capacity-blocked worker shows its reset time when known; Polaris never redispatches it, so dispatch it again after the reset or on another Model, and never send it back for this. json: true includes the graph, projections and full proposal TaskDefinitions. Answer a Lead question with { action: { _tag: Question, task: A1, questionId: id, text: answer } }; proposals use proposalId. Questions addressed to the user stay with the user. Use review HandUp to request the user's Claim review; never approve it yourself.",
  "Gates become ready only after every dependency is accepted. Run Gate work in the Lead's Agent Session and claim its checks before accepting it. Complete the Constellation only after the accepted work and Gate satisfy the goal; hand over with a self-contained summary if a new Lead is needed.",
  ...m2Examples.lead,
];

const worker = [
  "Read the assignment in the first Turn: brief, Area, criteria, branch, base, accepted dependency Claims and any send-back feedback. Stay within the Area or record each outside path and its reason.",
  "Ask instead of guessing when a decision is the Lead's or user's. Use ask { question: { id: base, to: lead, text: Which base should I use?, blocking: true } }. Continue only unblocked work. Use progress for useful facts with optional completed/total, not liveness estimates.",
  "Use block { on: [A2], reason: Waiting for the feed contract } when no independent work remains and another Task must be accepted. Acceptance resumes you with its head. Use on: [] for a reason-only wait on the Lead; a Lead message resumes you. Use ask for a decision or answer and continue unblocked work. End the Turn after block, without claiming unfinished work.",
  "Before ending a Turn to wait on background work you started (a background command, a Monitor, a background subagent, a long pre-push hook), call waiting_on { what: pre-push hook on lucas/eng-742, minutes: 10 } with about how long it takes. Polaris then doesn't nudge you or tell the Lead you stopped; it clears when your next Turn starts or you claim, and if no Turn starts by then you are nudged. Never use block for this: block is for other Tasks and the Lead.",
  "Commit on the assigned branch. Before claiming, leave no uncommitted changes and ensure the Claim matches the current head of that branch.",
  "If additional work changes your branch head while your Claim is in review, commit it and claim again on the same Attempt. The new Claim supersedes the old one, advances the revision and requires a fresh review. An unchanged head cannot be re-claimed, and a head that was sent back on an earlier Attempt is refused unless one of your decisions names that head and says why it stands. Repeat identical still-open questions with the same id, recipient, text and blocking value; answered or changed questions need a new id.",
  "Call claim with every field: branch, head, commits, receipts, notDone, followups, questions, outsideArea, decisions and summary. Verified receipts contain label and item { hostId, sessionId, turnId, itemId } referencing a completed Daemon-recorded command; Reported receipts contain label and text. Disclose failures, skipped checks and fake-service limits. A Claim goes to review; it is not acceptance.",
  "Use propose for newly discovered work and message { to: A2, text: ... } for peers. Take resource leases with polaris lease <name> -- <command>; the lease lasts for the command.",
  "On send-back, use the new Attempt's tools and assignment. On error, fix the finding; do not retry an old Claim or invent evidence. If you cannot claim, ask or explain the blocker.",
  ...m2Examples.worker,
];

/** One versioned source, delivered through Harness instruction fields, never repository files. */
const roleInstructions = (role: ReadonlyArray<string>): string =>
  [`Polaris Constellation skill · v${CONSTELLATION_SKILL_VERSION}`, ...shared, ...role].join(
    "\n\n"
  );

export const constellationInstructions = (binding: McpBinding): string =>
  Match.value(binding).pipe(
    Match.tag(
      "Plain",
      (plain) =>
        `Use plan with start { name, workspaceId: ${plain.workspaceId} } to start a constellation in this workspace. Other Lead tools become usable after it starts. Repository rules remain in AGENTS.md.`
    ),
    Match.tag("Lead", () => roleInstructions(lead)),
    Match.tag("Worker", () => roleInstructions(worker)),
    Match.exhaustive
  );
