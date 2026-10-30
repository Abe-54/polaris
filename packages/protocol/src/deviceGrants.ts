/**
 * What a Linked Device's connection may do (RX2-1): an allowlist of the Mobile App's
 * own surface, exhaustive over `DaemonRpcs` and `Command` so a new RPC or Command
 * fails typecheck until someone decides whether a phone may use it. Unknown tags are
 * refused. `local` is the Desktop App's alone: credentials, links, routes, shells.
 */
import { Schema } from "effect";
import { Command } from "./commands.ts";
import { SetConstellationStateAction } from "./constellation/commands.ts";
import { NotGranted } from "./extensions.ts";
import type { DaemonRpcTag } from "./grants.ts";
import { PermissionMode } from "./domain.ts";
import { HarnessKind } from "./harnesses.ts";
import { AttachmentId, SessionId, WorkspaceId } from "./ids.ts";
import { addedNullable, ModelId, ReasoningEffort, ServiceTier } from "./models.ts";

/** `device`: a Linked Device may call it. `local`: only a Client on this Host. */
export type DeviceAccess = "device" | "local";

/** A Command's access: by tag, or `device` only for payloads its check admits. */
export type DeviceCommandAccess = DeviceAccess | ((command: Command) => boolean);

const absentOrNull = Schema.optionalKey(Schema.Null);

/**
 * StartSession as the Mobile App sends it, in any PermissionMode, effort and service tier (RX3-1,
 * ENG-458, ENG-627): exhaustive over the Command's fields, so a new field fails typecheck until
 * someone decides what a phone may put in it.
 */
const DEVICE_START_SESSION = {
  _tag: Schema.tag("StartSession"),
  sessionId: SessionId,
  workspaceId: WorkspaceId,
  harness: HarnessKind,
  placement: Schema.Union([
    Schema.Struct({ _tag: Schema.tag("InPlace") }),
    Schema.Struct({ _tag: Schema.tag("NewWorktree"), branch: Schema.String, baseRef: Schema.Null }),
  ]),
  permissionMode: PermissionMode,
  model: Schema.NullOr(ModelId),
  effort: addedNullable(ReasoningEffort),
  serviceTier: Schema.optionalKey(Schema.NullOr(ServiceTier)),
  prompt: Schema.String,
  attachments: Schema.Array(AttachmentId),
  origin: absentOrNull,
} satisfies Record<keyof typeof Command.cases.StartSession.fields, Schema.Top>;

const isDeviceStartSession = Schema.is(Schema.Struct(DEVICE_START_SESSION));

/** A phone archives a session but never deletes its branch, so Unarchive undoes it (ENG-491). */
const isDeviceArchive = (command: Command) =>
  Command.guards.ArchiveSession(command) && !command.deleteMergedBranch;

/** A phone pauses, resumes, completes or archives a constellation, but never hands its lead over. */
const isDeviceStateAction = (action: SetConstellationStateAction | null) =>
  action !== null && !SetConstellationStateAction.guards.HandOver(action);

/** `dispatch` itself is decided per Command (`DEVICE_COMMANDS`). */
export const DEVICE_RPCS = {
  hello: "device",
  dispatch: "device",
  subscribeHost: "device",
  subscribeSession: "device",
  "session.turns": "device",
  "session.terminalCommand": "local",
  "harness.models": "device",
  "harness.commands": "local",
  "harness.spinnerVerbs": "local",
  "harness.availability": "device",
  "harness.watchAvailability": "local",
  "usage.query": "local",
  "usage.watch": "local",
  "extensions.pair": "local",
  "extensions.list": "local",
  "extensions.revoke": "local",
  "remoteAccess.status": "local",
  "remoteAccess.enable": "local",
  "remoteAccess.disable": "local",
  "host.restartPreview": "local",
  "host.prepareRestart": "local",
  "relayRoute.status": "local",
  "relayRoute.enable": "local",
  "relayRoute.disable": "local",
  "devices.link": "local",
  "devices.awaitLink": "local",
  "devices.cancelLink": "local",
  "devices.add": "local",
  "devices.list": "device",
  "devices.unlink": "local",
  "devices.unlinkSelf": "device",
  "devices.registerPush": "device",
  "devices.unregisterPush": "device",
  "devices.registerLiveActivity": "device",
  "devices.unregisterLiveActivity": "device",
  "devices.watch": "local",
  "voice.transcribe": "device",
  "voice.settings": "local",
  "voice.setKey": "local",
  "secret.provide": "device",
  "sessions.autoArchive": "local",
  "sessions.setAutoArchive": "local",
  "sessions.idleCompaction": "local",
  "sessions.setIdleCompaction": "local",
  "sessions.visuals": "local",
  "sessions.setVisuals": "local",
  "continuity.watch": "device",
  "continuity.markRead": "device",
  "continuity.saveDraft": "device",
  // A phone or an Extension must never quiet the pushes (ENG-495).
  "presence.report": "local",
  "host.stats.watch": "local",
  "byteStream.credit": "local",
  "hostAddress.open": "local",
  "browser.host": "local",
  "browser.claim": "local",
  "browser.release": "local",
  "browser.acceptStream": "local",
  "browser.closeStream": "local",
  "attachments.stage": "device",
  "attachments.read": "device",
  "attachments.settings": "local",
  "attachments.setSettings": "local",
  "attachments.clear": "local",
  "inline.propose": "local",
  "commit.suggestMessage": "local",
  "prediction.capability": "local",
  "prediction.complete": "local",
  "prediction.context": "local",
  "prediction.edit": "local",
  "prediction.managed": "local",
  "prediction.managed.watch": "local",
  "prediction.server": "local",
  "files.listDir": "local",
  "files.stat": "local",
  "files.read": "local",
  "files.readVersioned": "local",
  "files.searchPaths": "local",
  "files.grep": "local",
  "files.watch": "local",
  "files.watchFile": "local",
  "files.write": "local",
  "files.create": "local",
  "files.delete": "local",
  "files.rename": "local",
  "git.status": "local",
  "git.diff": "device",
  "git.show": "local",
  "git.stage": "local",
  "git.unstage": "local",
  "git.discard": "local",
  "git.commit": "local",
  "git.init": "local",
  "git.sync": "local",
  "git.watch": "local",
  "git.log": "local",
  "review.checkoutStatus": "local",
  "review.runRiskSummary": "device",
  "review.runWalkthrough": "local",
  "review.stopWalkthrough": "local",
  "review.riskSummary": "device",
  "review.watchRiskSummary": "device",
  "review.askFinding": "device",
  "review.verdicts": "local",
  "review.reviewerSettings": "local",
  "review.setReviewerSettings": "local",
  "session.acceptPlan": "local",
  "session.draftAccept": "local",
  "session.commitAccepted": "local",
  "session.pushAccepted": "local",
  "terminal.open": "local",
  "terminal.attach": "local",
  "terminal.attachBinary": "local",
  "terminal.input": "local",
  "terminal.resize": "local",
  "terminal.close": "local",
  "constellation.answer": "local",
  "constellation.assignment.list": "local",
  "constellation.assignment.set": "local",
  "constellation.base.export": "local",
  "constellation.base.import": "local",
  "constellation.bundle.export": "local",
  "constellation.bundle.import": "local",
  "constellation.claim.export": "local",
  "constellation.connection": "local",
  "constellation.defaults.get": "local",
  "constellation.defaults.set": "local",
  "constellation.delivery.ack": "local",
  "constellation.delivery.apply": "local",
  "constellation.delivery.watch": "local",
  "constellation.dispatch": "local",
  "constellation.message": "device",
  "constellation.origin.import": "local",
  "constellation.outbox.ack": "local",
  "constellation.outbox.apply": "local",
  "constellation.outbox.watch": "local",
  "constellation.placement.resolve": "local",
  "constellation.placements.watch": "local",
  "constellation.plan": "local",
  "constellation.repository.prepare": "local",
  "constellation.review": "device",
  "constellation.set_state": "device",
  "constellation.stats": "device",
  "constellation.status": "device",
  "constellation.subscribe": "device",
  "constellation.worker.ask": "local",
  "constellation.worker.block": "local",
  "constellation.worker.claim": "local",
  "constellation.worker.message": "local",
  "constellation.worker.prepare": "local",
  "constellation.worker.progress": "local",
  "constellation.worker.propose": "local",
  "constellation.worker.start": "local",
  "constellation.worktree.prepare": "local",
  "host.resources.acquire": "local",
  "host.resources.declare": "local",
  "host.resources.get": "local",
  "host.resources.release": "local",
  "host.resources.remove": "local",
  "host.workers.setCap": "local",
  "languages.availability": "local",
  "languages.availability.watch": "local",
  "languages.cancel": "local",
  "languages.catalog": "local",
  "languages.context.acquire": "local",
  "languages.context.configure": "local",
  "languages.context.release": "local",
  "languages.context.restart": "local",
  "languages.context.watch": "local",
  "languages.discover": "local",
  "languages.document.acknowledge": "local",
  "languages.document.sync": "local",
  "languages.edit.decide": "local",
  "languages.edit.prepare": "local",
  "languages.format": "local",
  "languages.format.project": "local",
  "languages.host.processBudget.get": "local",
  "languages.host.processBudget.set": "local",
  "languages.host.state": "local",
  "languages.host.state.watch": "local",
  "languages.install": "local",
  "languages.install.cancel": "local",
  "languages.install.watch": "local",
  "languages.log.watch": "local",
  "languages.operation.get": "local",
  "languages.operation.recover": "local",
  "languages.preview.media": "local",
  "languages.progress.cancel": "local",
  "languages.python.interpreters": "local",
  "languages.python.select": "local",
  "languages.request": "local",
  "languages.server.respond": "local",
  "languages.server.restart": "local",
  "languages.sql.dialect.get": "local",
  "languages.sql.dialect.select": "local",
  "languages.tree.edit.decide": "local",
  "languages.tree.operation.get": "local",
  "languages.tree.operation.recover": "local",
  "languages.trust.change": "local",
  "languages.trust.get": "local",
  "languages.trust.inspect": "local",
  "languages.trust.set": "local",
  "languages.workspace.restart": "local",
} as const satisfies Record<DaemonRpcTag, DeviceAccess>;

export const DEVICE_COMMANDS = {
  RegisterWorkspace: "local",
  SetWorktreeSetup: "local",
  SetWorkspaceHidden: "local",
  RemoveWorkspace: "local",
  StartSession: isDeviceStartSession,
  SendTurn: "device",
  RunShellCommand: "local",
  CompactSession: "local",
  Steer: "device",
  Interrupt: "device",
  StopBackgroundTasks: "local",
  BackgroundCommand: "local",
  Continue: "local",
  Retry: "local",
  RespondToApproval: "device",
  RenameSession: "device",
  PinSession: "device",
  SetResumeAtReset: "local",
  SetPermissionMode: "device",
  SetModel: "device",
  ForkSession: "local",
  ArchiveSession: isDeviceArchive,
  UnarchiveSession: "device",
  OpenInTerminal: "local",
  ReturnFromTerminal: "local",
  SendFeedback: "device",
  AcceptTurns: "device",
  LinkPullRequest: "local",
  OpenReviewCheckout: "local",
  ReportReviewHead: "local",
  UpdateReviewCheckout: "local",
  RemoveReviewCheckout: "local",
  RecordVerdict: "device",
} as const satisfies Record<Command["_tag"], DeviceCommandAccess>;

const allowed = (table: Readonly<Record<string, DeviceAccess>>, tag: string) =>
  Object.hasOwn(table, tag) && table[tag] === "device";

const commandAllowed = (tag: string, command: Command | null) => {
  if (!Object.hasOwn(DEVICE_COMMANDS, tag)) return false;
  // SAFETY: `hasOwn` just proved `tag` is one of DEVICE_COMMANDS' keys.
  const access: DeviceCommandAccess = DEVICE_COMMANDS[tag as Command["_tag"]];

  if (access === "device") return true;

  return access !== "local" && command !== null && access(command);
};

/**
 * The refusal for a request on a Linked Device's connection, or null. For `dispatch`,
 * `tag` is its Command's tag (null when the payload names none) and `command` the
 * decoded Command, null when it isn't one; a payload check refuses without it.
 */
export const decideDeviceAccess = (
  rpc: string,
  tag: string | null,
  command: Command | null = null,
  stateAction: SetConstellationStateAction | null = null
): NotGranted | null => {
  if (!allowed(DEVICE_RPCS, rpc)) return new NotGranted({ what: rpc, needed: null });

  if (rpc === "constellation.set_state")
    return isDeviceStateAction(stateAction) ? null : new NotGranted({ what: rpc, needed: null });

  if (rpc !== "dispatch") return null;

  return tag !== null && commandAllowed(tag, command)
    ? null
    : new NotGranted({ what: `dispatch:${tag ?? ""}`, needed: null });
};
