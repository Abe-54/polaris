/**
 * The capability a Daemon announces in `hello` before a Client may send each RPC (ENG-326).
 * Exhaustive over `DaemonRpcs`, so a new RPC fails typecheck until it names one: an older
 * Daemon answers an RPC it doesn't know with a connection-level Defect, and the Client reconnects.
 */
import type { Capability } from "./capabilities.ts";
import type { DaemonRpcTag } from "./grants.ts";
import { LANGUAGE_RPC_CAPABILITIES, languageRpcAllowed } from "./languages/capabilities.ts";

type LanguageRpcTag = keyof typeof LANGUAGE_RPC_CAPABILITIES;

/** `null`: every Daemon at this protocol version serves it. A list: any one of them. */
export type RpcRequirement = Capability | ReadonlyArray<Capability> | null;

const files = "files.read";

const manage = "files.manage";

const write = "git.write";

const terminal = "terminal";

const accept = "session.accept";

const risk = "review.risk-summary";

const walkthrough = "review.walkthrough";

const attachmentSettings = "attachments.settings";

const constellation = "constellation";

const resources = "host.resources";

const devices = "linked-devices";

const data = "data";

const traces = "traces";

const profiles = "traces.profiles";

const developer = "developer-mode";

const browser = "browser.host";

export const RPC_CAPABILITIES = {
  hello: null,
  dispatch: null,
  subscribeHost: null,
  subscribeSession: null,
  "git.status": null,
  "inline.propose": "inline.propose",
  "session.terminalCommand": "session.terminal-command",
  "harness.models": "harness.models",
  "harness.commands": "harness.commands",
  "harness.spinnerVerbs": "harness.spinner-verbs",
  "harness.availability": "harness.availability",
  "harness.watchAvailability": "harness.availability",
  "usage.query": "usage",
  "usage.watch": "usage",
  "files.listDir": files,
  "files.stat": files,
  "files.read": files,
  "files.searchPaths": "files.search",
  "files.grep": "files.search",
  "files.watch": "files.watch",
  "files.readVersioned": "files.versioned",
  "files.write": "files.write",
  "files.create": manage,
  "files.rename": manage,
  "files.delete": manage,
  "files.watchFile": "files.watch-file",
  "git.diff": "git.diff",
  "git.show": "git.show",
  "git.init": "git.init",
  "git.stage": write,
  "git.unstage": write,
  "git.discard": write,
  "git.commit": write,
  "git.sync": "git.sync",
  "git.watch": "git.watch",
  "git.log": "git.log",
  "commit.suggestMessage": "commit.suggest-message",
  "review.checkoutStatus": "review.checkouts",
  "review.runRiskSummary": risk,
  "review.riskSummary": risk,
  "review.watchRiskSummary": risk,
  "review.runWalkthrough": walkthrough,
  "review.stopWalkthrough": walkthrough,
  "review.askFinding": "review.ask",
  "review.verdicts": "review.verdicts",
  "review.reviewerSettings": "review.reviewer-settings",
  "review.setReviewerSettings": "review.reviewer-settings",
  "session.acceptPlan": accept,
  "session.draftAccept": accept,
  "session.commitAccepted": accept,
  "session.pushAccepted": accept,
  "session.turns": "session.turn-paging",
  "attachments.stage": "attachments.stage",
  "attachments.read": "attachments.read",
  "attachments.settings": attachmentSettings,
  "attachments.setSettings": attachmentSettings,
  "attachments.clear": attachmentSettings,
  "constellation.connection": constellation,
  "constellation.stats": constellation,
  "constellation.defaults.get": "constellation.defaults",
  "constellation.defaults.set": "constellation.defaults",
  "constellation.plan": constellation,
  "constellation.dispatch": constellation,
  "constellation.review": constellation,
  "constellation.answer": constellation,
  "constellation.message": constellation,
  "constellation.status": constellation,
  "constellation.set_state": constellation,
  "constellation.worker.block": constellation,
  "constellation.worker.claim": constellation,
  "constellation.worker.ask": constellation,
  "constellation.worker.progress": constellation,
  "constellation.worker.propose": constellation,
  "constellation.worker.message": constellation,
  "constellation.worker.start": constellation,
  "constellation.subscribe": constellation,
  "constellation.worktree.prepare": constellation,
  "constellation.bundle.export": constellation,
  "constellation.bundle.import": constellation,
  "constellation.assignment.set": constellation,
  "constellation.assignment.list": constellation,
  "constellation.outbox.watch": constellation,
  "constellation.outbox.apply": constellation,
  "constellation.outbox.ack": constellation,
  "constellation.claim.export": constellation,
  "constellation.origin.import": constellation,
  "constellation.base.export": constellation,
  "constellation.base.import": constellation,
  "constellation.delivery.watch": constellation,
  "constellation.delivery.apply": constellation,
  "constellation.delivery.ack": constellation,
  "constellation.placements.watch": constellation,
  "constellation.placement.resolve": constellation,
  "constellation.repository.prepare": constellation,
  "constellation.worker.prepare": constellation,
  "host.resources.get": resources,
  "host.resources.declare": resources,
  "host.resources.remove": resources,
  "host.resources.release": resources,
  "host.resources.acquire": resources,
  "host.workers.setCap": resources,
  "host.stats.watch": "host.stats",
  "host.restartPreview": "host.restart",
  "host.prepareRestart": "host.restart",
  "prediction.capability": "prediction.capability",
  "prediction.context": "prediction.context",
  "prediction.complete": "prediction.complete",
  "prediction.edit": "prediction.edit",
  "prediction.server": "prediction.server",
  "prediction.managed": "prediction.managed",
  "prediction.managed.watch": "prediction.managed",
  "sessions.autoArchive": "sessions.auto-archive",
  "sessions.setAutoArchive": "sessions.auto-archive",
  "sessions.idleCompaction": "sessions.idle-compaction",
  "sessions.setIdleCompaction": "sessions.idle-compaction",
  "sessions.visuals": "sessions.visuals",
  "sessions.setVisuals": "sessions.visuals",
  "continuity.watch": "session.continuity",
  "continuity.markRead": "session.continuity",
  "continuity.saveDraft": "session.continuity",
  "presence.report": "presence",
  "extensions.pair": "extensions",
  "extensions.list": "extensions",
  "extensions.revoke": "extensions",
  "remoteAccess.status": "remote-access",
  "remoteAccess.enable": "remote-access",
  "remoteAccess.disable": "remote-access",
  "relayRoute.status": devices,
  "relayRoute.enable": devices,
  "relayRoute.disable": devices,
  "devices.link": devices,
  "devices.awaitLink": devices,
  "devices.cancelLink": devices,
  "devices.add": devices,
  "devices.list": devices,
  "devices.unlink": devices,
  "devices.unlinkSelf": devices,
  "devices.registerPush": devices,
  "devices.unregisterPush": devices,
  "devices.registerLiveActivity": devices,
  "devices.unregisterLiveActivity": devices,
  "devices.watch": "linked-devices.presence",
  "voice.transcribe": "voice",
  "voice.settings": "voice",
  "voice.setKey": "voice",
  "secret.provide": "approval.secret",
  "terminal.open": terminal,
  "terminal.attach": terminal,
  "terminal.attachBinary": "terminal.binary",
  "terminal.input": terminal,
  "terminal.resize": terminal,
  "terminal.close": terminal,
  "data.schemaDiff": "data.schemaDiff",
  "data.sources.watch": data,
  "data.describe": data,
  "data.query": data,
  "data.queryLog.watch": data,
  "data.source.save": data,
  "data.source.saveFile": "data.sqlite",
  "data.source.remove": data,
  "data.source.label": data,
  "data.query.stream": data,
  "data.queryLog.page": data,
  "data.source.access": data,
  "data.edits.commit": "data.writes",
  "traces.watch": traces,
  "traces.get": traces,
  "traces.span": traces,
  "traces.settings": "traces.settings",
  "traces.setSettings": "traces.settings",
  "traces.compare": "traces.compare",
  "traces.installSkill": "traces.skill",
  "traces.ingestSelf": "traces.self",
  "profiles.watch": profiles,
  "profiles.get": profiles,
  "profiles.restartWithProfiling": profiles,
  "profiles.attach": "traces.profiles.attach",
  "byteStream.credit": ["host-address", browser],
  "hostAddress.open": "host-address",
  "hostAddress.names": "host-address.names",
  "requests.watch": "requests",
  "requests.save": "requests",
  "requests.send": "requests",
  "requests.variables": "requests",
  "requests.sendLog.page": "requests",
  "requests.sendLog.watch": "requests",
  "requests.send.get": "requests",
  "requests.curl.parse": "requests",
  "requests.curl.format": "requests",
  "browser.host": browser,
  "browser.claim": browser,
  "browser.release": browser,
  "browser.acceptStream": browser,
  "browser.closeStream": browser,
  "developerMode.get": developer,
  "developerMode.set": developer,
  "developerMode.setWorkspace": developer,
  "developerMode.lease": developer,
  "developerMode.watch": developer,
  "simulator.watch": "simulator",
  "simulator.boot": "simulator",
  "simulator.shutdown": "simulator",
  "simulator.restart": "simulator",
  "simulator.attach": "simulator",
  "simulator.sessionFeed": "simulator",
} as const satisfies Record<Exclude<DaemonRpcTag, LanguageRpcTag>, RpcRequirement>;

const isLanguageRpc = (tag: DaemonRpcTag): tag is LanguageRpcTag =>
  Object.hasOwn(LANGUAGE_RPC_CAPABILITIES, tag);

const anyOf = (tag: Exclude<DaemonRpcTag, LanguageRpcTag>): ReadonlyArray<Capability> => {
  const need: RpcRequirement = RPC_CAPABILITIES[tag];

  return need === null ? [] : [need].flat();
};

/** Whether a Daemon that announced `capabilities` in `hello` serves `tag`. */
export const rpcAllowed = (tag: DaemonRpcTag, capabilities: ReadonlyArray<Capability>): boolean => {
  if (isLanguageRpc(tag)) return languageRpcAllowed(tag, capabilities);
  const needs = anyOf(tag);

  return needs.length === 0 || needs.some((capability) => capabilities.includes(capability));
};

/** The capability to name when `tag` is refused: the first one it needs that wasn't announced. */
export const missingRpcCapability = (
  tag: DaemonRpcTag,
  capabilities: ReadonlyArray<Capability>
): Capability | null => {
  if (rpcAllowed(tag, capabilities)) return null;

  if (isLanguageRpc(tag)) {
    const own = LANGUAGE_RPC_CAPABILITIES[tag];

    return capabilities.includes(own) ? "languages" : own;
  }

  return anyOf(tag)[0] ?? null;
};
