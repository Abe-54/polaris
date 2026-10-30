import { modelServerResources } from "@polaris/client/prediction/probe";
import type { MainPredictionPlacement } from "../prediction/placement.ts";
import type { PredictionSettings } from "../prediction/preferences.ts";
import type { PredictionOutcomes } from "../prediction/outcomes.ts";
import { predictionPreferenceView } from "../../shared/predictionPlacement.ts";
/**
 * The handlers behind `window.polaris.request`: one per method, each taking the
 * decoded input and returning a structured-clone-friendly output. Blobs the
 * Daemon sends (file contents, diffs) are taken here and cross IPC as bytes.
 */
import { clientCopy } from "../../shared/clientCopy.ts";
import type { HostConnection, LiveSession } from "@polaris/client";
import { FileContent, FileVersion } from "@polaris/protocol";
import { Effect, flow, Match, Schema } from "effect";
import type {
  FileVersionView,
  FileWriteView,
  Appearance,
  FileContentView,
  SessionDefault,
  IpcError,
  RequestOutput,
} from "../../shared/api.ts";
import {
  RequestInputs,
  type RequestInput,
  type RequestMethod,
  type SessionPrefsPatch,
} from "../../shared/contract.ts";
import { type ClientServices, HostDirectory, toIpcError } from "../hosts.ts";
import { revealPath } from "../reveal.ts";
import { githubHandlers } from "../github/ipc.ts";
import { gitHandlers } from "./git.ts";
import { constellationHandlers, resourceHandlers } from "./constellation.ts";
import { remoteAccessHandlers } from "./remoteAccess.ts";
import { linkedDevicesHandlers } from "./linkedDevices.ts";
import { voiceHandlers } from "./voice.ts";
import { browserHandlers } from "../browser/ipc.ts";
import type { Registry as Browsers } from "../browser/registry.ts";
import { secretHandlers } from "./secrets.ts";
import { Machines } from "../machines/service.ts";
import type { NeedsYouSummary } from "../../shared/needsYou.ts";
import { appearanceOf, sessionPrefsOf, type Settings } from "../settings.ts";
import { estimate } from "../estimate.ts";
import type { Prices } from "../prices.ts";
import { pricedStats } from "./constellationStats.ts";
import type { SnapshotCache } from "../snapshotCache.ts";
import { publishDirty, savedAll } from "../editorDirty.ts";
import type { AppUpdates } from "../updates/index.ts";
import type { PredictionBridge } from "../prediction/bridge.ts";

/** What the handlers need from the app outside the Client runtime. */
export interface RequestContext {
  readonly predictionBridge?: PredictionBridge;
  readonly predictionSettings?: PredictionSettings;
  readonly predictionOutcomes?: PredictionOutcomes;
  readonly predictionPlacement?: MainPredictionPlacement;
  /** A native folder picker; null when the user cancels. */
  readonly chooseFolder?: (title: string, buttonLabel: string) => Promise<string | null>;
  readonly updates: Pick<AppUpdates, "get" | "check" | "setAutomatic">;
  readonly restartToUpdate: () => void;
  readonly showAppInFinder: () => void;
  readonly settings: () => Settings;
  readonly cache: SnapshotCache;
  /** The price table for Usage estimates. */
  readonly prices: Prices;
  readonly setAppearance: (patch: Partial<Appearance>) => void;
  readonly setSessionDefault: (harness: string, value: SessionDefault | null) => void;
  readonly setSessions: (patch: SessionPrefsPatch) => void;
  readonly openExternal: (url: string) => Promise<void>;
  /** Holds a Visualization's frame document; the URL serves it once (`frames.ts`). */
  readonly serveFrame: (document: string) => string;
  /** Finder or Explorer, selecting the item at a path on this Client (a `\\wsl.localhost` one included). */
  readonly revealInFinder: (path: string) => void;
  /** A fresh temp directory, or null when the local Daemon doesn't run the bench Harness. */
  readonly proofWorkspace: () => string | null;
  /** The literal Host aliases in `~/.ssh/config`. */
  readonly sshHosts: () => ReadonlyArray<string>;
  readonly setWelcomeSeen: () => void;
  readonly appVersion: string;
  /** The native folder picker on the focused window; null when cancelled. */
  readonly pickFolder: () => Promise<string | null>;
  readonly writeClipboard: (text: string) => Promise<void>;
  /** Writes a secret that clears itself after a minute (`secretClipboard.ts`). */
  readonly writeSecretClipboard: (text: string) => Promise<void>;
  /** Cut, Copy, Paste or Select All in the focused window, as its Edit menu would. */
  readonly editAction: (action: "cut" | "copy" | "paste" | "selectAll") => void;
  /** Windows: the app menu under the title bar's lockup. */
  readonly showAppMenu: () => void;
  /** The renderer's Needs You summary, for the menu bar star, Dock badge and notifications. */
  readonly needsYou: (summary: NeedsYouSummary) => void;
  /** Agent Sessions' Browsers; absent where there are no windows (tests). */
  readonly browser?: Browsers;
}

export type Handler<M extends RequestMethod> = (
  input: RequestInput<M>
) => Effect.Effect<RequestOutput<M>, IpcError, ClientServices>;

export type Handlers = { readonly [M in RequestMethod]: Handler<M> };

type Failure = { readonly _tag: string; readonly message: string };

const connection = (hostKey: string) => HostDirectory.use((dir) => dir.connection(hostKey));

const onHost = <A, E extends Failure>(
  hostKey: string,
  use: (connection: HostConnection) => Effect.Effect<A, E>
) => Effect.flatMap(connection(hostKey), use).pipe(Effect.mapError(toIpcError));

const onLive = <A, E extends Failure>(
  hostKey: string,
  use: (session: LiveSession) => Effect.Effect<A, E>
) => onHost(hostKey, (c) => Effect.flatMap(c.session, use));

const machines = <A, E extends Failure>(use: (m: Machines["Service"]) => Effect.Effect<A, E>) =>
  Machines.use(use).pipe(Effect.mapError(toIpcError));

const done = <E, R>(effect: Effect.Effect<unknown, E, R>) => Effect.as(effect, null);

const fileContent = (session: LiveSession, content: FileContent) =>
  Match.value(content).pipe(
    Match.tagsExhaustive({
      Inline: ({ text }) => Effect.succeed<FileContentView>({ kind: "text", text }),
      Blob: ({ blobId }) =>
        Effect.map(session.blobs.take(blobId), (bytes): FileContentView => ({
          kind: "bytes",
          bytes,
        })),
    })
  );

const plainVersion = (v: FileVersion): FileVersionView => ({
  mtimeMs: v.mtimeMs,
  size: v.size,
  hash: v.hash,
});

export const requestHandlers = (ctx: RequestContext): Handlers => ({
  "prediction.metrics": () =>
    Effect.tryPromise({
      try: () => {
        if (!ctx.predictionOutcomes) throw new Error("Prediction history unavailable");

        return ctx.predictionOutcomes.metrics();
      },
      catch: (): IpcError => ({ code: "Unavailable", message: "Prediction history unavailable" }),
    }),
  "prediction.outcomes.clear": () =>
    Effect.tryPromise({
      try: async () => {
        if (!ctx.predictionOutcomes) throw new Error("Prediction history unavailable");
        await ctx.predictionOutcomes.clear();

        return null;
      },
      catch: (): IpcError => ({ code: "Unavailable", message: "Prediction history unavailable" }),
    }),
  "prediction.discoveryShown": () =>
    Effect.sync(() => {
      ctx.predictionBridge?.discoveryShown();

      return null;
    }),
  "prediction.enabled.get": () =>
    Effect.sync(() => ctx.predictionBridge?.enabled() ?? { enabled: false, configured: false }),
  "prediction.enabled.set": ({ enabled }) =>
    ctx.predictionBridge
      ? Effect.sync(() => ctx.predictionBridge!.setEnabled(enabled))
      : Effect.fail({ code: "Unavailable", message: "Tab completion unavailable" }),
  "prediction.target": ({ hostKey, workspaceId }) =>
    Effect.tryPromise({
      try: async () => {
        if (!ctx.predictionBridge) throw new Error("Tab completion unavailable");

        return ctx.predictionBridge.target(hostKey, workspaceId);
      },
      catch: (error): IpcError => ({ code: "PredictionUnavailable", message: String(error) }),
    }),
  "prediction.inspect": ({ hostKey }) =>
    Effect.tryPromise({
      try: async () => {
        if (!ctx.predictionBridge) throw new Error("Tab completion unavailable");

        return ctx.predictionBridge.inspect(hostKey);
      },
      catch: (error): IpcError => ({ code: "PredictionUnavailable", message: String(error) }),
    }),
  "prediction.server": (input) =>
    Effect.tryPromise({
      try: async () => {
        if (!ctx.predictionBridge) throw new Error("Tab completion unavailable");

        return ctx.predictionBridge.server(input);
      },
      catch: (error): IpcError => ({
        code: "PredictionUnavailable",
        message: error instanceof Error ? error.message : String(error),
      }),
    }),
  "prediction.managed": (input) =>
    Effect.tryPromise({
      try: async () => {
        if (!ctx.predictionBridge) throw new Error("Tab completion unavailable");

        return ctx.predictionBridge.managed(input);
      },
      catch: (error): IpcError => ({
        code: "PredictionUnavailable",
        message: error instanceof Error ? error.message : String(error),
      }),
    }),
  "prediction.modelsDir.choose": () =>
    Effect.tryPromise({
      try: () => ctx.chooseFolder?.("Model folder", "Use this folder") ?? Promise.resolve(null),
      catch: (): IpcError => ({ code: "Unavailable", message: "Folder picker unavailable" }),
    }),
  "prediction.release": ({ hostKey, workspaceId }) =>
    Effect.sync(() => {
      ctx.predictionBridge?.release(hostKey, workspaceId);

      return null;
    }),
  "prediction.clientEndpoints.get": () =>
    ctx.predictionSettings
      ? Effect.sync(() => ctx.predictionSettings!.getClientEndpoints())
      : Effect.fail({ code: "Unavailable", message: "Prediction settings unavailable" }),
  "prediction.clientEndpoints.set": ({ endpoints }) =>
    ctx.predictionSettings
      ? Effect.sync(() => {
          const saved = ctx.predictionSettings!.setClientEndpoints(endpoints);
          ctx.predictionPlacement?.invalidateAll();

          return saved;
        })
      : Effect.fail({ code: "Unavailable", message: "Prediction settings unavailable" }),
  "prediction.resources.get": () =>
    Effect.tryPromise({
      try: modelServerResources,
      catch: () => ({ code: "Unavailable", message: "Model server memory unavailable" }),
    }),
  "prediction.settings.get": ({ hostKey }) =>
    ctx.predictionSettings
      ? Effect.sync(() => predictionPreferenceView(ctx.predictionSettings!.get(hostKey)))
      : Effect.fail({ code: "Unavailable", message: "Prediction settings unavailable" }),
  "prediction.settings.set": ({ hostKey, preferences }) =>
    ctx.predictionSettings
      ? Effect.sync(() => {
          const saved = ctx.predictionSettings!.set(hostKey, preferences);
          ctx.predictionPlacement?.invalidateHost(hostKey);

          return predictionPreferenceView(saved);
        })
      : Effect.fail({ code: "Unavailable", message: "Prediction settings unavailable" }),
  ...githubHandlers,
  ...gitHandlers,
  ...constellationHandlers,
  ...resourceHandlers,
  ...remoteAccessHandlers,
  ...linkedDevicesHandlers,
  ...voiceHandlers,
  ...browserHandlers(ctx.browser),
  ...secretHandlers,
  "updates.get": () => Effect.sync(ctx.updates.get),
  "updates.check": () => Effect.sync(ctx.updates.check),
  "updates.setAutomatic": ({ enabled }) => Effect.sync(() => ctx.updates.setAutomatic(enabled)),
  "updates.restart": () => Effect.sync(ctx.restartToUpdate).pipe(done),
  "updates.showInFinder": () => Effect.sync(ctx.showAppInFinder).pipe(done),
  "settings.get": () =>
    Effect.sync(() => {
      const settings = ctx.settings();

      return {
        ...appearanceOf(settings),
        sessionDefaults: settings.sessionDefaults ?? {},
        sessions: sessionPrefsOf(settings),
        version: ctx.appVersion,
        welcomeSeen: settings.welcomeSeen ?? false,
        hosts: (settings.hosts ?? []).map((h) => ({
          alias: h.alias,
          label: h.label ?? h.alias,
          colour: h.colour ?? null,
          forwardAgent: h.forwardAgent ?? false,
        })),
      };
    }),
  "cache.get": () => Effect.sync(() => ctx.cache.get()),
  "cache.put": ({ host }) => Effect.sync(() => ctx.cache.put(host)).pipe(done),
  "settings.setTheme": ({ theme }) => Effect.sync(() => ctx.setAppearance({ theme })).pipe(done),
  "settings.setDensity": ({ density }) =>
    Effect.sync(() => ctx.setAppearance({ density })).pipe(done),
  "settings.setAppearance": ({ patch }) => Effect.sync(() => ctx.setAppearance(patch)).pipe(done),
  "settings.setSessionDefault": ({ harness, value }) =>
    Effect.sync(() => ctx.setSessionDefault(harness, value)).pipe(done),
  "settings.setSessions": ({ patch }) => Effect.sync(() => ctx.setSessions(patch)).pipe(done),
  "shell.openExternal": ({ url }) =>
    Effect.tryPromise({
      try: () => ctx.openExternal(url),
      catch: (cause): IpcError => ({ code: "OpenFailed", message: String(cause) }),
    }).pipe(done),
  "visualization.serve": ({ document }) => Effect.sync(() => ({ url: ctx.serveFrame(document) })),
  "shell.revealInFinder": ({ hostKey, path }) =>
    HostDirectory.use((dir) => {
      const shown = revealPath(dir.entry(hostKey), path);

      return shown === null
        ? Effect.fail<IpcError>({
            code: "NotLocal",
            message: `${clientCopy().reveal} is for ${clientCopy().machine}`,
          })
        : Effect.sync(() => ctx.revealInFinder(shown)).pipe(done);
    }),
  "host.retryNow": ({ hostKey }) => onHost(hostKey, (c) => c.retryNow).pipe(done),
  dispatch: ({ hostKey, commandId, command }) =>
    onLive(hostKey, (s) => s.client.dispatch({ commandId, command })),
  "files.listDir": ({ hostKey, path }) =>
    onLive(hostKey, (s) => s.client["files.listDir"]({ path })),
  "files.stat": ({ hostKey, path }) => onLive(hostKey, (s) => s.client["files.stat"]({ path })),
  "files.read": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) =>
      Effect.flatMap(s.client["files.read"](payload), (read) =>
        Effect.map(fileContent(s, read.content), (content) => ({
          size: read.size,
          mimeType: read.mimeType,
          content,
        }))
      )
    ),
  "files.searchPaths": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["files.searchPaths"](payload)),
  "files.grep": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["files.grep"](payload)),
  "files.readVersioned": ({ hostKey, path }) =>
    onLive(hostKey, (s) =>
      Effect.flatMap(s.client["files.readVersioned"]({ path }), (read) =>
        Effect.map(fileContent(s, read.content), (content) => ({
          version: plainVersion(read.version),
          mimeType: read.mimeType,
          content,
        }))
      )
    ),
  "files.write": ({ hostKey, path, text, expected }) =>
    onLive(hostKey, (s) =>
      s.client["files.write"]({
        path,
        expected: new FileVersion(expected),
        content: FileContent.cases.Inline.make({ text }),
      }).pipe(
        Effect.map((version): FileWriteView => ({
          kind: "written",
          version: plainVersion(version),
        })),
        Effect.catchTag("ChangedOnDisk", (error) =>
          Effect.succeed<FileWriteView>({
            kind: "changed-on-disk",
            current: error.current === null ? null : plainVersion(error.current),
          })
        )
      )
    ),
  "git.diff": ({ hostKey, cwd, spec }) =>
    onLive(hostKey, (s) =>
      Effect.flatMap(s.client["git.diff"]({ cwd, spec }), (diff) =>
        Effect.map(s.blobs.take(diff.blobId), (bytes) => ({
          bytes,
          files: diff.files,
          fileIndex: diff.fileIndex,
        }))
      )
    ),
  "git.show": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) =>
      Effect.flatMap(s.client["git.show"](payload), (shown) =>
        Effect.map(fileContent(s, shown.content), (content) => ({
          size: shown.size,
          mimeType: shown.mimeType,
          content,
        }))
      )
    ),
  "files.create": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["files.create"](payload)),
  "files.rename": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["files.rename"](payload)),
  // A Host without a trash refuses with ENOTSUP; the explorer then asks before deleting for good.
  "files.delete": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) =>
      s.client["files.delete"](payload).pipe(
        Effect.catchTag("FileError", (error) =>
          Effect.fail<Failure>({
            _tag: error.code === "ENOTSUP" ? "TrashUnavailable" : "FileError",
            message: error.message,
          })
        )
      )
    ),
  "harness.models": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["harness.models"](payload)),
  "harness.commands": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["harness.commands"](payload)),
  "harness.spinnerVerbs": ({ hostKey, cwd }) =>
    onLive(hostKey, (s) => s.client["harness.spinnerVerbs"]({ cwd })),
  "harness.availability": ({ hostKey, refresh }) =>
    onLive(hostKey, (s) => s.client["harness.availability"]({ refresh })),
  "session.terminalCommand": ({ hostKey, sessionId }) =>
    onLive(hostKey, (s) => s.client["session.terminalCommand"]({ sessionId })),
  "session.turns": ({ hostKey, sessionId, beforeIndex, limit }) =>
    onLive(hostKey, (s) => s.client["session.turns"]({ sessionId, beforeIndex, limit })),
  "constellation.stats": ({ hostKey, constellationId }) =>
    onHost(hostKey, (c) =>
      Effect.flatMap(c.session, (s) => s.client["constellation.stats"]({ constellationId }))
    ).pipe(
      Effect.flatMap((stats) =>
        Effect.promise(() => ctx.prices.table().catch(() => null)).pipe(
          Effect.map((table) => pricedStats(stats, table))
        )
      )
    ),
  "usage.query": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["usage.query"](payload)).pipe(
      Effect.flatMap((report) =>
        Effect.promise(() => ctx.prices.table().catch(() => null)).pipe(
          Effect.map((table) => ({
            report,
            estimates: table === null ? [] : estimate(report.buckets, table),
            pricesFetchedAt: table?.fetchedAt ?? null,
          }))
        )
      )
    ),
  "terminal.open": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["terminal.open"](payload)),
  "terminal.input": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["terminal.input"](payload)).pipe(done),
  "terminal.resize": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["terminal.resize"](payload)).pipe(done),
  "terminal.close": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["terminal.close"](payload)).pipe(done),
  "attachments.stage": ({ hostKey, bytes, ...payload }) =>
    onHost(hostKey, (c) =>
      c.withBlob(bytes, (blobId, s) => s.client["attachments.stage"]({ ...payload, blobId }))
    ),
  "attachments.settings": ({ hostKey }) =>
    onLive(hostKey, (s) => s.client["attachments.settings"]({})),
  "attachments.setSettings": ({ hostKey, settings }) =>
    onLive(hostKey, (s) => s.client["attachments.setSettings"]({ settings })).pipe(done),
  "attachments.clear": ({ hostKey, workspaceId }) =>
    onLive(hostKey, (s) => s.client["attachments.clear"]({ workspaceId })),
  "extensions.list": ({ hostKey }) => onLive(hostKey, (s) => s.client["extensions.list"]()),
  "extensions.pair": ({ hostKey, name, grant }) =>
    onLive(hostKey, (s) => s.client["extensions.pair"]({ name, grant })),
  "extensions.revoke": ({ hostKey, id }) =>
    onLive(hostKey, (s) => s.client["extensions.revoke"]({ id })),
  "sessions.autoArchive": ({ hostKey }) =>
    onLive(hostKey, (s) => s.client["sessions.autoArchive"]({})),
  "sessions.setAutoArchive": ({ hostKey, settings }) =>
    onLive(hostKey, (s) => s.client["sessions.setAutoArchive"]({ settings })).pipe(done),
  "sessions.idleCompaction": ({ hostKey }) =>
    onLive(hostKey, (s) => s.client["sessions.idleCompaction"]({})),
  "sessions.setIdleCompaction": ({ hostKey, settings }) =>
    onLive(hostKey, (s) => s.client["sessions.setIdleCompaction"]({ settings })).pipe(done),
  "sessions.visuals": ({ hostKey }) => onLive(hostKey, (s) => s.client["sessions.visuals"]({})),
  "sessions.setVisuals": ({ hostKey, settings }) =>
    onLive(hostKey, (s) => s.client["sessions.setVisuals"]({ settings })).pipe(done),
  "continuity.markRead": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["continuity.markRead"](payload)),
  "continuity.saveDraft": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["continuity.saveDraft"](payload)),
  "review.runRiskSummary": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["review.runRiskSummary"](payload)),
  "review.runWalkthrough": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["review.runWalkthrough"](payload)),
  "review.stopWalkthrough": ({ hostKey, summaryId }) =>
    onLive(hostKey, (s) => s.client["review.stopWalkthrough"]({ summaryId })).pipe(done),
  "review.riskSummary": ({ hostKey, ref }) =>
    onLive(hostKey, (s) => s.client["review.riskSummary"]({ ref })),
  "review.verdicts": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["review.verdicts"](payload)),
  "review.askFinding": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["review.askFinding"](payload)),
  "review.reviewerSettings": ({ hostKey, workspaceId }) =>
    onLive(hostKey, (s) => s.client["review.reviewerSettings"]({ workspaceId })),
  "review.setReviewerSettings": ({ hostKey, settings }) =>
    onLive(hostKey, (s) => s.client["review.setReviewerSettings"]({ settings })).pipe(done),
  "session.acceptPlan": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["session.acceptPlan"](payload)),
  "session.draftAccept": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["session.draftAccept"](payload)),
  "session.commitAccepted": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["session.commitAccepted"](payload)),
  "session.pushAccepted": ({ hostKey, ...payload }) =>
    onLive(hostKey, (s) => s.client["session.pushAccepted"](payload)),
  "machines.sshAliases": () => machines((m) => m.sshAliases),
  "machines.wslDistros": () => machines((m) => m.wslDistros),
  "machines.add": (input) => machines((m) => Effect.map(m.add(input), (key) => ({ key }))),
  "machines.update": ({ hostKey, ...patch }) =>
    machines((m) => m.update(hostKey, patch)).pipe(done),
  "machines.remove": ({ hostKey }) => machines((m) => m.remove(hostKey)).pipe(done),
  "machines.check": ({ hostKey }) => machines((m) => m.check(hostKey)).pipe(done),
  "machines.updateDaemon": ({ hostKey }) => machines((m) => m.updateDaemon(hostKey)).pipe(done),
  "machines.setKeepDaemonsUpToDate": ({ enabled }) =>
    machines((m) => m.setKeepDaemonsUpToDate(enabled)).pipe(done),
  "machines.setDaemonUpdateOverride": ({ hostKey, enabled }) =>
    machines((m) => m.setDaemonUpdateOverride(hostKey, enabled)).pipe(done),
  "machines.approve": ({ hostKey, sha256 }) =>
    machines((m) => m.approve(hostKey, sha256)).pipe(done),
  "machines.dismiss": ({ hostKey }) => machines((m) => m.dismiss(hostKey)).pipe(done),
  "machines.takeOverTask": ({ hostKey }) => machines((m) => m.takeOverTask(hostKey)).pipe(done),
  "machines.startDaemon": ({ hostKey }) => machines((m) => m.startDaemon(hostKey)).pipe(done),
  "machines.restartPreview": ({ hostKey }) => machines((m) => m.restartPreview(hostKey)),
  "machines.restartDaemon": ({ hostKey }) => machines((m) => m.restartDaemon(hostKey)),
  "machines.setLocalEnabled": ({ enabled }) =>
    machines((m) => m.setLocalEnabled(enabled)).pipe(done),
  "machines.openSsh": ({ hostKey }) => machines((m) => m.openSsh(hostKey)).pipe(done),
  "clipboard.write": ({ text }) => Effect.promise(() => ctx.writeClipboard(text)).pipe(done),
  "clipboard.writeSecret": ({ text }) =>
    Effect.promise(() => ctx.writeSecretClipboard(text)).pipe(done),
  "edit.run": ({ action }) => Effect.sync(() => ctx.editAction(action)).pipe(done),
  "app.menu": () => Effect.sync(ctx.showAppMenu).pipe(done),
  "onboarding.found": () =>
    Effect.sync(() => ({ sshHosts: ctx.sshHosts(), version: ctx.appVersion })),
  "onboarding.welcomeSeen": () => Effect.sync(ctx.setWelcomeSeen).pipe(done),
  "dialog.pickFolder": () => Effect.promise(ctx.pickFolder).pipe(Effect.map((path) => ({ path }))),
  "editor.publishDirty": ({ files }) =>
    Effect.sync(() => publishDirty(0, files)).pipe(Effect.as(null)),
  "editor.savedAll": ({ ok }) => Effect.sync(() => savedAll(ok)).pipe(Effect.as(null)),
  "needsYou.publish": (summary) => Effect.sync(() => ctx.needsYou(summary)).pipe(Effect.as(null)),
  "dev.proofWorkspace": () =>
    Effect.suspend(() => {
      const path = ctx.proofWorkspace();

      return path === null
        ? Effect.fail<IpcError>({
            code: "Unsupported",
            message: "the local Daemon does not run the bench Harness",
          })
        : Effect.succeed({ path });
    }),
});

/** Decodes an untrusted request's input from a renderer, then runs its handler. */
export const requestRunner = <M extends RequestMethod>(handlers: Handlers, method: M) =>
  flow(
    Schema.decodeUnknownEffect(RequestInputs[method]),
    Effect.mapError((error): IpcError => ({ code: "InvalidInput", message: error.message })),
    Effect.flatMap((input) => handlers[method](input))
  );

export const isRequestMethod = (method: string): method is RequestMethod =>
  Object.hasOwn(RequestInputs, method);
