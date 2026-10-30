import type { PredictionPlacementOutputs } from "./predictionPlacement.ts";
import type {
  PredictionOutcomeOutputs,
  PredictionNotification,
  PredictionNotificationInput,
} from "./predictionOutcomes.ts";
/**
 * The typed bridge between the main process and the renderer: channel names,
 * what every request returns, what every subscription delivers, and the API
 * the preload script exposes as `window.polaris`. Types plus plain constants
 * only, so the renderer and the sandboxed preload can import it.
 */
import type {
  AcceptCommitted,
  AcceptDraft,
  AcceptPlan,
  AcceptPushed,
  AskFinding,
  Attachment,
  AttachmentSettings,
  AutoArchiveSettings,
  IdleCompactionSettings,
  VisualsSettings,
  AttachmentUsage,
  StagedAmount,
  Capability,
  PairExtension,
  Pairing,
  ConnectionState,
  FileChangeEvent,
  FileEntry,
  DiffFile,
  GetReviewerSettings,
  GetRiskSummary,
  ListVerdicts,
  Grep,
  HarnessCommands,
  HarnessModels,
  SpinnerVerbs,
  HostHarnesses,
  HostInfo,
  HostStreamItem,
  ConstellationResult,
  ConstellationSettings,
  ConstellationStats,
  StatsUsage,
  HostResourcesSnapshot,
  RemoteAccessStatus,
  ConstellationStreamItem,
  PlanLimit,
  InlineStreamItem,
  RiskSummary,
  RunRiskSummary,
  RunWalkthrough,
  SearchPaths,
  SessionStreamItem,
  ComposerDraft,
  ContinuityItem,
  HostStatsItem,
  ReadPosition,
  TerminalId,
  TerminalLaunch,
  TurnPage,
  UsageBucket,
  UsageReport,
  UsageStreamItem,
} from "@polaris/protocol";
import type { Rpc } from "effect/rpc";
import type { CommandId } from "./keymap.ts";
import type {
  PredictionUiOutputs,
  PredictionFeedItem,
  EditPredictionFeedItem,
} from "./predictionContract.ts";
import type { AppUpdateView } from "./appUpdates.ts";
import type { PullRef } from "./github.ts";
import type { ConstellationDefaultsMethod, ConstellationMethod } from "./constellationContract.ts";
import type { ResourceMethod } from "./resourcesContract.ts";
import type { RemoteAccessMethod } from "./remoteAccessContract.ts";
import type { RestartDaemonResult, RestartPreviewView } from "./restart.ts";
import type { VoiceRequestOutputs } from "./voiceContract.ts";
import type { SecretRequestOutputs } from "./secretContract.ts";
import type { LinkedDeviceView, LinkedDevicesRequestOutputs } from "./linkedDevicesContract.ts";
import type { GitHubRequestOutputs, GitHubSubscriptionItems } from "./githubContract.ts";
import type { GitRequestOutputs, GitSubscriptionItems } from "./gitContract.ts";
import type { BrowserRequestOutputs, BrowserSubscriptionItems } from "./browserContract.ts";
import type { NeedsYouAction, ReviewTarget } from "./needsYou.ts";
import type {
  CachedHost,
  CodeFont,
  CodeFontSize,
  DarkTheme,
  Density,
  DiffPalette,
  MotionSource,
  RequestInput,
  RequestMethod,
  SubscriptionInput,
  SessionDefault,
  SessionPrefs,
  SubscriptionKind,
  TextSize,
  ThemeSource,
} from "./contract.ts";

export type {
  AppearancePatch,
  CachedHost,
  CodeFont,
  CodeFontSize,
  DarkTheme,
  Density,
  DiffPalette,
  MotionSource,
  SessionDefault,
  SessionPrefs,
  SessionPrefsPatch,
  TextSize,
  RequestInput,
  RequestMethod,
  SubscriptionInput,
  SubscriptionKind,
  ThemeSource,
} from "./contract.ts";

export const CHANNELS = {
  /** renderer → main, `invoke(request, RequestEnvelope)` → `Result`. */
  request: "polaris:request",
  predictionOutcome: "prediction.outcome",
  predictionKeystrokes: "prediction.keystrokes",
  /** renderer → main, `send(subscribe, SubscribeEnvelope)`. */
  subscribe: "polaris:subscribe",
  /** renderer → main, `send(unsubscribe, { id })`. */
  unsubscribe: "polaris:unsubscribe",
  /** main → renderer: every subscription's items since the last flush, in one message. */
  batch: "polaris:batch",
  /** main → renderer: an `AppEvent` (a menu command, a changed appearance). */
  app: "polaris:app",
} as const;

/** A failure crossing IPC: the tagged error's tag and message, nothing that can't be cloned. */
export interface IpcError {
  readonly languageError?: Pick<
    import("@polaris/protocol").LanguageError,
    "_tag" | "reason" | "message" | "retryable"
  >;
  /** The failure's tag, e.g. "NotConnected", "FileError", "InvalidInput". */
  readonly code: string;
  readonly message: string;
  /** A Constellation refusal's findings, so the renderer can word each by its code. */
  readonly findings?: ReadonlyArray<IpcFinding>;
}

export interface IpcFinding {
  readonly code: string;
  readonly message: string;
  readonly fix: string;
}

export type Result<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: IpcError };

// ── Hosts ───────────────────────────────────────────────────────────────────

export interface ConnectionFailureView {
  readonly kind: "transient" | "needs-attention";
  readonly reason: string;
  readonly detail: string;
  /** A protocol-mismatch on versions: the side speaking the older protocol. */
  readonly older?: "daemon" | "client" | undefined;
}

/** `ConnectionStatus` from `@polaris/client`, flattened for structured clone. */
export interface ConnectionStatusView {
  readonly state: ConnectionState;
  readonly failure: ConnectionFailureView | null;
  readonly attempt: number;
  readonly since: number;
  readonly nextAttemptAt: number | null;
  readonly host: HostInfo | null;
  readonly capabilities: ReadonlyArray<Capability>;
  readonly epoch: number;
  /** Main-issued language lifetime; absent for unauthenticated or older connections. */
  readonly languageConnectionEpoch?: number;
  /** Round trip when this connection opened, in ms; null if unmeasured. */
  readonly latencyMs: number | null;
  /** When the last good connection ended; null while connected or never. */
  readonly lastSeenAt: number | null;
}

export type HostKind = "local" | "ssh" | "wsl" | "socket";

export interface HostView {
  readonly key: string;
  readonly label: string;
  /** From the machine settings; null picks a neutral. */
  readonly colour: string | null;
  /** The `~/.ssh/config` alias or WSL distro; null for the local Host and socket Hosts. */
  readonly alias: string | null;
  /**
   * How the Host is reached: this machine's own Host, ssh, a WSL distro, or another Daemon's
   * socket on this machine (`POLARIS_DESKTOP_EXTRA_HOSTS`, for dev and screenshots).
   */
  readonly kind: HostKind;
  /** The Daemon runs the scripted bench Harness (the dev Daemon): the proof session may run here. */
  readonly proofHarness: boolean;
  readonly status: ConnectionStatusView;
}

// ── Machines ────────────────────────────────────────────────────────────────

/** A literal alias from `~/.ssh/config`, with where it points when its block says. */
export interface SshAliasView {
  readonly alias: string;
  readonly hostName: string | null;
  readonly user: string | null;
}

/** A WSL distro on this Windows machine, for "Add a host" (`src/main/machines/wsl.ts`). */
export interface WslDistroView {
  readonly name: string;
  readonly version: number;
  readonly state: "running" | "stopped" | "unknown";
  readonly isDefault: boolean;
  /** Why it can't be a Host (a WSL 1 distro); null when it can. */
  readonly unsupported: string | null;
}

export interface WslDistrosView {
  /** `unsupported`: not Windows; `not-installed`: no wsl.exe or the stub; `no-distros`: WSL without a distro. */
  readonly status: "distros" | "no-distros" | "not-installed" | "unsupported" | "failed";
  readonly distros: ReadonlyArray<WslDistroView>;
  /** wsl.exe's own line, for `not-installed` and `failed`. */
  readonly detail: string | null;
}

/** The install flow's step (`src/main/machines/installFlow.ts`). */
export type InstallStepView =
  | "idle"
  | "checking"
  | "approval"
  | "dismissed"
  | "installing"
  | "ready"
  | "blocked";

export interface InstallFlowView {
  readonly step: InstallStepView;
  /** Checking or installing: what is happening now, for the progress line. */
  readonly activity: string | null;
  readonly offer: {
    readonly platform: string;
    readonly version: string;
    readonly sha256: string;
    readonly sizeBytes: number | null;
  } | null;
  readonly outcome: {
    readonly kind: "current" | "newer" | "installed" | "upgraded";
    readonly version: string;
    readonly from: string | null;
    readonly notes: ReadonlyArray<string>;
    readonly adminCommand: string | null;
  } | null;
  readonly problem: {
    readonly kind:
      | "unsupported"
      | "missing-build"
      | "host-setup"
      | "ssh"
      | "failed"
      | "task-conflict";
    readonly message: string;
    readonly command: string | null;
    /** `task-conflict`: the Windows sign-in task, and the Polaris home it runs (null: not Polaris'). */
    readonly conflict?: { readonly task: string; readonly otherHome: string | null };
  } | null;
}

/** One machine in Settings: the local Host or a remote one by alias. */
export interface MachineView {
  /** Null until update facts have loaded; updates never perform a first install. */
  readonly daemon: import("./daemonUpdates.ts").DaemonUpdateView | null;
  readonly key: string;
  readonly label: string;
  readonly colour: string | null;
  /** Null for the local Host. */
  readonly alias: string | null;
  /** How the Host is reached; for "wsl" the alias is the distro name. */
  readonly kind: "local" | "ssh" | "wsl";
  /** Where the alias points, from `~/.ssh/config`. */
  readonly target: { readonly hostName: string | null; readonly user: string | null } | null;
  /** The local Host can be switched off on this machine; remote Hosts are always on. */
  readonly enabled: boolean;
  readonly forwardAgent: boolean;
  /** The remote command override as one shell line; null for the default. */
  readonly remoteCommand: string | null;
  /** A Windows SSH Host's DefaultShell, once its probe found it: it ignores `remoteCommand`. */
  readonly windowsShell?: "powershell" | "cmd";
  /** Null while the local Host is switched off. */
  readonly status: ConnectionStatusView | null;
  /** Null for the local Host (Polaris never installs on this Mac from here). */
  readonly install: InstallFlowView | null;
}

/** A Schema class instance after structured clone: its fields, without the prototype. */
export type Plain<T> = { readonly [K in keyof T]: T[K] };

// ── Requests ────────────────────────────────────────────────────────────────

/**
 * How the renderer looks, as root attributes: `data-theme` (unset for "system"),
 * `data-theme-dark`, `data-density`, `data-text-size`, `data-diff-palette`, `data-reduce-motion`, and the code face.
 */
export interface Appearance {
  readonly theme: ThemeSource;
  /** Which dark: Moonlit (the default) or Midnight. */
  readonly darkTheme: DarkTheme;
  readonly density: Density;
  readonly textSize: TextSize;
  readonly diffPalette: DiffPalette;
  readonly motion: MotionSource;
  readonly codeFont: CodeFont;
  readonly codeFontSize: CodeFontSize;
  /** View → Word wrap: long lines wrap in the Changes rail, Review and the Editor. */
  readonly wordWrap: boolean;
}

/** Each Harness's defaults for new sessions, by kind. */
export type SessionDefaults = Readonly<Record<string, SessionDefault>>;

export interface SettingsView extends Appearance {
  readonly sessionDefaults: SessionDefaults;
  /** Settings → Sessions, defaults filled in. */
  readonly sessions: SessionPrefs;
  /** This build's version, for About Polaris. */
  readonly version: string;
  /** False until the user pressed "Get started" on the welcome. */
  readonly welcomeSeen: boolean;
  readonly hosts: ReadonlyArray<{
    readonly alias: string;
    readonly label: string;
    readonly colour: string | null;
    readonly forwardAgent: boolean;
    /** Absent means ssh; "wsl" adds the distro named by `alias`. */
    readonly kind?: "ssh" | "wsl";
  }>;
}

/** What a bucket's tokens not covered by a reported cost would cost at API prices (ENG-207). */
export interface BucketEstimate {
  readonly estimatedUsd: number;
  /** Tokens whose Model no price list has; not in `estimatedUsd`. */
  readonly unpricedTokens: number;
}

/** `usage.query`'s report, with each bucket's estimate (same order) and when prices were fetched. */
export interface UsageQueryView {
  readonly report: Plain<UsageReport>;
  readonly estimates: ReadonlyArray<BucketEstimate>;
  /** Null when no price table could be read. */
  readonly pricesFetchedAt: string | null;
}

/** What `files.read` returns: inline text, or the bytes the Daemon sent as a blob. */
export type FileContentView =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array };

/** A file's version on its Host (`files.readVersioned`): mtime, byte size and SHA-256. */
export interface FileVersionView {
  readonly mtimeMs: number;
  readonly size: number;
  readonly hash: string;
}

/** `files.write`: written, or refused because the disk moved on (null: the file is gone). */
export type FileWriteView =
  | { readonly kind: "written"; readonly version: FileVersionView }
  | { readonly kind: "changed-on-disk"; readonly current: FileVersionView | null };

/** Every Constellation request answers with the RPC's result: summary, next, revision. */
export type ConstellationRequestOutputs = {
  readonly [M in ConstellationMethod]: Plain<ConstellationResult>;
} & {
  readonly [M in ConstellationDefaultsMethod]: { readonly settings: Plain<ConstellationSettings> };
};

/** A stats Usage section with main's API-price estimate per bucket (same order), like `usage.query`. */
export interface PricedStatsUsage extends Plain<Omit<StatsUsage, "buckets">> {
  readonly buckets: ReadonlyArray<Plain<UsageBucket>>;
  readonly estimates: ReadonlyArray<BucketEstimate>;
}

/** `constellation.stats`, its Usage priced by main (C1-M returns reported cost only). */
export interface ConstellationStatsView {
  readonly stats: Plain<ConstellationStats>;
  readonly usage: {
    readonly total: PricedStatsUsage;
    readonly perTask: ReadonlyArray<{ readonly taskId: string; readonly usage: PricedStatsUsage }>;
    readonly perRole: ReadonlyArray<{
      readonly role: "lead" | "worker";
      readonly usage: PricedStatsUsage;
    }>;
    /** Each digest Turn's Usage, in `stats.lead.digests` order. */
    readonly perDigest: ReadonlyArray<PricedStatsUsage>;
  };
  /** Null when no price table could be read. */
  readonly pricesFetchedAt: string | null;
}

/** Every Host resource request answers with the Host's whole resources snapshot. */
export type ResourceRequestOutputs = {
  readonly [M in ResourceMethod]: Plain<HostResourcesSnapshot>;
};

/** Every Remote Access request answers with the Host's Remote Access as Tailscale reports it. */
export type RemoteAccessRequestOutputs = {
  readonly [M in RemoteAccessMethod]: Plain<RemoteAccessStatus>;
};

export interface RequestOutputs
  extends
    PredictionUiOutputs,
    GitHubRequestOutputs,
    GitRequestOutputs,
    BrowserRequestOutputs,
    ConstellationRequestOutputs,
    ResourceRequestOutputs,
    RemoteAccessRequestOutputs,
    LinkedDevicesRequestOutputs,
    VoiceRequestOutputs,
    SecretRequestOutputs,
    PredictionPlacementOutputs,
    PredictionOutcomeOutputs {
  "constellation.stats": ConstellationStatsView;
  "settings.get": SettingsView;
  "updates.get": AppUpdateView;
  "updates.check": AppUpdateView;
  "updates.setAutomatic": AppUpdateView;
  "updates.restart": null;
  "updates.showInFinder": null;
  "cache.get": ReadonlyArray<CachedHost>;
  "cache.put": null;
  "settings.setTheme": null;
  "settings.setDensity": null;
  "settings.setAppearance": null;
  "settings.setSessionDefault": null;
  "settings.setSessions": null;
  "shell.openExternal": null;
  "visualization.serve": { readonly url: string };
  "shell.revealInFinder": null;
  "host.retryNow": null;
  dispatch: { readonly sequence: number | null };
  "files.listDir": ReadonlyArray<FileEntry>;
  "files.stat": FileEntry;
  "files.read": {
    readonly size: number;
    readonly mimeType: string;
    readonly content: FileContentView;
  };
  "files.searchPaths": Rpc.Success<typeof SearchPaths>;
  "files.grep": Rpc.Success<typeof Grep>;
  "files.readVersioned": {
    readonly version: FileVersionView;
    readonly mimeType: string;
    readonly content: FileContentView;
  };
  "files.write": FileWriteView;
  "git.diff": {
    readonly bytes: Uint8Array;
    readonly files: number;
    /** Each file's byte range in `bytes` (empty from Daemons without `git.diff-files`). */
    readonly fileIndex: ReadonlyArray<Plain<DiffFile>>;
  };
  "git.show": {
    readonly size: number;
    readonly mimeType: string;
    readonly content: FileContentView;
  };
  "files.create": FileEntry;
  "files.rename": FileEntry;
  "files.delete": { readonly method: "trash" | "permanent" };
  "harness.models": Plain<HarnessModels>;
  "harness.commands": Plain<HarnessCommands>;
  "harness.spinnerVerbs": Plain<SpinnerVerbs> | null;
  "harness.availability": Plain<HostHarnesses>;
  "session.terminalCommand": TerminalLaunch | null;
  "session.turns": TurnPage;
  "usage.query": UsageQueryView;
  "terminal.open": { readonly terminalId: TerminalId };
  "terminal.input": null;
  "terminal.resize": null;
  "terminal.close": null;
  "attachments.stage": Attachment;
  "attachments.settings": {
    readonly settings: Plain<AttachmentSettings>;
    readonly usage: Plain<AttachmentUsage>;
  };
  "attachments.setSettings": null;
  "attachments.clear": Plain<StagedAmount>;
  "extensions.list": ReadonlyArray<Plain<Pairing>>;
  "extensions.pair": Rpc.Success<typeof PairExtension>;
  "extensions.revoke": Plain<Pairing>;
  "sessions.autoArchive": Plain<AutoArchiveSettings>;
  "sessions.setAutoArchive": null;
  "sessions.idleCompaction": Plain<IdleCompactionSettings>;
  "sessions.setIdleCompaction": null;
  "sessions.visuals": Plain<VisualsSettings>;
  "sessions.setVisuals": null;
  "continuity.markRead": Plain<ReadPosition>;
  "continuity.saveDraft": Plain<ComposerDraft>;
  "review.runRiskSummary": Rpc.Success<typeof RunRiskSummary>;
  "review.runWalkthrough": Rpc.Success<typeof RunWalkthrough>;
  "review.stopWalkthrough": null;
  "review.riskSummary": Rpc.Success<typeof GetRiskSummary>;
  "review.verdicts": Rpc.Success<typeof ListVerdicts>;
  "review.askFinding": Rpc.Success<typeof AskFinding>;
  "review.reviewerSettings": Rpc.Success<typeof GetReviewerSettings>;
  "review.setReviewerSettings": null;
  "session.acceptPlan": Plain<AcceptPlan>;
  "session.draftAccept": Plain<AcceptDraft>;
  "session.commitAccepted": Plain<AcceptCommitted>;
  "session.pushAccepted": Plain<AcceptPushed>;
  "machines.sshAliases": ReadonlyArray<SshAliasView>;
  "machines.wslDistros": WslDistrosView;
  "machines.add": { readonly key: string };
  "machines.update": null;
  "machines.remove": null;
  "machines.check": null;
  "machines.updateDaemon": null;
  "machines.setKeepDaemonsUpToDate": null;
  "machines.setDaemonUpdateOverride": null;
  "machines.approve": null;
  "machines.dismiss": null;
  "machines.takeOverTask": null;
  "machines.startDaemon": null;
  "machines.restartPreview": RestartPreviewView;
  "machines.restartDaemon": RestartDaemonResult;
  "machines.setLocalEnabled": null;
  "machines.openSsh": null;
  "clipboard.write": null;
  "clipboard.writeSecret": null;
  "edit.run": null;
  "app.menu": null;
  "onboarding.found": { readonly sshHosts: ReadonlyArray<string>; readonly version: string };
  "onboarding.welcomeSeen": null;
  "dialog.pickFolder": { readonly path: string | null };
  "needsYou.publish": null;
  "editor.publishDirty": null;
  "editor.savedAll": null;
  "dev.proofWorkspace": { readonly path: string };
}

// Every method has an output type; a missing one fails to compile here.
export type RequestOutput<M extends RequestMethod> = RequestOutputs[M];

// ── Subscriptions ───────────────────────────────────────────────────────────

export type TerminalItem =
  | { readonly _tag: "Output"; readonly data: Uint8Array }
  | { readonly _tag: "Exit"; readonly code: number | null };

export interface SubscriptionItems
  extends GitHubSubscriptionItems, GitSubscriptionItems, BrowserSubscriptionItems {
  "prediction.complete": PredictionFeedItem;
  "prediction.edit": EditPredictionFeedItem;
  "prediction.managed.watch": import("@polaris/protocol").ManagedServerStatus;
  hosts: ReadonlyArray<HostView>;
  machines: ReadonlyArray<MachineView>;
  host: HostStreamItem;
  session: SessionStreamItem;
  terminal: TerminalItem;
  "files.watch": ReadonlyArray<typeof FileChangeEvent.Type>;
  "files.watchFile": { readonly path: string; readonly version: FileVersionView | null };
  usage: UsageStreamItem;
  "harness.availability": Plain<HostHarnesses>;
  continuity: ContinuityItem;
  "plan-limits": Plain<PlanLimit>;
  "host.stats": HostStatsItem;
  "devices.watch": ReadonlyArray<LinkedDeviceView>;
  "review.watchRiskSummary": RiskSummary;
  "inline.propose": InlineStreamItem;
  constellation: ConstellationStreamItem;
}

export type SubscriptionItem<K extends SubscriptionKind> = SubscriptionItems[K];

/** One subscription's share of a batch; `end` is set once, when the feed ends. */
export interface BatchEntry {
  readonly id: number;
  readonly items: ReadonlyArray<unknown>;
  /** Absent while live; null when it ended cleanly; the error when it failed. */
  readonly end?: IpcError | null;
}

export interface SubscriptionListener<A> {
  /** Items in arrival order; called at most once per batch. */
  readonly items: (items: ReadonlyArray<A>) => void;
  readonly end?: (error: IpcError | null) => void;
}

// ── App events ──────────────────────────────────────────────────────────────

export type Route = "orchestrate" | "review" | "edit";

export type AppEvent =
  | {
      readonly kind: "prediction-settings";
      readonly hostKey: string;
      readonly preferences: import("./predictionPlacement.ts").PredictionPreferences;
      readonly restraints: ReturnType<
        typeof import("./predictionPlacement.ts").predictionRestraints
      >;
    }
  /** A command from the native menu (`shared/keymap.ts`); the renderer runs it. */
  | { readonly kind: "command"; readonly id: CommandId }
  | { readonly kind: "appearance"; readonly appearance: Appearance }
  | { readonly kind: "updates"; readonly updates: AppUpdateView }
  | { readonly kind: "session-defaults"; readonly sessionDefaults: SessionDefaults }
  | { readonly kind: "sessions"; readonly sessions: SessionPrefs }
  /** Dev only (Develop menu): start the bench-Harness proof session on this Host. */
  | { readonly kind: "proof"; readonly hostKey: string }
  /** The menu bar star or a notification: open a waiting session, or answer it. */
  | ({ readonly kind: "needs-you" } & NeedsYouAction)
  /** Main decided an agent's `notify` banner: shown, held while you were in that session, or off. */
  | {
      readonly kind: "agent-banner";
      readonly hostKey: string;
      readonly sessionId: string;
      readonly id: string;
      readonly title: string;
      readonly body: string;
      readonly banner: "shown" | "here" | "off";
    }
  /** A review-request notification: open its pull request in Review, or the list (null). */
  | { readonly kind: "open-pull"; readonly pull: OpenPull | null }
  /** A Review or Walkthrough notification: open the Review it ran for. */
  | { readonly kind: "open-review"; readonly target: ReviewTarget }
  /** The quit prompt's "Save and quit": the Editor saves every file, then answers `editor.savedAll`. */
  | { readonly kind: "editor-save-all" }
  /** A `polaris://` link (Raycast and the like): open a session or a Workspace, nothing more. */
  | { readonly kind: "deep-link"; readonly link: import("./deepLink.ts").DeepLink };

/** A pull request to open in Review, with its node id when known. */
export interface OpenPull extends PullRef {
  readonly pullId: string | null;
}

// ── The API on `window.polaris` ─────────────────────────────────────────────

/** Optional language IPC extension; absent until C1 installs an implementation. */
export interface LanguageApi {
  readonly request: <M extends import("./languages.ts").LanguageRequestMethod>(
    method: M,
    input: import("./languages.ts").LanguageRequestInput<M>
  ) => Promise<Result<import("./languages.ts").LanguageRequestOutput<M>>>;
  readonly subscribe: <K extends import("./languages.ts").LanguageSubscriptionKind>(
    kind: K,
    input: import("./languages.ts").LanguageSubscriptionInput<K>,
    listener: SubscriptionListener<import("./languages.ts").LanguageSubscriptionItem<K>>
  ) => () => void;
}

export interface PolarisApi {
  /** The Client's OS from `process.platform`; read it through `clientPlatform()` (shared/platform.ts). */
  readonly platform?: string;
  readonly languages?: LanguageApi;
  readonly notify?: <M extends PredictionNotification>(
    method: M,
    input: PredictionNotificationInput<M>
  ) => void;
  readonly request: <M extends RequestMethod>(
    method: M,
    input: RequestInput<M>
  ) => Promise<Result<RequestOutput<M>>>;
  /** Opens a live feed; call the returned function to close it. */
  readonly subscribe: <K extends SubscriptionKind>(
    kind: K,
    input: SubscriptionInput<K>,
    listener: SubscriptionListener<SubscriptionItem<K>>
  ) => () => void;
  readonly onAppEvent: (listener: (event: AppEvent) => void) => () => void;
}
