import { PredictionPlacementInputs } from "./predictionPlacement.ts";
import { PredictionOutcomeInputs } from "./predictionOutcomes.ts";
/**
 * The IPC contract's inputs as Effect Schemas: the main process decodes every
 * request and subscription from a renderer with these before acting on it.
 * The renderer imports this file for types only (`import type`), so no Schema
 * code reaches its bundle.
 */
import {
  AcceptBranch,
  ApprovalKind,
  addedNullable,
  AttachmentSettings,
  AutoArchiveSettings,
  IdleCompactionSettings,
  VisualsLevel,
  VisualsSettings,
  MIN_IDLE_COMPACTION_TOKENS,
  Command,
  CommandId,
  CommitGranularity,
  ConstellationId,
  GitDiffSpec,
  Grant,
  HarnessKind,
  PermissionMode,
  ReviewCheckoutId,
  ReviewContext,
  ReviewerSettings,
  ReviewSubject,
  RiskFindingId,
  InlineRequest,
  MAX_DRAFT_LENGTH,
  PairingId,
  RiskSummaryId,
  RiskSummaryRef,
  Sequence,
  SessionId,
  Timestamp,
  SessionSummary,
  TerminalId,
  TurnId,
  Workspace,
  WorkspaceId,
  Worktree,
} from "@polaris/protocol";
import { Schema } from "effect";

import {
  ConstellationDefaultsInputs,
  ConstellationRequestInputs,
  ConstellationStatsInputs,
} from "./constellationContract.ts";
import { ResourceRequestInputs } from "./resourcesContract.ts";
import { RemoteAccessRequestInputs } from "./remoteAccessContract.ts";
import { LinkedDevicesRequestInputs } from "./linkedDevicesContract.ts";
import { VoiceRequestInputs } from "./voiceContract.ts";
import { BrowserRequestInputs, BrowserSubscriptionInputs } from "./browserContract.ts";
import { SecretRequestInputs } from "./secretContract.ts";
import { GitHubRequestInputs, GitHubSubscriptionInputs } from "./githubContract.ts";
import { GitRequestInputs, GitSubscriptionInputs } from "./gitContract.ts";
import { BRANCH_PREFIX } from "./sessionPrefs.ts";
import {
  PredictionUiInputs,
  PredictionCompletionInput,
  EditPredictionInput,
  ManagedSideInput,
} from "./predictionContract.ts";

/** The agent's 128 KiB plus the inlined libraries, with room to spare. */
const FRAME_DOCUMENT_MAX = 4 * 1024 * 1024;

/** A Host's stable key in the HostRegistry: "local", or an SSH alias. */
export const HostKey = Schema.String.check(Schema.isMinLength(1));

export const ThemeSource = Schema.Literals(["system", "dark", "light"]);

export type ThemeSource = typeof ThemeSource.Type;

/** `data-theme-dark`: the dark the app uses (DESIGN.md, Chrome redesign: Themes). */
export const DarkTheme = Schema.Literals(["moonlit", "midnight"]);

export type DarkTheme = typeof DarkTheme.Type;

/** DESIGN.md's density steps; spacing and row heights only. */
export const Density = Schema.Literals(["calm", "balanced", "compact"]);

export type Density = typeof Density.Type;

/** `data-text-size`: scales the type table only (DESIGN.md, Settings). */
export const TextSize = Schema.Literals(["small", "default", "large", "larger"]);

export type TextSize = typeof TextSize.Type;

/** `data-diff-palette`: `cvd` is the colourblind-safe blue and orange. */
export const DiffPalette = Schema.Literals(["default", "cvd"]);

export type DiffPalette = typeof DiffPalette.Type;

/** Reduce Motion: follow macOS, always reduce, or keep motion. */
export const MotionSource = Schema.Literals(["system", "reduce", "full"]);

export type MotionSource = typeof MotionSource.Type;

/** The code face: `--font-mono` on the root. */
export const CodeFont = Schema.Literals(["sf-mono", "menlo"]);

export type CodeFont = typeof CodeFont.Type;

/** The code face's size in px at the default text size (`--code-size`). */
export const CodeFontSize = Schema.Literals([12, 13, 14, 15]);

export type CodeFontSize = typeof CodeFontSize.Type;

/** Any subset of the appearance settings, applied over the current ones. */
export const AppearancePatch = Schema.Struct({
  theme: Schema.optionalKey(ThemeSource),
  darkTheme: Schema.optionalKey(DarkTheme),
  density: Schema.optionalKey(Density),
  textSize: Schema.optionalKey(TextSize),
  diffPalette: Schema.optionalKey(DiffPalette),
  motion: Schema.optionalKey(MotionSource),
  codeFont: Schema.optionalKey(CodeFont),
  codeFontSize: Schema.optionalKey(CodeFontSize),
  wordWrap: Schema.optionalKey(Schema.Boolean),
});

export type AppearancePatch = typeof AppearancePatch.Type;

/** What a new Agent Session of one Harness starts with; null fields take the Harness's default. */
export const SessionDefault = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  permissionMode: PermissionMode,
});

export type SessionDefault = typeof SessionDefault.Type;

export const BranchPrefix = Schema.String.check(Schema.isPattern(BRANCH_PREFIX));

/**
 * Where accepting a session's work commits (ENG-224): `auto` makes a branch only when
 * on the default branch; `current` commits where it is, main included; `create` always branches.
 */
export const AcceptBranchMode = Schema.Literals(["auto", "current", "create"]);

export type AcceptBranchMode = typeof AcceptBranchMode.Type;

/** One role's worker defaults in a new Constellation (spec §4, precedence 3). */
export const RoleDefault = Schema.Struct({
  harness: HarnessKind,
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
});

export type RoleDefault = typeof RoleDefault.Type;

/** Settings → Constellations: the workers' Harness/Model per role, backend and UI/design. */
export const ConstellationDefaults = Schema.Struct({ backend: RoleDefault, ui: RoleDefault });

export type ConstellationDefaults = typeof ConstellationDefaults.Type;

/** Whole minutes, 1 to 999: the field's range in Settings → Sessions. */
export const LongTurnMinutes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999 }));

/** Settings → Sessions, idle compaction: one setting the Desktop App writes to every Host. */
export const IdleCompactionPref = Schema.Struct({
  enabled: Schema.Boolean,
  minTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_IDLE_COMPACTION_TOKENS)),
});

export type IdleCompactionPref = typeof IdleCompactionPref.Type;

/** Settings → Sessions: how every new Agent Session starts and what happens around it. */
export const SessionPrefs = Schema.Struct({
  /** Start on a new Worktree rather than in the Workspace directory. */
  newWorktree: Schema.Boolean,
  /** What a branch taken from the prompt starts with ("polaris/"). */
  branchPrefix: BranchPrefix,
  /** A Turn's first edit opens Output. */
  openOutputOnEdit: Schema.Boolean,
  /** Native notifications when a session needs you. */
  notifyNeedsYou: Schema.Boolean,
  /** Native notifications when a session's Turn ends and it goes Idle (off by default). */
  notifyTurnEnded: Schema.Boolean,
  /** With `notifyTurnEnded`: only Turns longer than `longTurnMinutes` notify (off by default). */
  notifyLongTurnsOnly: Schema.Boolean,
  /** How long a Turn runs before it counts as long, in minutes (5 by default). */
  longTurnMinutes: LongTurnMinutes,
  /** Native notifications when someone requests your review on GitHub (ENG-229). */
  notifyReviewRequests: Schema.Boolean,
  /** Polaris's own notifications when a Constellation needs you (ENG-462; on by default). */
  notifyConstellations: Schema.Boolean,
  /** Hosts hold pushes to linked phones while the user is at this computer (ENG-495; on by default). */
  quietPhoneWhilePresent: Schema.Boolean,
  /** Archive deletes a session's branch once it is merged; unmerged branches always stay. */
  deleteMergedBranch: Schema.Boolean,
  /** The Working strip's verbs; null for the built-in ones (Claude Code's own settings come first). */
  spinnerVerbs: Schema.NullOr(Schema.Array(Schema.String)),
  /** Where accepted work is committed, unless the Workspace says otherwise. */
  acceptBranch: AcceptBranchMode,
  /** Per-Workspace overrides of `acceptBranch`, keyed `hostKey/workspaceId`. */
  workspaceAcceptBranch: Schema.Record(Schema.String, AcceptBranchMode),
  /** What a new Constellation's workers start on, per role (Settings → Constellations). */
  constellationDefaults: ConstellationDefaults,
  /** Compact a large session idle for 55 minutes, while its prompt cache is warm (ENG-562). */
  idleCompaction: IdleCompactionPref,
  /** How readily agents draw a visualization (ENG-598); written to every Host. */
  visuals: VisualsLevel,
  /** Settings → Editor: vim keys in the Editor (off by default, spec §4). */
  editorVim: Schema.Boolean,
  /** Settings → Editor: save after a short pause in typing (off by default, spec §3). */
  editorAutosave: Schema.Boolean,
  /** Settings → Editor: each line's most severe diagnostic at its end (on by default). */
  editorInlineDiagnostics: Schema.Boolean,
  /** Settings → Editor: the Harness and Model that write commit messages (a small, fast one). */
  commitMessages: RoleDefault,
});

export type SessionPrefs = typeof SessionPrefs.Type;

export const SessionPrefsPatch = Schema.Struct({
  newWorktree: Schema.optionalKey(Schema.Boolean),
  branchPrefix: Schema.optionalKey(BranchPrefix),
  openOutputOnEdit: Schema.optionalKey(Schema.Boolean),
  notifyNeedsYou: Schema.optionalKey(Schema.Boolean),
  notifyTurnEnded: Schema.optionalKey(Schema.Boolean),
  notifyLongTurnsOnly: Schema.optionalKey(Schema.Boolean),
  longTurnMinutes: Schema.optionalKey(LongTurnMinutes),
  notifyReviewRequests: Schema.optionalKey(Schema.Boolean),
  notifyConstellations: Schema.optionalKey(Schema.Boolean),
  quietPhoneWhilePresent: Schema.optionalKey(Schema.Boolean),
  deleteMergedBranch: Schema.optionalKey(Schema.Boolean),
  spinnerVerbs: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  acceptBranch: Schema.optionalKey(AcceptBranchMode),
  /** Replaces every override. */
  workspaceAcceptBranch: Schema.optionalKey(Schema.Record(Schema.String, AcceptBranchMode)),
  constellationDefaults: Schema.optionalKey(ConstellationDefaults),
  idleCompaction: Schema.optionalKey(IdleCompactionPref),
  visuals: Schema.optionalKey(VisualsLevel),
  editorVim: Schema.optionalKey(Schema.Boolean),
  editorAutosave: Schema.optionalKey(Schema.Boolean),
  editorInlineDiagnostics: Schema.optionalKey(Schema.Boolean),
  commitMessages: Schema.optionalKey(RoleDefault),
});

export type SessionPrefsPatch = typeof SessionPrefsPatch.Type;

const onHost = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct({ hostKey: HostKey, ...fields });

/** A `~/.ssh/config` alias; never starts with "-" (it would read as an ssh option). */
export const SshAlias = Schema.String.check(Schema.isPattern(/^[^-\s][^\s]*$/));

/** A machine's colour: an identity hue name from `@polaris/ui` or a hex colour. */
export const MachineColour = Schema.String.check(Schema.isPattern(/^(#[0-9a-fA-F]{6}|[a-z-]+)$/));

/** A Host's last synchronized state, painted at launch before its Daemon answers (ENG-175). */
export const CachedHost = Schema.Struct({
  hostKey: HostKey,
  sequence: Sequence,
  workspaces: Schema.Array(Workspace),
  worktrees: Schema.Array(Worktree),
  sessions: Schema.Array(SessionSummary),
});

export type CachedHost = typeof CachedHost.Type;

/** A Review a notification opens (`ReviewTarget` in `needsYou.ts`). */
const ReviewTargetInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pull"),
    repo: Schema.Struct({ owner: Schema.String, name: Schema.String }),
    number: Schema.Int,
    pullId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("session"), hostKey: HostKey, sessionId: Schema.String }),
]);

/** Every request a renderer can make, keyed by method. Outputs are in `api.ts`. */
export const RequestInputs = {
  ...PredictionUiInputs,
  ...PredictionPlacementInputs,
  ...PredictionOutcomeInputs,
  "settings.get": Schema.Struct({}),
  "updates.get": Schema.Struct({}),
  "updates.check": Schema.Struct({}),
  "updates.setAutomatic": Schema.Struct({ enabled: Schema.Boolean }),
  "updates.restart": Schema.Struct({}),
  "updates.showInFinder": Schema.Struct({}),
  "cache.get": Schema.Struct({}),
  "cache.put": Schema.Struct({ host: CachedHost }),
  "settings.setTheme": Schema.Struct({ theme: ThemeSource }),
  "settings.setDensity": Schema.Struct({ density: Density }),
  "settings.setAppearance": Schema.Struct({ patch: AppearancePatch }),
  /** Null clears the Harness's defaults. */
  "settings.setSessionDefault": Schema.Struct({
    harness: HarnessKind,
    value: Schema.NullOr(SessionDefault),
  }),
  "settings.setSessions": Schema.Struct({ patch: SessionPrefsPatch }),
  /** Opens a URL in the user's browser; https only (a catalogue `docsUrl`). */
  "shell.openExternal": Schema.Struct({
    url: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  }),
  /** A Visualization's frame document (`@polaris/visualization`), to load in its sandboxed frame. */
  "visualization.serve": Schema.Struct({
    document: Schema.String.check(Schema.isMaxLength(FRAME_DOCUMENT_MAX)),
  }),
  /** Shows a file or folder in Finder or Explorer: the local Host's, or a WSL distro's (`main/reveal.ts`). */
  "shell.revealInFinder": onHost({ path: Schema.String.check(Schema.isPattern(/^\//)) }),
  "host.retryNow": onHost({}),
  dispatch: onHost({ commandId: CommandId, command: Command }),
  "files.listDir": onHost({ path: Schema.String }),
  "files.stat": onHost({ path: Schema.String }),
  "files.read": onHost({
    path: Schema.String,
    offset: Schema.NullOr(Schema.Int),
    length: Schema.NullOr(Schema.Int),
  }),
  "files.searchPaths": onHost({ root: Schema.String, query: Schema.String, limit: Schema.Int }),
  "files.grep": onHost({
    root: Schema.String,
    pattern: Schema.String,
    regex: Schema.Boolean,
    caseSensitive: Schema.Boolean,
    limit: Schema.Int,
  }),
  /** M3 Editor: the file with its version (capability `files.versioned`). */
  "files.readVersioned": onHost({ path: Schema.String }),
  /** M3 Editor: a save, refused when the disk moved on from `expected` (capability `files.write`). */
  "files.write": onHost({
    path: Schema.String,
    text: Schema.String,
    expected: Schema.Struct({ mtimeMs: Schema.Number, size: Schema.Int, hash: Schema.String }),
  }),
  "git.diff": onHost({ cwd: Schema.String, spec: GitDiffSpec }),
  /** A file at a revision (capability `git.show`): Review's context expansion. */
  "git.show": onHost({ cwd: Schema.String, revision: Schema.String, path: Schema.String }),
  /** The explorer's file operations (capability `files.manage`). */
  "files.create": onHost({ path: Schema.String, kind: Schema.Literals(["file", "directory"]) }),
  "files.rename": onHost({ path: Schema.String, destination: Schema.String }),
  /** `permanent` only after the user confirmed; without it a Host with no trash refuses. */
  "files.delete": onHost({ path: Schema.String, permanent: Schema.Boolean }),
  /** A Harness's Models on the Host (capability `harness.models`); `refresh` asks the Harness again. */
  "harness.models": onHost({ harness: HarnessKind, refresh: Schema.Boolean }),
  /** A Harness's Skills and Slash Commands in a directory (capability `harness.commands`). */
  "harness.commands": onHost({
    harness: HarnessKind,
    cwd: Schema.String,
    refresh: Schema.Boolean,
  }),
  "harness.spinnerVerbs": onHost({ cwd: Schema.NullOr(Schema.String) }),
  /** Each catalogue Harness's status on the Host (capability `harness.availability`). */
  "harness.availability": onHost({ refresh: Schema.Boolean }),
  "session.terminalCommand": onHost({ sessionId: SessionId }),
  "session.turns": onHost({ sessionId: SessionId, beforeIndex: Schema.Int, limit: Schema.Int }),
  /** Hourly Usage buckets overlapping `[from, to)` (capability `usage`). */
  "usage.query": onHost({
    from: Timestamp,
    to: Timestamp,
    harness: Schema.NullOr(HarnessKind),
    sessionId: Schema.NullOr(SessionId),
  }),
  "terminal.open": onHost({
    cwd: Schema.String,
    cols: Schema.Int,
    rows: Schema.Int,
    argv: Schema.NullOr(Schema.Array(Schema.String)),
  }),
  "terminal.input": onHost({ terminalId: TerminalId, data: Schema.Uint8Array }),
  "terminal.resize": onHost({ terminalId: TerminalId, cols: Schema.Int, rows: Schema.Int }),
  "terminal.close": onHost({ terminalId: TerminalId }),
  /** Pasted or dropped bytes: sent as a blob, then staged, on one connection. */
  "attachments.stage": onHost({
    sessionId: Schema.NullOr(SessionId),
    workspaceId: WorkspaceId,
    name: Schema.String,
    mimeType: Schema.String,
    bytes: Schema.Uint8Array,
  }),
  /** Attachment cleanup (Settings → Attachments): the Host's policy and what it has staged. */
  "attachments.settings": onHost({}),
  "attachments.setSettings": onHost({ settings: AttachmentSettings }),
  /** When the Host archives Dormant sessions (Settings → Sessions). */
  "sessions.autoArchive": onHost({}),
  "sessions.setAutoArchive": onHost({ settings: AutoArchiveSettings }),
  "sessions.idleCompaction": onHost({}),
  "sessions.setIdleCompaction": onHost({ settings: IdleCompactionSettings }),
  /** The Visuals setting (capability `sessions.visuals`): how readily agents draw. */
  "sessions.visuals": onHost({}),
  "sessions.setVisuals": onHost({ settings: VisualsSettings }),
  /** Continuity (capability `session.continuity`): the last Turn seen, and the composer's draft. */
  "continuity.markRead": onHost({ sessionId: SessionId, turnId: TurnId }),
  "continuity.saveDraft": onHost({
    sessionId: SessionId,
    text: Schema.String.check(Schema.isMaxLength(MAX_DRAFT_LENGTH)),
  }),
  /** Deletes staged attachments now: one Workspace's, or all of them (null). */
  "attachments.clear": onHost({ workspaceId: Schema.NullOr(WorkspaceId) }),
  /** Settings → Extensions: a Host's Pairings; pairing returns the token once. */
  "extensions.list": onHost({}),
  "extensions.pair": onHost({ name: Schema.String, grant: Grant }),
  "extensions.revoke": onHost({ id: PairingId }),
  /** Start a Risk Summary (Rules, then the Reviewer), or answer the cached one. */
  "review.runRiskSummary": onHost({
    workspaceId: WorkspaceId,
    subject: ReviewSubject,
    checkoutId: Schema.NullOr(ReviewCheckoutId),
    since: Schema.NullOr(Schema.String),
    refresh: Schema.Boolean,
    context: Schema.NullOr(ReviewContext),
  }),
  "review.runWalkthrough": onHost({
    summaryId: RiskSummaryId,
    context: addedNullable(ReviewContext),
  }),
  "review.stopWalkthrough": onHost({ summaryId: RiskSummaryId }),
  "review.riskSummary": onHost({ ref: RiskSummaryRef }),
  /** Verdicts on this Host, newest first: a repo's, a summary's, or one Finding's history. */
  "review.verdicts": onHost({
    repo: Schema.NullOr(Schema.String),
    summaryId: Schema.NullOr(RiskSummaryId),
    identity: Schema.NullOr(Schema.String),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
  }),
  /** A follow-up to the Reviewer, about one Finding or the whole change. */
  "review.askFinding": onHost({
    summaryId: RiskSummaryId,
    findingId: Schema.NullOr(RiskFindingId),
    question: Schema.String,
  }),
  /** Settings → Reviewer: the Host's settings and the Reviewer a Workspace would run. */
  "review.reviewerSettings": onHost({ workspaceId: Schema.NullOr(WorkspaceId) }),
  "review.setReviewerSettings": onHost({ settings: ReviewerSettings }),
  /** Accepting a session's work (capability `session.accept`): plan, draft, commit, push. */
  "session.acceptPlan": onHost({ sessionId: SessionId, throughTurnId: Schema.NullOr(TurnId) }),
  "session.draftAccept": onHost({ sessionId: SessionId, throughTurnId: TurnId }),
  "session.commitAccepted": onHost({
    sessionId: SessionId,
    throughTurnId: TurnId,
    branch: AcceptBranch,
    granularity: CommitGranularity,
    title: Schema.String,
    body: Schema.String,
    turnTitles: Schema.Array(Schema.String),
  }),
  "session.pushAccepted": onHost({ sessionId: SessionId, branch: Schema.String }),
  /** The literal `Host` aliases in `~/.ssh/config` (Includes followed, wildcards skipped). */
  "machines.sshAliases": Schema.Struct({}),
  /** The WSL distros on this Windows machine (`unsupported` elsewhere). */
  "machines.wslDistros": Schema.Struct({}),
  /** Adds a remote Host by alias (or a WSL distro by name) and checks it: probe, then ask to install. */
  "machines.add": Schema.Struct({
    kind: Schema.optionalKey(Schema.Literals(["ssh", "wsl"])),
    alias: SshAlias,
    label: Schema.String,
    colour: Schema.NullOr(MachineColour),
    forwardAgent: Schema.Boolean,
  }),
  /** Changes a remote Host's settings; a changed transport reconnects it. */
  "machines.update": onHost({
    label: Schema.optionalKey(Schema.String),
    colour: Schema.optionalKey(Schema.NullOr(MachineColour)),
    forwardAgent: Schema.optionalKey(Schema.Boolean),
    /** The remote command as one shell line; null restores the default. */
    remoteCommand: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  "machines.remove": onHost({}),
  /** Probe the Host and plan again (the user asked): may install an approved build. */
  "machines.check": onHost({}),
  /** Update an installed Daemon now; never performs a first install. */
  "machines.updateDaemon": onHost({}),
  "machines.setKeepDaemonsUpToDate": Schema.Struct({ enabled: Schema.Boolean }),
  /** Null restores the app-wide default, including for this Mac. */
  "machines.setDaemonUpdateOverride": onHost({ enabled: Schema.NullOr(Schema.Boolean) }),
  /** "Approve and install": records the SHA-256 for this Host, then installs. */
  "machines.approve": onHost({ sha256: Schema.String }),
  /** "Not now". */
  "machines.dismiss": onHost({}),
  /** "Take over sign-in task", confirmed: reruns the held Windows install with `--replace-task`. */
  "machines.takeOverTask": onHost({}),
  /** Restart the installed Daemon's service (`polaris install` with the current build). */
  "machines.startDaemon": onHost({}),
  /** Restart daemon's confirm: whether it may run now and what it would interrupt. */
  "machines.restartPreview": onHost({}),
  /** Restart daemon: through the Host's service manager; answers once it's back or failed. */
  "machines.restartDaemon": onHost({}),
  /** Switch the local Host on or off on this machine. */
  "machines.setLocalEnabled": Schema.Struct({ enabled: Schema.Boolean }),
  /**
   * Opens a terminal on this Client running `ssh <alias>` (to trust a host key); the
   * fallback when the local Host is off, since the in-app terminal runs on a Daemon.
   */
  "machines.openSsh": onHost({}),
  "clipboard.write": Schema.Struct({ text: Schema.String }),
  /** A secret (a link string): cleared after a minute if it is still on the clipboard. */
  "clipboard.writeSecret": Schema.Struct({ text: Schema.String }),
  /** The Edit menu's own action on the focused field (a context menu's Cut, Copy, Paste). */
  "edit.run": Schema.Struct({ action: Schema.Literals(["cut", "copy", "paste", "selectAll"]) }),
  /** Windows: the app menu, dropped from the title bar's lockup. */
  "app.menu": Schema.Struct({}),
  /** What onboarding found on this Mac: the Host aliases in `~/.ssh/config`, and the app's version. */
  "onboarding.found": Schema.Struct({}),
  /** "Get started": the welcome isn't shown again. */
  "onboarding.welcomeSeen": Schema.Struct({}),
  /** The native folder picker, for a Workspace on the local Host; null when cancelled. */
  "dialog.pickFolder": Schema.Struct({}),
  /** The Editor's unsaved files, for the quit prompt (main/editorQuit.ts). */
  "editor.publishDirty": Schema.Struct({
    files: Schema.Array(
      Schema.Struct({ hostKey: HostKey, path: Schema.String, unkept: Schema.Boolean })
    ),
  }),
  /** "Save and quit" finished: whether every file saved. */
  "editor.savedAll": Schema.Struct({ ok: Schema.Boolean }),
  /** The renderer's Needs You summary, for the menu bar star, Dock badge and notifications. */
  "needsYou.publish": Schema.Struct({
    count: Schema.Int,
    sessions: Schema.Array(
      Schema.Struct({
        hostKey: HostKey,
        hostLabel: Schema.String,
        workspace: Schema.NullOr(Schema.String),
        sessionId: Schema.String,
        title: Schema.String,
        harness: Schema.String,
        requests: Schema.Array(
          Schema.Struct({
            requestId: Schema.String,
            kind: ApprovalKind,
            title: Schema.String,
            detail: Schema.NullOr(Schema.String),
            options: Schema.Array(Schema.String),
          })
        ),
      })
    ),
    focused: Schema.NullOr(Schema.Struct({ hostKey: HostKey, sessionId: Schema.String })),
    turns: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          hostKey: HostKey,
          hostLabel: Schema.String,
          sessionId: Schema.String,
          title: Schema.String,
          harness: Schema.String,
          state: Schema.Literals(["working", "idle"]),
          reply: Schema.NullOr(Schema.String),
          digestStarted: Schema.optionalKey(Schema.Boolean),
          backgroundTasks: Schema.Int,
          userTurn: Schema.NullOr(Schema.Struct({ id: Schema.String, startedAt: Schema.String })),
          updatedAt: Schema.String,
          review: Schema.optionalKey(
            Schema.Struct({
              kind: Schema.Literals(["reviewer", "walkthrough"]),
              change: Schema.String,
              target: Schema.NullOr(ReviewTargetInput),
              findings: Schema.NullOr(Schema.Struct({ open: Schema.Int, critical: Schema.Int })),
            })
          ),
        })
      )
    ),
    notifications: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          hostKey: HostKey,
          hostLabel: Schema.String,
          sessionId: Schema.String,
          sessionTitle: Schema.String,
          id: Schema.String,
          title: Schema.String,
          body: Schema.String,
        })
      )
    ),
    reviewing: Schema.optionalKey(Schema.NullOr(ReviewTargetInput)),
  }),
  /** Dev only: a fresh temporary directory on the dev Daemon's Host for the proof session. */
  "dev.proofWorkspace": Schema.Struct({}),
  ...GitHubRequestInputs,
  ...GitRequestInputs,
  ...ConstellationRequestInputs,
  ...ConstellationDefaultsInputs,
  ...ConstellationStatsInputs,
  ...ResourceRequestInputs,
  ...RemoteAccessRequestInputs,
  ...LinkedDevicesRequestInputs,
  ...VoiceRequestInputs,
  ...BrowserRequestInputs,
  ...SecretRequestInputs,
} as const;

export type RequestMethod = keyof typeof RequestInputs;

export type RequestInput<M extends RequestMethod> = (typeof RequestInputs)[M]["Type"];

/** What `request` sends: the method, and its input, decoded against `RequestInputs[method]`. */
export const RequestEnvelope = Schema.Struct({ method: Schema.String, input: Schema.Unknown });

export type RequestEnvelope = typeof RequestEnvelope.Type;

/** What `subscribe` sends; the input is decoded against `SubscriptionInputs[kind]`. */
export const SubscribeEnvelope = Schema.Struct({
  id: Schema.Int,
  kind: Schema.String,
  input: Schema.Unknown,
});

export type SubscribeEnvelope = typeof SubscribeEnvelope.Type;

export const UnsubscribeEnvelope = Schema.Struct({ id: Schema.Int });

/** Every live feed a renderer can open, keyed by kind. Items are in `api.ts`. */
export const SubscriptionInputs = {
  "prediction.complete": PredictionCompletionInput,
  "prediction.edit": EditPredictionInput,
  /** The managed model server's status now and on every change (`prediction.managed.watch`). */
  "prediction.managed.watch": ManagedSideInput,
  /** The Host list with each Host's Connection State; the whole list on every change. */
  hosts: Schema.Struct({}),
  /** The machines for Settings: each Host's settings, Connection State and install flow. */
  machines: Schema.Struct({}),
  host: onHost({}),
  session: onHost({ sessionId: SessionId, turnLimit: Schema.NullOr(Schema.Int) }),
  terminal: onHost({ terminalId: TerminalId }),
  "files.watch": onHost({ root: Schema.String }),
  /** One open file's version, then a change per write and null once deleted (`files.watch-file`). */
  "files.watchFile": onHost({ path: Schema.String }),
  /** Plan Limits (every known one first) and Usage changes on a Host (capability `usage`). */
  usage: onHost({}),
  /** Each catalogue Harness's status as it changes (`harness.watchAvailability`). */
  "harness.availability": onHost({}),
  /** Every session's read position and draft on a Host, then changes (`continuity.watch`). */
  continuity: onHost({}),
  /** Plan Limits as they change (`usage.watch`, its `PlanLimitChanged` items). */
  "plan-limits": onHost({}),
  /** The Host's CPU, load, memory and disk: `History`, then a sample per interval (`host.stats`). */
  "host.stats": onHost({}),
  /** The Linked Devices with their presence, then again on every change (`devices.watch`). */
  "devices.watch": onHost({}),
  /** A Risk Summary as it fills in (`review.watchRiskSummary`): the whole summary on each change. */
  "review.watchRiskSummary": onHost({ summaryId: RiskSummaryId }),
  /** An inline proposal (`inline.propose`, capability `inline.propose`); closing it cancels. */
  "inline.propose": onHost(InlineRequest.fields),
  ...GitHubSubscriptionInputs,
  ...GitSubscriptionInputs,
  ...BrowserSubscriptionInputs,
  /** One Constellation's stream (`constellation.subscribe`): Snapshot, Synchronized, then events. */
  constellation: Schema.Struct({
    hostKey: HostKey,
    constellationId: ConstellationId,
    afterSequence: Schema.NullOr(Sequence),
  }),
} as const;

export type SubscriptionKind = keyof typeof SubscriptionInputs;

export type SubscriptionInput<K extends SubscriptionKind> = (typeof SubscriptionInputs)[K]["Type"];

/** Optional language tables are registered by C1 when implementations are available. */
export {
  LanguageRequestInputs,
  LanguageRequestOutputs,
  LanguageSubscriptionInputs,
  LanguageSubscriptionItems,
} from "./languages.ts";
