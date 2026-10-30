import { Schema, SchemaTransformation } from "effect";
import { PREDICTION_CAPABILITIES } from "./prediction.ts";
import { HARNESS_CATALOGUE } from "./harnesses.ts";
import type { PermissionMode } from "./domain.ts";

/** Bumped only for changes capability negotiation can't absorb. */
export const PROTOCOL_VERSION = 1;

/**
 * Features negotiated in `hello`. A Client hides what a Daemon lacks, so an
 * older Daemon keeps working until the Desktop App upgrades it.
 */
export const Capability = Schema.Literals([
  "constellation",
  "constellation.defaults",
  /** `extensions.pair`, `extensions.list`, `extensions.revoke`, and `extensionToken` in `hello`. */
  "extensions",
  "host.resources",
  /** `host.stats.watch`: the Host's CPU, load, memory and disk, sampled while watched (ENG-565). */
  "host.stats",
  /** `host.restartPreview` and `host.prepareRestart`: Restart daemon's confirm and clean stop (ADR 0087). */
  "host.restart",
  /** `remoteAccess.status`, `remoteAccess.enable` and `remoteAccess.disable` (Tailscale, ADR 0076). */
  "remote-access",
  /** `relayRoute.*` and `devices.*`: the Relay route and Linked Devices (ADR 0080, 0082). */
  "linked-devices",
  /** `devices.watch`, and `connectedSince` on each Linked Device: which have a session now (ENG-629). */
  "linked-devices.presence",
  /** A Client announces it when it decodes the `LinkedDevice` Actor; others read it as `Client`. */
  "actor.linked-device",
  /** `voice.transcribe`, `voice.settings` and `voice.setKey` (ADR 0077). */
  "voice",
  /**
   * The Client decodes any `HostInfo.platform` (`windows-x64` and later ones). A Daemon on
   * another platform answers a Client without it with a newer protocol version instead.
   */
  "host.any-platform",
  /** `harness.<kind>`: the Daemon has that Harness's driver (one per catalogue entry). */
  ...HARNESS_CATALOGUE.map((harness) => harness.capability),
  /** `harness.models`: each Harness's Models on this Host. */
  "harness.models",
  /** `harness.commands`: each Harness's Skills and Slash Commands in a directory. */
  "harness.commands",
  /** `harness.availability` and `harness.watchAvailability`: each Harness's status on this Host. */
  "harness.availability",
  /** `harness.spinnerVerbs`: Claude Code's `spinnerVerbs` setting on this Host. */
  "harness.spinner-verbs",
  "workspace.setup",
  "session.steer",
  /** `Steer.attachments`, and the steer's `UserMessage.attachments` (ENG-662). */
  "session.steer-attachments",
  "session.fork",
  /** The `SetModel` command. */
  "session.set-model",
  "session.service-tier",
  "session.terminal-handoff",
  /** `session.terminalCommand`: the argv, cwd and env of the Harness TUI for "Open in terminal". */
  "session.terminal-command",
  /**
   * `ItemProgress` on session streams (running commands, live plans). A Client
   * announces it in `hello`; the Daemon only sends `ItemProgress` to Clients that did.
   */
  "session.live-items",
  /**
   * Subagents: `SubagentStarted`/`SubagentEnded`, a Subagent's own items (with a
   * `subagentId`), and `TurnDetail.subagents`. A Client announces it in `hello`;
   * the Daemon leaves all of these out for Clients that didn't.
   */
  "session.subagents",
  /** Live background task snapshots and SessionBackgroundTasksChanged events. */
  "session.background-tasks",
  /** `session.turns`: older Turns a page at a time. */
  "session.turn-paging",
  /** The `StopBackgroundTasks` command. */
  "session.stop-background",
  /** The `BackgroundCommand` command, and `HarnessModels.backgroundsCommands`. */
  "session.background-command",
  /** `SessionCompacted` and `AgentSession.lastCompaction`; `ContextUsage`'s breakdown fields need nothing. */
  "session.compaction",
  /** `SessionNotified`: an agent's notification for the user (MCP `notify`). */
  "session.notify",
  /**
   * Secret Requests (ADR 0089): the `secret` ApprovalKind, the `Provided` decision and
   * `secret.provide`. A Client without it is sent neither.
   */
  "approval.secret",
  /** `PinSession`, `SessionPinned`, and `AgentSession.pinnedAt` and `origin`. */
  "session.pin",
  /**
   * The `plan` PermissionMode. A Daemon sends a Client without it `supervised` for a planning
   * session; a Client starts a session `supervised` on a Daemon without it.
   */
  "session.plan-mode",
  /** The Limited Session State, `SetResumeAtReset` and `SessionResumeAtResetChanged`. */
  "session.limited",
  /**
   * `Turn.userTurnNumber` and `replyPreview`, and `AgentSession.currentUserTurn` and
   * `lastReplyPreview`: without it they are null, and a Client numbers and times Turns itself.
   */
  "session.user-turns",
  /** `RunShellCommand`, `Turn.shellCommand`, `CommandExecution.origin` and `HarnessModels.runsShellCommands`. */
  "session.shell-command",
  "files.read",
  "files.versioned",
  "files.write",
  "files.manage",
  "files.trash",
  "files.watch-file",
  "files.search",
  "files.watch",
  "inline.propose",
  ...PREDICTION_CAPABILITIES,
  /** `commit.suggestMessage`: a Harness drafts the Commit box's message from the staged diff. */
  "commit.suggest-message",
  /** Optional language extension, advertised only after the corresponding handlers are implemented. */
  "languages",
  "languages.install",
  "languages.trust",
  "languages.format",
  /** `languages.format.project` and discovery's `projectFormatter`: the checkout's own formatter. */
  "languages.project-format",
  "languages.edits",
  "languages.edit-preparation",
  "languages.buffer-acknowledgments",
  "languages.resources",
  "languages.resources.tree-v2",
  "languages.preview-media",
  "git.diff",
  /** `git.diff` answers `fileIndex`: each file's byte range in the patch, and its counts. */
  "git.diff-files",
  /** The `Turns` diff spec: a contiguous run of an Agent Session's Turns. */
  "git.diff-turns",
  /** `git.show`: a file's content at a revision (context expansion in Review). */
  "git.show",
  /** `git.stage`, `git.unstage`, `git.discard` and `git.commit`: the Explorer's Changes tab. */
  "git.write",
  /** `git.init`: a new folder from Open folder becomes a repository with a first commit. */
  "git.init",
  /** `git.watch`: a signal when the index, HEAD or refs move, so Clients refetch `git.status`. */
  "git.watch",
  /** `git.sync` (fetch, pull, push, publish) and `git.status`'s `tracking`. */
  "git.sync",
  /** `git.log`: recent commits' subjects and bodies (the Commit messages preview in Settings). */
  "git.log",
  "attachments.stage",
  /** `attachments.read`: a staged attachment's bytes by id, for a message's images on a phone. */
  "attachments.read",
  /** `attachments.settings`, `attachments.setSettings`, `attachments.clear`: cleanup in Settings. */
  "attachments.settings",
  /** `sessions.autoArchive` and `sessions.setAutoArchive`: archiving Dormant sessions in Settings. */
  "sessions.auto-archive",
  /**
   * Idle compaction (`idleCompaction.ts`): `sessions.idleCompaction`, `sessions.setIdleCompaction`,
   * `CompactSession` and `Turn.idleCompaction`.
   */
  "sessions.idle-compaction",
  /** `sessions.visuals` and `sessions.setVisuals`: the Visuals setting (`visuals.ts`). */
  "sessions.visuals",
  /** `continuity.watch`, `continuity.markRead`, `continuity.saveDraft`: read position and drafts. */
  "session.continuity",
  /** `presence.report`: a Desktop App's presence holds this Host's pushes to Linked Devices. */
  "presence",
  "terminal",
  /** `terminal.attachBinary`: terminal output as raw bytes on the blob channel, not base64 JSON. */
  "terminal.binary",
  "blobs",
  /** `hostAddress.open` and `byteStream.credit`: Host-address streams to the Host's loopback (ADR 0093). */
  "host-address",
  /**
   * `browser.*` and `byteStream.credit`: Browser hosting and Browser streams (ADR 0092). A Client
   * announces it when it can host Browsers; the Daemon refuses `browser.host` from one that didn't.
   */
  "browser.host",
  /** `usage.query` and `usage.watch`: Usage and Plan Limits on this Host. */
  "usage",
  /**
   * The Review commands and events below each need their capability on both
   * sides: a Daemon sends their events only to Clients that announced it.
   */
  /** `SendFeedback` and `Turn.feedback`. */
  "session.feedback",
  /**
   * `AcceptTurns`, `LinkPullRequest`, `TurnsAccepted` / `TurnsReverted` / `SessionPullRequestLinked`,
   * and `session.acceptPlan` / `draftAccept` / `commitAccepted` / `pushAccepted`.
   */
  "session.accept",
  /** The Review Checkout commands, their events, the Host snapshot's checkouts, `review.checkoutStatus`. */
  "review.checkouts",
  /** `review.runRiskSummary`, `review.riskSummary`, `review.watchRiskSummary`. */
  "review.risk-summary",
  /** `review.askFinding`: follow-up questions to the Reviewer. */
  "review.ask",
  /** `RecordVerdict` and `review.verdicts`. */
  "review.verdicts",
  /** `review.reviewerSettings` and `review.setReviewerSettings`: Settings → Reviewer. */
  "review.reviewer-settings",
  /** Independent walkthrough state, Run/Stop RPCs and optional Reviewer settings. */
  "review.walkthrough",
  /** `review.riskSummary` by `LatestAt`: a repository's newest summary at a head, incremental ones too. */
  "review.latest-summary",
  /** `session.acceptPlan` with a null `throughTurnId`: through the latest Turn. */
  "session.accept-latest",
]);

export type Capability = typeof Capability.Type;

const isCapability = Schema.is(Capability);

/**
 * A capability list as it travels in `hello`. Names this build doesn't know are
 * dropped on decode instead of failing, so a newer Client can talk to an older
 * Daemon (and vice versa) and simply not use what the other side lacks.
 */
export const CapabilityList = Schema.Array(Schema.String).pipe(
  Schema.decodeTo(
    Schema.Array(Capability),
    SchemaTransformation.transform<ReadonlyArray<Capability>, ReadonlyArray<string>>({
      decode: (names) => names.filter(isCapability),
      encode: (capabilities) => capabilities,
    })
  )
);

/** The mode a Client sends a Daemon with `capabilities`: `plan` becomes `supervised` without `session.plan-mode`. */
export const permissionModeFor = (
  mode: PermissionMode,
  capabilities: ReadonlyArray<Capability>
): PermissionMode =>
  mode === "plan" && !capabilities.includes("session.plan-mode") ? "supervised" : mode;
