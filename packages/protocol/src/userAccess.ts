/**
 * What only the user may do on a Host (ENG-700, ADR 0100): every RPC and `dispatch`
 * Command is `user` or `any`, exhaustive over `DaemonRpcs` and `Command` so a new one
 * fails typecheck until someone decides. A token-less connection gets `user` only after
 * its `hello` presented an enrolled user key; Extensions and Linked Devices keep their own
 * gates (`grants.ts`, `deviceGrants.ts`) and never pass through this one.
 */
import { Schema } from "effect";
import { type Rpc, type RpcGroup, RpcMiddleware } from "effect/rpc";
import type { Command } from "./commands.ts";
import type { DaemonRpcTag } from "./grants.ts";

/** `user`: the connection must hold user access. `any`: any token-less connection. */
export type UserAccessNeed = "user" | "any";

/**
 * A user-only RPC or Command from a connection without user access: a process
 * that reached the socket, or a Desktop App whose user key this Host has not enrolled.
 */
export class UserAccessRequired extends Schema.TaggedError<UserAccessRequired>()(
  "UserAccessRequired",
  {
    /** The RPC (`secret.provide`) or Command (`dispatch:RespondToApproval`) that was refused. */
    what: Schema.String,
  }
) {
  override get message(): string {
    return `${this.what} is only for a Desktop App this Host has enrolled`;
  }
}

/** The Daemon refuses, with `UserAccessRequired`, a user-only request without user access. */
export class UserAccessGate extends RpcMiddleware.Service<UserAccessGate>()(
  "polaris/protocol/UserAccessGate",
  { error: UserAccessRequired }
) {}

/** A user key: 32 random bytes as hex, held by the Desktop App and never by the Host. */
export const UserKey = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

/** `dispatch` is decided per Command: approvals, permission modes and anything that runs a Turn. */
export const USER_COMMANDS = {
  RegisterWorkspace: "any",
  SetWorktreeSetup: "any",
  SetWorkspaceHidden: "any",
  RemoveWorkspace: "any",
  StartSession: "user",
  SendTurn: "user",
  RunShellCommand: "user",
  CompactSession: "any",
  Steer: "user",
  Interrupt: "any",
  StopBackgroundTasks: "any",
  BackgroundCommand: "any",
  Continue: "user",
  Retry: "user",
  RespondToApproval: "user",
  RenameSession: "any",
  PinSession: "any",
  SetResumeAtReset: "user",
  SetPermissionMode: "user",
  SetModel: "any",
  ForkSession: "any",
  ArchiveSession: "any",
  UnarchiveSession: "any",
  OpenInTerminal: "any",
  ReturnFromTerminal: "any",
  SendFeedback: "user",
  AcceptTurns: "any",
  LinkPullRequest: "any",
  OpenReviewCheckout: "any",
  ReportReviewHead: "any",
  UpdateReviewCheckout: "any",
  RemoveReviewCheckout: "any",
  RecordVerdict: "any",
} as const satisfies Record<Command["_tag"], UserAccessNeed>;

/**
 * `user` RPCs, by reason (ADR 0100): Pairings and the Host's reach (Remote Access, the
 * Relay route, Linked Devices); secrets and credentials; approval-class decisions
 * (profiler attach, data writes, data source access); accepting work; language trust;
 * typing into terminals, where a Harness answers its own prompts; installing a global skill;
 * and a Constellation's
 * answers and reviews, which agents give through the Polaris MCP tools instead.
 */
export const USER_RPCS = {
  hello: "any",
  dispatch: "any",
  subscribeHost: "any",
  subscribeSession: "any",
  "session.turns": "any",
  "session.terminalCommand": "any",
  "harness.models": "any",
  "harness.commands": "any",
  "harness.spinnerVerbs": "any",
  "harness.availability": "any",
  "harness.watchAvailability": "any",
  "usage.query": "any",
  "usage.watch": "any",
  "extensions.pair": "user",
  "extensions.list": "any",
  "extensions.revoke": "user",
  "remoteAccess.status": "any",
  "remoteAccess.enable": "user",
  "remoteAccess.disable": "user",
  "host.restartPreview": "any",
  "host.prepareRestart": "any",
  "relayRoute.status": "any",
  "relayRoute.enable": "user",
  "relayRoute.disable": "user",
  "devices.link": "user",
  "devices.awaitLink": "user",
  "devices.cancelLink": "user",
  "devices.add": "user",
  "devices.list": "any",
  "devices.unlink": "user",
  "devices.unlinkSelf": "any",
  "devices.registerPush": "any",
  "devices.unregisterPush": "any",
  "devices.registerLiveActivity": "any",
  "devices.unregisterLiveActivity": "any",
  "devices.watch": "any",
  "voice.transcribe": "any",
  "voice.settings": "any",
  "voice.setKey": "user",
  "secret.provide": "user",
  "sessions.autoArchive": "any",
  "sessions.setAutoArchive": "any",
  "sessions.idleCompaction": "any",
  "sessions.setIdleCompaction": "any",
  "sessions.visuals": "any",
  "sessions.setVisuals": "any",
  "continuity.watch": "any",
  "continuity.markRead": "any",
  "continuity.saveDraft": "any",
  "presence.report": "any",
  "data.sources.watch": "any",
  "traces.watch": "any",
  "traces.get": "any",
  "traces.span": "any",
  "traces.settings": "any",
  "traces.setSettings": "any",
  "profiles.watch": "any",
  "profiles.get": "any",
  "profiles.attach": "user",
  "profiles.restartWithProfiling": "user",
  "traces.compare": "any",
  "data.schemaDiff": "any",
  "data.describe": "any",
  "data.edits.commit": "user",
  "data.query": "any",
  "data.queryLog.watch": "any",
  "data.source.save": "user",
  "data.source.remove": "any",
  "data.source.label": "any",
  "data.query.stream": "any",
  "data.queryLog.page": "any",
  "data.source.access": "user",
  "host.stats.watch": "any",
  "byteStream.credit": "any",
  "hostAddress.open": "any",
  "hostAddress.names": "any",
  "browser.host": "any",
  "browser.claim": "any",
  "browser.release": "any",
  "browser.acceptStream": "any",
  "browser.closeStream": "any",
  "attachments.stage": "any",
  "attachments.read": "any",
  "attachments.settings": "any",
  "attachments.setSettings": "any",
  "attachments.clear": "any",
  "inline.propose": "any",
  "commit.suggestMessage": "any",
  "prediction.capability": "any",
  "prediction.complete": "any",
  "prediction.context": "any",
  "prediction.edit": "any",
  "prediction.managed": "any",
  "prediction.managed.watch": "any",
  "prediction.server": "any",
  "files.listDir": "any",
  "files.stat": "any",
  "files.read": "any",
  "files.readVersioned": "any",
  "files.searchPaths": "any",
  "files.grep": "any",
  "files.watch": "any",
  "files.watchFile": "any",
  "files.write": "any",
  "files.create": "any",
  "files.delete": "any",
  "files.rename": "any",
  "git.status": "any",
  "git.diff": "any",
  "git.show": "any",
  "git.stage": "any",
  "git.unstage": "any",
  "git.discard": "any",
  "git.commit": "any",
  "git.init": "any",
  "git.sync": "any",
  "git.watch": "any",
  "git.log": "any",
  "review.checkoutStatus": "any",
  "review.runRiskSummary": "any",
  "review.runWalkthrough": "any",
  "review.stopWalkthrough": "any",
  "review.riskSummary": "any",
  "review.watchRiskSummary": "any",
  "review.askFinding": "any",
  "review.verdicts": "any",
  "review.reviewerSettings": "any",
  "review.setReviewerSettings": "any",
  "session.acceptPlan": "any",
  "session.draftAccept": "any",
  "session.commitAccepted": "user",
  "session.pushAccepted": "user",
  "terminal.open": "any",
  "terminal.attach": "any",
  "terminal.attachBinary": "any",
  "terminal.input": "user",
  "terminal.resize": "any",
  "terminal.close": "any",
  "constellation.answer": "user",
  "constellation.assignment.list": "any",
  "constellation.assignment.set": "any",
  "constellation.base.export": "any",
  "constellation.base.import": "any",
  "constellation.bundle.export": "any",
  "constellation.bundle.import": "any",
  "constellation.claim.export": "any",
  "constellation.connection": "any",
  "constellation.defaults.get": "any",
  "constellation.defaults.set": "any",
  "constellation.delivery.ack": "any",
  "constellation.delivery.apply": "any",
  "constellation.delivery.watch": "any",
  "constellation.dispatch": "any",
  "constellation.message": "any",
  "constellation.origin.import": "any",
  "constellation.outbox.ack": "any",
  "constellation.outbox.apply": "any",
  "constellation.outbox.watch": "any",
  "constellation.placement.resolve": "any",
  "constellation.placements.watch": "any",
  "constellation.plan": "any",
  "constellation.repository.prepare": "any",
  "constellation.review": "user",
  "constellation.set_state": "any",
  "constellation.stats": "any",
  "constellation.status": "any",
  "constellation.subscribe": "any",
  "constellation.worker.ask": "any",
  "constellation.worker.block": "any",
  "constellation.worker.claim": "any",
  "constellation.worker.message": "any",
  "constellation.worker.prepare": "any",
  "constellation.worker.progress": "any",
  "constellation.worker.propose": "any",
  "constellation.worker.start": "any",
  "constellation.worktree.prepare": "any",
  "host.resources.acquire": "any",
  "host.resources.declare": "any",
  "host.resources.get": "any",
  "host.resources.release": "any",
  "host.resources.remove": "any",
  "host.workers.setCap": "any",
  "languages.availability": "any",
  "languages.availability.watch": "any",
  "languages.cancel": "any",
  "languages.catalog": "any",
  "languages.context.acquire": "any",
  "languages.context.configure": "any",
  "languages.context.release": "any",
  "languages.context.restart": "any",
  "languages.context.watch": "any",
  "languages.discover": "any",
  "languages.document.acknowledge": "any",
  "languages.document.sync": "any",
  "languages.edit.decide": "any",
  "languages.edit.prepare": "any",
  "languages.format": "any",
  "languages.format.project": "any",
  "languages.host.processBudget.get": "any",
  "languages.host.processBudget.set": "any",
  "languages.host.state": "any",
  "languages.host.state.watch": "any",
  "languages.install": "any",
  "languages.install.cancel": "any",
  "languages.install.watch": "any",
  "languages.log.watch": "any",
  "languages.operation.get": "any",
  "languages.operation.recover": "any",
  "languages.preview.media": "any",
  "languages.progress.cancel": "any",
  "languages.python.interpreters": "any",
  "languages.python.select": "any",
  "languages.request": "any",
  "languages.server.respond": "any",
  "languages.server.restart": "any",
  "languages.sql.dialect.get": "any",
  "languages.sql.dialect.select": "any",
  "languages.tree.edit.decide": "any",
  "languages.tree.operation.get": "any",
  "languages.tree.operation.recover": "any",
  "languages.trust.change": "user",
  "languages.trust.get": "any",
  "languages.trust.inspect": "any",
  "languages.trust.set": "user",
  "languages.workspace.restart": "any",
  "data.source.saveFile": "user",
  "developerMode.get": "any",
  "developerMode.set": "any",
  "developerMode.setWorkspace": "any",
  "developerMode.lease": "any",
  "developerMode.watch": "any",
  "traces.ingestSelf": "any",
  // Writes a skill into every Harness's global config: it steers all future agents.
  "traces.installSkill": "user",
  // Sends, saves or resolves variables (which may hold secrets) only for the user (ENG-809).
  "requests.watch": "any",
  "requests.save": "user",
  "requests.send": "user",
  "requests.variables": "user",
  "requests.sendLog.page": "any",
  "requests.sendLog.watch": "any",
  "requests.send.get": "any",
  "requests.curl.parse": "any",
  "requests.curl.format": "user",
  "simulator.watch": "any",
  "simulator.boot": "any",
  "simulator.shutdown": "any",
  "simulator.restart": "any",
  // Its endpoint takes taps and keys on the Simulator, as `terminal.input` does on a terminal.
  "simulator.attach": "user",
  "simulator.sessionFeed": "any",
} as const satisfies Record<DaemonRpcTag, UserAccessNeed>;

/** The RPCs the user gate decides: every `user` one, and `dispatch`, decided per Command. */
type GatedTag =
  | "dispatch"
  | {
      [K in keyof typeof USER_RPCS]: (typeof USER_RPCS)[K] extends "user" ? K : never;
    }[keyof typeof USER_RPCS];

const isGated = (tag: string) =>
  tag === "dispatch" || (Object.hasOwn(USER_RPCS, tag) && needOf(USER_RPCS, tag) === "user");

/**
 * `group` with the user gate on what it decides, so a Client decodes its `UserAccessRequired`;
 * RPCs it never refuses keep their errors.
 */
export const gateUserRpcs = <R extends Rpc.Any>(group: RpcGroup.RpcGroup<R>) => {
  const tags = [...group.requests.keys()];
  const gated = tags.filter((tag): tag is Extract<R["_tag"], GatedTag> => isGated(tag));
  const open = tags.filter((tag): tag is Exclude<R["_tag"], GatedTag> => !isGated(tag));

  return group.omit(...gated).merge(group.omit(...open).middleware(UserAccessGate));
};

const needOf = (table: Readonly<Record<string, UserAccessNeed>>, tag: string): UserAccessNeed =>
  Object.hasOwn(table, tag) ? (table[tag] ?? "user") : "user";

/**
 * The refusal for a request on a token-less connection, or null when it may proceed.
 * `held`: the connection's `hello` presented an enrolled user key. Unknown tags need it.
 */
export const decideUserAccess = (
  rpc: string,
  command: string | null,
  held: boolean
): UserAccessRequired | null => {
  if (held) return null;

  if (rpc === "dispatch")
    return needOf(USER_COMMANDS, command ?? "") === "user"
      ? new UserAccessRequired({ what: `dispatch:${command ?? ""}` })
      : null;

  return needOf(USER_RPCS, rpc) === "user" ? new UserAccessRequired({ what: rpc }) : null;
};
