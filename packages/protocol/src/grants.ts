/**
 * What each RPC and each `dispatch` Command needs from an Extension's Grant
 * (ADR 0075): both maps are exhaustive over `DaemonRpcs` and `Command`, so a
 * new RPC or Command without an entry fails typecheck. A token-less Client is
 * never refused. `decideAccess` gates the request; `decideTurnAccess` checks
 * the current Session mode inside the Engine commit.
 */
import type { RpcGroup } from "effect/rpc";
import { Command } from "./commands.ts";
import { type Grant, type GrantKind, NotGranted, type Pairing } from "./extensions.ts";
import type { DaemonRpcs } from "./rpc.ts";

export type DaemonRpcTag = RpcGroup.Rpcs<typeof DaemonRpcs>["_tag"];

/**
 * `open`: any connection, even before it is scoped. `client`: token-less Clients
 * only (not available to Extensions in 0.3.0). A Grant: Extensions holding it.
 */
export type RpcAccess = GrantKind | "open" | "client";

export type CommandAccess = GrantKind | "client";

export const COMMAND_GRANTS = {
  RegisterWorkspace: "client",
  SetWorktreeSetup: "client",
  SetWorkspaceHidden: "client",
  RemoveWorkspace: "client",
  StartSession: "start",
  SendTurn: "turn",
  RunShellCommand: "client",
  CompactSession: "client",
  Steer: "turn",
  Interrupt: "turn",
  StopBackgroundTasks: "client",
  BackgroundCommand: "client",
  Continue: "turn",
  Retry: "turn",
  RespondToApproval: "approve",
  RenameSession: "client",
  PinSession: "client",
  SetResumeAtReset: "client",
  SetPermissionMode: "client",
  SetModel: "client",
  ForkSession: "client",
  ArchiveSession: "client",
  UnarchiveSession: "client",
  OpenInTerminal: "client",
  ReturnFromTerminal: "client",
  SendFeedback: "client",
  AcceptTurns: "client",
  LinkPullRequest: "client",
  OpenReviewCheckout: "client",
  ReportReviewHead: "client",
  UpdateReviewCheckout: "client",
  RemoveReviewCheckout: "client",
  RecordVerdict: "client",
} as const satisfies Record<Command["_tag"], CommandAccess>;

/** `dispatch` itself is decided per Command (`COMMAND_GRANTS`). */
export const RPC_GRANTS = {
  hello: "open",
  dispatch: "open",
  subscribeHost: "read",
  subscribeSession: "read",
  "session.turns": "read",
  "session.terminalCommand": "client",
  "harness.models": "read",
  "harness.commands": "read",
  "harness.spinnerVerbs": "read",
  "harness.availability": "read",
  "harness.watchAvailability": "read",
  "usage.query": "read",
  "usage.watch": "read",
  "extensions.pair": "client",
  "extensions.list": "client",
  "extensions.revoke": "client",
  "remoteAccess.status": "client",
  "remoteAccess.enable": "client",
  "remoteAccess.disable": "client",
  "host.restartPreview": "client",
  "host.prepareRestart": "client",
  "relayRoute.status": "client",
  "relayRoute.enable": "client",
  "relayRoute.disable": "client",
  "devices.link": "client",
  "devices.awaitLink": "client",
  "devices.cancelLink": "client",
  "devices.add": "client",
  "devices.list": "client",
  "devices.unlink": "client",
  "devices.unlinkSelf": "client",
  "devices.registerPush": "client",
  "devices.unregisterPush": "client",
  "devices.registerLiveActivity": "client",
  "devices.unregisterLiveActivity": "client",
  "devices.watch": "client",
  "voice.transcribe": "voice",
  "voice.settings": "client",
  "voice.setKey": "client",
  "secret.provide": "client",
  "sessions.autoArchive": "client",
  "sessions.setAutoArchive": "client",
  "sessions.idleCompaction": "client",
  "sessions.setIdleCompaction": "client",
  "sessions.visuals": "client",
  "sessions.setVisuals": "client",
  "continuity.watch": "client",
  "continuity.markRead": "client",
  "continuity.saveDraft": "client",
  "presence.report": "client",
  "host.stats.watch": "client",
  "byteStream.credit": "client",
  "hostAddress.open": "client",
  "browser.host": "client",
  "browser.claim": "client",
  "browser.release": "client",
  "browser.acceptStream": "client",
  "browser.closeStream": "client",
  "attachments.stage": "client",
  "attachments.read": "client",
  "attachments.settings": "client",
  "attachments.setSettings": "client",
  "attachments.clear": "client",
  "inline.propose": "client",
  "commit.suggestMessage": "client",
  "prediction.capability": "client",
  "prediction.complete": "client",
  "prediction.context": "client",
  "prediction.edit": "client",
  "prediction.managed": "client",
  "prediction.managed.watch": "client",
  "prediction.server": "client",
  "files.listDir": "client",
  "files.stat": "client",
  "files.read": "client",
  "files.readVersioned": "client",
  "files.searchPaths": "client",
  "files.grep": "client",
  "files.watch": "client",
  "files.watchFile": "client",
  "files.write": "client",
  "files.create": "client",
  "files.delete": "client",
  "files.rename": "client",
  "git.status": "client",
  "git.diff": "client",
  "git.show": "client",
  "git.stage": "client",
  "git.unstage": "client",
  "git.discard": "client",
  "git.commit": "client",
  "git.init": "client",
  "git.sync": "client",
  "git.watch": "client",
  "git.log": "client",
  "review.checkoutStatus": "client",
  "review.runRiskSummary": "client",
  "review.runWalkthrough": "client",
  "review.stopWalkthrough": "client",
  "review.riskSummary": "client",
  "review.watchRiskSummary": "client",
  "review.askFinding": "client",
  "review.verdicts": "client",
  "review.reviewerSettings": "client",
  "review.setReviewerSettings": "client",
  "session.acceptPlan": "client",
  "session.draftAccept": "client",
  "session.commitAccepted": "client",
  "session.pushAccepted": "client",
  "terminal.open": "client",
  "terminal.attach": "client",
  "terminal.attachBinary": "client",
  "terminal.input": "client",
  "terminal.resize": "client",
  "terminal.close": "client",
  "constellation.answer": "client",
  "constellation.assignment.list": "client",
  "constellation.assignment.set": "client",
  "constellation.base.export": "client",
  "constellation.base.import": "client",
  "constellation.bundle.export": "client",
  "constellation.bundle.import": "client",
  "constellation.claim.export": "client",
  "constellation.connection": "client",
  "constellation.defaults.get": "client",
  "constellation.defaults.set": "client",
  "constellation.delivery.ack": "client",
  "constellation.delivery.apply": "client",
  "constellation.delivery.watch": "client",
  "constellation.dispatch": "client",
  "constellation.message": "client",
  "constellation.origin.import": "client",
  "constellation.outbox.ack": "client",
  "constellation.outbox.apply": "client",
  "constellation.outbox.watch": "client",
  "constellation.placement.resolve": "client",
  "constellation.placements.watch": "client",
  "constellation.plan": "client",
  "constellation.repository.prepare": "client",
  "constellation.review": "client",
  "constellation.set_state": "client",
  "constellation.stats": "client",
  "constellation.status": "client",
  "constellation.subscribe": "client",
  "constellation.worker.ask": "client",
  "constellation.worker.block": "client",
  "constellation.worker.claim": "client",
  "constellation.worker.message": "client",
  "constellation.worker.prepare": "client",
  "constellation.worker.progress": "client",
  "constellation.worker.propose": "client",
  "constellation.worker.start": "client",
  "constellation.worktree.prepare": "client",
  "host.resources.acquire": "client",
  "host.resources.declare": "client",
  "host.resources.get": "client",
  "host.resources.release": "client",
  "host.resources.remove": "client",
  "host.workers.setCap": "client",
  "languages.availability": "client",
  "languages.availability.watch": "client",
  "languages.cancel": "client",
  "languages.catalog": "client",
  "languages.context.acquire": "client",
  "languages.context.configure": "client",
  "languages.context.release": "client",
  "languages.context.restart": "client",
  "languages.context.watch": "client",
  "languages.discover": "client",
  "languages.document.acknowledge": "client",
  "languages.document.sync": "client",
  "languages.edit.decide": "client",
  "languages.edit.prepare": "client",
  "languages.format": "client",
  "languages.format.project": "client",
  "languages.host.processBudget.get": "client",
  "languages.host.processBudget.set": "client",
  "languages.host.state": "client",
  "languages.host.state.watch": "client",
  "languages.install": "client",
  "languages.install.cancel": "client",
  "languages.install.watch": "client",
  "languages.log.watch": "client",
  "languages.operation.get": "client",
  "languages.operation.recover": "client",
  "languages.preview.media": "client",
  "languages.progress.cancel": "client",
  "languages.python.interpreters": "client",
  "languages.python.select": "client",
  "languages.request": "client",
  "languages.server.respond": "client",
  "languages.server.restart": "client",
  "languages.sql.dialect.get": "client",
  "languages.sql.dialect.select": "client",
  "languages.tree.edit.decide": "client",
  "languages.tree.operation.get": "client",
  "languages.tree.operation.recover": "client",
  "languages.trust.change": "client",
  "languages.trust.get": "client",
  "languages.trust.inspect": "client",
  "languages.trust.set": "client",
  "languages.workspace.restart": "client",
} as const satisfies Record<DaemonRpcTag, RpcAccess>;

const commandAccess = (tag: string): CommandAccess =>
  Object.hasOwn(COMMAND_GRANTS, tag)
    ? // SAFETY: `hasOwn` just proved `tag` is one of COMMAND_GRANTS' keys.
      COMMAND_GRANTS[tag as Command["_tag"]]
    : "client";

const rpcAccess = (tag: string): RpcAccess =>
  Object.hasOwn(RPC_GRANTS, tag)
    ? // SAFETY: `hasOwn` just proved `tag` is one of RPC_GRANTS' keys.
      RPC_GRANTS[tag as DaemonRpcTag]
    : "client";

/** What a request needs, by RPC tag and, for `dispatch`, the tag of its Command. */
export const accessFor = (rpc: string, command: string | null) =>
  rpc === "dispatch"
    ? { what: `dispatch:${command ?? ""}`, access: commandAccess(command ?? "") }
    : { what: rpc, access: rpcAccess(rpc) };

/** A `supervised` or `plan` session asks before every action; the others approve some themselves. */
const asksForEverything = (permissionMode: string | null) =>
  permissionMode === "supervised" || permissionMode === "plan";

/**
 * A session that is not supervised approves for itself, so starting one is also
 * approving: an Extension needs `approve` on top of `start` (ADR 0075).
 */
const alsoApproves = (rpc: string, command: string | null, permissionMode: string | null) =>
  rpc === "dispatch" && command === "StartSession" && !asksForEverything(permissionMode);

/** Apply inside the commit decision, using the session's current permission mode. */
export const decideTurnAccess = (
  grant: Grant | null,
  command: Command,
  permissionMode: string | null
): NotGranted | null => {
  if (grant === null || permissionMode === null || asksForEverything(permissionMode)) return null;

  if (!Command.isAnyOf(["SendTurn", "Steer", "Continue", "Retry"])(command)) return null;

  return grant.includes("approve")
    ? null
    : new NotGranted({ what: `dispatch:${command._tag}`, needed: "approve" });
};

/**
 * The refusal for a request on a connection scoped to `pairing`, or null when
 * it may proceed. A token-less connection (`pairing` null) always may. For
 * `dispatch`, `command` is the Command's tag and `permissionMode` a
 * `StartSession`'s mode.
 */
export const decideAccess = (
  pairing: Pairing | null,
  rpc: string,
  command: string | null,
  permissionMode: string | null = null
): NotGranted | null => {
  if (pairing === null) return null;
  const { what, access } = accessFor(rpc, command);

  if (access === "open") return null;

  if (access === "client") return new NotGranted({ what, needed: null });

  if (!pairing.grant.includes(access)) return new NotGranted({ what, needed: access });

  return alsoApproves(rpc, command, permissionMode) && !pairing.grant.includes("approve")
    ? new NotGranted({ what, needed: "approve" })
    : null;
};
