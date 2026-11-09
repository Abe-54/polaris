import { respondResourceReceiptRequest } from "./resourceReceipts.ts";
import { languageErrorOf } from "../../../../shared/languageError.ts";
import { autocompletion } from "@codemirror/autocomplete";
import { setDiagnostics } from "@codemirror/lint";
import { Compartment, StateEffect } from "@codemirror/state";
import * as P from "@polaris/protocol";
import { Match, Predicate } from "effect";
import type { LanguageApi } from "../../../../shared/api.ts";
import type { AppState } from "../../../store/store.ts";
import { polaris } from "../../bridge.ts";
import { previewDocument } from "../runtime/markdown.ts";
import { applyBufferLanguage } from "../runtime/buffers.ts";
import { fileKey } from "../model/drafts.ts";
import { languageFor, type LanguageId } from "../model/language.ts";
import { bindEntryFormatter } from "./formatting.ts";
import { LanguageFeatures } from "./features.ts";
import { LanguageDiagnosticFeed, cmDiagnostics } from "./diagnostics.ts";
import { completionSource, hoverExtension, withWordFallback } from "./codemirror.ts";
import { completionFootnote } from "./completionMenu.ts";
import { documentLanguageId, type LanguageBuffer } from "./types.ts";
import { readLanguageConfiguration } from "./configuration.ts";
import { pruneLanguageGroups, admitLanguageGroup, contextIdOf } from "./groups.ts";
import { EditorLanguageObservations } from "./observations.ts";
import { EditorLanguageSession } from "./sessions.ts";
import { languagePatch, languageStore } from "./state.ts";
import type { CodeActions } from "./payloads.ts";
import type { LanguageProvider } from "./types.ts";
import type {
  AuthenticatedLanguageIdentity,
  EditorLanguageMount,
  EditorLanguagePort,
  LanguageIdentityLookup,
} from "./lifecycle.ts";
import { noToolingFact } from "../../../shell/hostPlatform.ts";
import { signatureExtension } from "./signatures.ts";
import { predictionSources } from "./predictionSources.ts";
import { languageKeys } from "./keys.ts";
import { refactorUndoKeys } from "../refactors/undo.ts";
import type { NavigationAction } from "../navigation/commands.ts";
import {
  featureIntentCurrent,
  prepareLanguageEdit,
  type PreparedLanguageEdit,
} from "./preparation.ts";
import { offerServerEdit } from "./serverEdits.ts";
import { configurationItems } from "./serverConfiguration.ts";
import { ownedProvider } from "./ownership.ts";
import { providerLabel, trustChangedFiles, trustDiscovered, trustStore } from "../trust/store.ts";
import { refreshTrust } from "../trust/decide.ts";
import { DiagnosticPull } from "./pull.ts";
import * as Status from "../status/store.ts";
import { contextObserved, refreshHostTools } from "../status/feed.ts";

interface Entry {
  readonly input: EditorLanguageMount;
  readonly features: LanguageFeatures;
  readonly diagnostics: LanguageDiagnosticFeed;
  readonly pull: DiagnosticPull;
  readonly compartment: Compartment;
  readonly read: () => LanguageBuffer;
  groups: EditorLanguageSession[];
  disabled: ReadonlyMap<string, readonly string[]>;
  detach: (() => void)[];
  unformat: (() => void) | null;
  controller: AbortController;
  language: LanguageId;
  manual: LanguageId | null;
  stamp: string;
  providerSignature: string;
  paintScheduled: boolean;
  disposed: boolean;
}

import {
  identityLookup,
  refreshers,
  completionProposal,
  editProposal,
  actionProposal,
} from "./bindings.ts";

export { bindLanguageIdentity, bindLanguageProposals } from "./bindings.ts";

export type { LanguageActionProposal } from "./bindings.ts";

export class EditorLanguageCoordinator implements EditorLanguagePort {
  private command: ((key: string, command: NavigationAction) => void) | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly groups = new Map<string, EditorLanguageSession>();
  private readonly observations = new EditorLanguageObservations();
  private readonly instance = crypto.randomUUID();
  private readonly untrust = trustStore.subscribe((state, previous) => {
    const changed = trustChangedFiles(state, previous);

    if (changed.size === 0) return;
    this.observations.invalidate();

    for (const entry of this.entries.values())
      if (changed.has(fileKey(entry.input.file.hostKey, entry.input.file.path)))
        void this.refreshEntry(entry, true);
  });
  private readonly refresh = () => {
    pruneLanguageGroups(this.groups, this.identity);

    for (const entry of this.entries.values()) void this.refreshEntry(entry);
  };

  constructor(
    readonly app: () => AppState,
    readonly api: () => LanguageApi | undefined = () => polaris().languages,
    readonly identity: LanguageIdentityLookup = (hostKey) => identityLookup(hostKey)
  ) {
    refreshers.add(this.refresh);
  }

  get(key: string) {
    return this.entries.get(key);
  }
  setCommands(run: (key: string, command: NavigationAction) => void) {
    this.command = run;
  }

  mount(input: EditorLanguageMount) {
    const key = fileKey(input.file.hostKey, input.file.path);
    const previous = this.entries.get(key);

    if (previous !== undefined) this.release(previous);
    const uri = `file://${encodeURI(input.file.path).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;

    const read = (): LanguageBuffer => ({
      uri,
      doc: input.view.state.doc,
      version: input.revision(),
      lineSeparator: input.view.state.lineBreak === "\r\n" ? "\r\n" : "\n",
    });

    const unavailable: LanguageApi = {
      request: async () => ({
        ok: false,
        error: { code: "unavailable", message: "Language tooling is unavailable." },
      }),
      subscribe: () => () => undefined,
    };

    const routed: LanguageApi = {
      request: (method, input) => (this.api() ?? unavailable).request(method, input),
      subscribe: (kind, input, listener) =>
        (this.api() ?? unavailable).subscribe(kind, input, listener),
    };

    const features = new LanguageFeatures({
      api: routed,
      buffer: read,
      providers: () =>
        entry.groups.flatMap((group) => {
          const provider = group.provider(uri);

          return provider === null
            ? []
            : [ownedProvider(provider, entry.disabled.get(provider.context.providerId) ?? [])];
        }),
    });

    const diagnostics = new LanguageDiagnosticFeed(features.requests, () => this.paint(entry));

    const entry: Entry = {
      input,
      features,
      read,
      compartment: new Compartment(),
      groups: [],
      disabled: new Map(),
      detach: [],
      unformat: null,
      controller: new AbortController(),
      language: input.manual ?? languageFor(input.file.path, input.view.state.doc.line(1).text),
      manual: input.manual ?? null,
      stamp: "",
      providerSignature: "",
      paintScheduled: false,
      disposed: false,
      diagnostics,
      pull: new DiagnosticPull(features, diagnostics),
    };

    this.entries.set(key, entry);
    Status.statusOpened(key, input.file.hostKey, input.file.path);
    languageStore.setState((state) => ({
      files: {
        ...state.files,
        [key]: {
          language: entry.language,
          manual: entry.manual,
          status: "unavailable",
          fact: "Language tooling is unavailable on this Host.",
          providers: [],
          panel: null,
          rows: [],
          busy: false,
        },
      },
    }));
    const label = (provider: LanguageProvider) => providerLabel(key, provider.context.providerId);

    input.view.dispatch({
      effects: StateEffect.appendConfig.of(
        entry.compartment.of([
          autocompletion({
            override: [
              withWordFallback(
                completionSource(
                  features,
                  {
                    propose: (proposal) => {
                      if (completionProposal === null)
                        languagePatch(key, {
                          panel: "Completion",
                          rows: [
                            {
                              label: "This completion requires an edit proposal.",
                              detail: "The edit coordinator is unavailable.",
                            },
                          ],
                        });
                      else completionProposal(proposal);
                    },
                  },
                  label
                )
              ),
            ],
          }),
          completionFootnote,
          hoverExtension(features, label),
          signatureExtension(features, label),
          languageKeys((command) => this.command?.(key, command)),
          refactorUndoKeys(input.file),
          predictionSources(entry, routed),
        ])
      ),
    });
    void this.refreshEntry(entry);

    return {
      selectedLanguage: () => entry.manual,
      edited: () => {
        features.invalidate();
        entry.diagnostics.clear();
        languagePatch(key, { rows: [], busy: false });

        for (const group of entry.groups) group.edited(uri);
      },
      saved: (version: number, diskVersion: P.FileVersion) => {
        for (const group of entry.groups) group.saved(uri, version, diskVersion);
      },
      dispose: () => this.release(entry),
    };
  }

  private paint(entry: Entry) {
    if (entry.paintScheduled || entry.disposed) return;
    entry.paintScheduled = true;
    queueMicrotask(() => {
      entry.paintScheduled = false;

      if (!entry.disposed)
        entry.input.view.dispatch(
          setDiagnostics(
            entry.input.view.state,
            cmDiagnostics(entry.features.requests, entry.diagnostics.values(), (provider) =>
              providerLabel(
                fileKey(entry.input.file.hostKey, entry.input.file.path),
                provider.context.providerId
              )
            )
          )
        );
    });
  }

  private stopGroups(entry: Entry) {
    entry.features.invalidate();
    entry.pull.stop();
    entry.diagnostics.clear();
    entry.unformat?.();
    entry.unformat = null;

    for (const detach of entry.detach) detach();
    entry.detach = [];
    entry.groups = [];

    pruneLanguageGroups(this.groups);
  }

  private environment(entry: Entry) {
    const app = this.app();
    const host = app.hosts.find((value) => value.key === entry.input.file.hostKey);
    const document = previewDocument(app, entry.input.file);
    const identity = this.identity(entry.input.file.hostKey);

    const usable =
      host?.status.state === "connected" &&
      host.status.capabilities.includes("languages") &&
      identity !== null &&
      identity.hostId === host.status.host?.hostId &&
      identity.connectionEpoch > 0;

    return { host, document, identity: usable ? identity : null };
  }

  private async refreshEntry(entry: Entry, force = false, reportFailure = false, refresh = false) {
    if (entry.disposed) return;
    const environment = this.environment(entry);

    const stamp = JSON.stringify([
      environment.identity,
      environment.document?.checkout,
      environment.host?.status.state,
      environment.host?.status.capabilities,
      entry.manual,
    ]);

    if (!force && stamp === entry.stamp) return;

    if (stamp !== entry.stamp && entry.stamp !== "") this.observations.invalidate();
    entry.stamp = stamp;
    entry.controller.abort();
    entry.controller = new AbortController();
    const signal = entry.controller.signal;
    this.stopGroups(entry);
    const key = fileKey(entry.input.file.hostKey, entry.input.file.path);

    if (
      environment.identity === null ||
      environment.document === null ||
      this.api() === undefined
    ) {
      if (entry.manual === null) {
        entry.language = languageFor(entry.input.file.path, entry.read().doc.line(1).text);
        void applyBufferLanguage(key, entry.language);
      }

      this.localConfiguration(entry, environment.document, stamp);
      Status.statusLocal(key);

      languagePatch(key, {
        status: "unavailable",
        fact: noToolingFact(environment.host),
        providers: [],
        rows: [],
        busy: false,
      });

      return;
    }

    languagePatch(key, {
      status: "loading",
      fact: "Checking language tooling on this Host…",
      rows: [],
      busy: false,
    });
    Status.statusChecking(key, environment.document.checkout);
    const { identity, document } = environment;

    await this.observations
      .settled(() => this.configure(entry, identity, document.checkout, stamp, signal, refresh))
      .catch((error: P.LanguageError | Error) => {
        if (entry.disposed || signal.aborted || stamp !== entry.stamp) return;
        const reason = languageErrorOf(error)?.reason;
        Status.statusFailed(key, { reason: reason ?? "unknown", message: error.message });
        languagePatch(key, {
          status: "unavailable",
          fact:
            reason === "awaiting-trust"
              ? "Language tooling needs trust. Open Settings → Languages and select this checkout."
              : "Language tooling is unavailable. Check Settings → Languages for this Host.",
          providers: [],
        });

        if (reportFailure) throw error;
      });
  }

  private localConfiguration(
    entry: Entry,
    document: ReturnType<typeof previewDocument>,
    stamp: string
  ) {
    const api = this.api();

    if (api === undefined || document === null) return;
    const key = fileKey(entry.input.file.hostKey, entry.input.file.path);
    void readLanguageConfiguration(api, {
      hostKey: entry.input.file.hostKey,
      hostId: document.hostId,
      workspaceId: document.checkout.workspaceId,
      path: entry.input.file.path,
      manual: entry.manual,
      firstLine: entry.read().doc.line(1).text,
      signal: entry.controller.signal,
    })
      .then((configuration) => {
        if (entry.disposed || stamp !== entry.stamp) return;
        entry.language = configuration.language;
        void applyBufferLanguage(key, entry.language);
        languagePatch(key, { language: entry.language, manual: entry.manual });
      })
      .catch(() => undefined);
  }

  private async configure(
    entry: Entry,
    identity: AuthenticatedLanguageIdentity,
    checkout: P.LanguageCheckout,
    stamp: string,
    signal: AbortSignal,
    refresh = false
  ) {
    const api = this.api();

    if (api === undefined) return;
    const { file } = entry.input;

    const current = () =>
      !entry.disposed &&
      !signal.aborted &&
      stamp === entry.stamp &&
      JSON.stringify(this.environment(entry).identity) === JSON.stringify(identity);

    const scope = { hostKey: file.hostKey, identity, checkout };

    const configuration = await this.observations.configuration(api, scope, {
      hostKey: file.hostKey,
      hostId: identity.hostId,
      workspaceId: checkout.workspaceId,
      path: file.path,
      manual: entry.manual,
      firstLine: entry.read().doc.line(1).text,
      signal,
    });

    if (!current()) return;
    entry.language = configuration.language;
    void applyBufferLanguage(fileKey(file.hostKey, file.path), entry.language);

    const { found, disabled } = await this.observations.discover(
      api,
      scope,
      file.path,
      documentLanguageId(entry.language),
      configuration.settings,
      refresh
    );

    if (!current() || JSON.stringify(found.checkout) !== JSON.stringify(checkout)) return;
    entry.disabled = disabled;
    Status.statusDiscovered(fileKey(file.hostKey, file.path), found);
    trustDiscovered(
      { hostKey: file.hostKey, checkout, path: file.path },
      fileKey(file.hostKey, file.path),
      found
    );

    const selected = configuration.settings.providers.length
      ? configuration.settings.providers
      : found.providers.map((provider) => provider.providerId);

    const eligible = selected.filter(
      (id, index) =>
        selected.indexOf(id) === index &&
        found.providers.some(
          (provider) =>
            provider.providerId === id && Predicate.isTagged(provider.preflight, "Eligible")
        )
    );

    for (const id of eligible) this.attachProvider(entry, api, identity, checkout, found, id);

    await Promise.all(entry.groups.map((group) => group.ready()));

    if (!current()) return;
    entry.unformat = bindEntryFormatter({
      file,
      api,
      checkout,
      found,
      features: entry.features,
      ready: async () => {
        await Promise.all(entry.groups.map((group) => group.ready()));
      },
      read: entry.read,
      revision: entry.input.revision,
      current,
      workspace: () =>
        this.app().hostModels[file.hostKey]?.workspaces.get(checkout.workspaceId)?.name ??
        "this workspace",
    });
  }

  private attachProvider(
    entry: Entry,
    api: LanguageApi,
    identity: AuthenticatedLanguageIdentity,
    checkout: P.LanguageCheckout,
    found: typeof P.LanguageDiscovery.Type,
    id: string
  ) {
    const file = entry.input.file;

    const groupKey = JSON.stringify([
      file.hostKey,
      identity,
      checkout,
      found.projectRoot,
      id,
      found.effectiveSettings,
      entry.language === "sql" ? file.path : null,
    ]);

    let group = this.groups.get(groupKey);

    if (group === undefined || group.isDisposed()) {
      admitLanguageGroup(this.groups);
      group = new EditorLanguageSession(
        api,
        file.hostKey,
        {
          clientId: identity.clientId,
          contextId: contextIdOf(groupKey),
          checkout,
          path: file.path,
          providerId: id,
          settings: found.effectiveSettings,
          interestId: `editor-${this.instance}`,
        },
        identity.hostId,
        (event) => this.serverRequest(api, file.hostKey, found.effectiveSettings, event),
        (event) => {
          contextObserved(file.hostKey, event);

          if (Predicate.isTagged(event, "Replaced") || Predicate.isTagged(event, "Invalidated"))
            this.observations.invalidate();

          // A Trust change replaces the context; its new decision reaches the popover from here.
          if (Predicate.isTagged(event, "Replaced")) {
            const target = trustStore.getState().targets[fileKey(file.hostKey, file.path)];

            if (target !== undefined) void refreshTrust(api, target).catch(() => undefined);
          }

          if (!Predicate.isTagged(event, "Diagnostics")) return;

          for (const value of this.entries.values()) {
            const provider = value.features.options
              .providers()
              .find(
                (candidate) => candidate.context.contextId === event.diagnostics.context.contextId
              );

            if (provider !== undefined) value.diagnostics.receive(provider, event.diagnostics);
          }
        },
        identity.connectionEpoch
      );
      this.groups.set(groupKey, group);
    }

    entry.groups.push(group);
    Status.statusAttached(fileKey(file.hostKey, file.path), id, group.acquisition.contextId);
    entry.detach.push(
      group.attach({
        read: entry.read,
        language: () => entry.language,
        changed: () => {
          const providers = entry.features.options.providers();

          const signature = JSON.stringify(
            providers.map((provider) => [
              provider.context,
              provider.capabilities,
              provider.ack.documents.find((document) => document.uri === entry.read().uri),
            ])
          );

          if (signature !== entry.providerSignature) {
            entry.features.invalidate();
            entry.diagnostics.clear();
            entry.pull.schedule();
            const key = fileKey(file.hostKey, file.path);
            // An open panel waits for the replacement provider rather than reading "No results".
            languagePatch(key, {
              rows: [],
              busy: providers.length === 0 && languageStore.getState().files[key]?.panel != null,
            });
          }

          entry.providerSignature = signature;
          languagePatch(fileKey(file.hostKey, file.path), {
            language: entry.language,
            manual: entry.manual,
            providers: providers.map((provider) => provider.context.providerId),
            methods: [...new Set(providers.flatMap((provider) => provider.capabilities.methods))],
            status: providers.length ? "ready" : "unavailable",
            fact: providers.length ? "" : "Language tooling is unavailable or synchronizing.",
          });
        },
      })
    );
  }

  private async serverRequest(
    api: LanguageApi,
    hostKey: string,
    settings: typeof P.LanguageEffectiveSettings.Type,
    event: Extract<P.LanguageContextEvent, { _tag: "ServerRequest" }>
  ) {
    if (await respondResourceReceiptRequest(api, hostKey, event)) return;

    const offer = (kind: "legacy" | "tree", proposal: PreparedLanguageEdit) => {
      const entries = [...this.entries.values()].filter(
        (entry) => entry.input.file.hostKey === hostKey
      );

      const buffers = entries.map((entry) => entry.read());
      const signatures = entries.map((entry) => entry.providerSignature);
      const identity = this.identity(hostKey);

      return offerServerEdit({
        context: event.request.context,
        proposal,
        kind,
        treeNegotiated: P.languageRpcAllowed(
          "languages.tree.edit.decide",
          this.app().hosts.find((host) => host.key === hostKey)?.status.capabilities ?? []
        ),
        providers: entries.flatMap((entry) => entry.features.options.providers()),
        buffers,
        current: () =>
          identity !== null &&
          JSON.stringify(identity) === JSON.stringify(this.identity(hostKey)) &&
          entries.every(
            (entry, index) =>
              !entry.disposed &&
              entry.providerSignature === signatures[index] &&
              entry.read().doc === buffers[index]?.doc &&
              entry.read().version === buffers[index]?.version
          ),
        offer: editProposal,
      });
    };

    const result = await Match.value(event.payload).pipe(
      Match.tag("Configuration", ({ items }) =>
        configurationItems(event.request.context, settings, items)
      ),
      Match.tag("WorkspaceFolders", () => [
        {
          uri: `file://${encodeURI(event.request.context.projectRoot)}`,
          name: event.request.context.projectRoot.split("/").pop() ?? "Workspace",
        },
      ]),
      Match.tag("ApplyEdit", ({ proposal }) => offer("legacy", proposal)),
      Match.tag("TreeApplyEdit", ({ proposal }) => offer("tree", proposal)),
      Match.tag("Unsupported", () => undefined),
      Match.orElse(() => null)
    );

    void api
      .request("languages.server.respond", {
        hostKey,
        context: event.request.context,
        response: P.LanguageJsonRpcResponse.make({
          jsonrpc: "2.0",
          id: event.request.request.id,
          ...(result === undefined
            ? { error: { code: -32601, message: "Unsupported language server request." } }
            : { result }),
        }),
      })
      .catch(() => undefined);
  }

  select(key: string, language: LanguageId | null) {
    const entry = this.entries.get(key);

    if (entry === undefined) return;
    entry.manual = language;

    if (language !== null) {
      entry.language = language;
      void applyBufferLanguage(key, language);
    }

    languagePatch(key, { language: entry.language, manual: language });
    void this.refreshEntry(entry, true);
  }

  async action(
    key: string,
    provider: LanguageProvider,
    action: NonNullable<typeof CodeActions.Type>[number],
    request: P.LanguageFeatureRequest,
    result: P.LanguageFeatureResult
  ) {
    const entry = this.entries.get(key);

    if (entry === undefined || action.disabled !== undefined) return;
    const buffer = entry.read();

    if (
      !entry.features.requests.intentCurrent(provider, buffer, request.fence) ||
      !featureIntentCurrent(request, result, provider, buffer)
    )
      return;

    if (actionProposal !== null) {
      actionProposal({ action, provider, buffer, request, result });

      return;
    }

    if (!("edit" in action) || action.edit === undefined) {
      this.unavailableEdit(key);

      return;
    }

    await this.prepareEdit(
      key,
      provider,
      request,
      result,
      action.edit,
      "code-action",
      action.title
    );
  }

  async prepareEdit(
    key: string,
    provider: LanguageProvider,
    request: P.LanguageFeatureRequest,
    result: P.LanguageFeatureResult,
    edit: P.LanguageWorkspaceEdit,
    origin: "rename" | "code-action",
    label: string
  ) {
    const entry = this.entries.get(key);

    if (entry === undefined) return;
    const buffer = entry.read();

    const current = () =>
      this.entries.get(key) === entry &&
      entry.features.requests.intentCurrent(provider, buffer, request.fence) &&
      featureIntentCurrent(request, result, provider, buffer);

    try {
      const proposal = await prepareLanguageEdit(
        { request, result, edit, origin, label, signal: entry.features.requests.signal },
        current
      );

      if (!current()) return;

      if (proposal === null || editProposal === null) {
        this.unavailableEdit(key);

        return;
      }

      await editProposal(proposal);
    } catch {
      if (current()) this.unavailableEdit(key, "Edit preparation failed.");
    }
  }

  private unavailableEdit(key: string, label = "The edit coordinator is unavailable.") {
    languagePatch(key, {
      panel: "Edit acceptance",
      rows: [
        {
          label,
          detail: "No edits were applied.",
        },
      ],
    });
  }

  refreshSettings(hostKey: string, workspaceId: string) {
    this.observations.invalidate();

    for (const entry of this.entries.values())
      if (entry.input.file.hostKey === hostKey && entry.input.file.workspaceId === workspaceId)
        void this.refreshEntry(entry, true);
  }
  refreshHosts() {
    this.refresh();
  }
  /** Check again: forget cached discovery and rediscover this file (a Prerequisite was installed). */
  async recheck(key: string) {
    const entry = this.entries.get(key);

    if (entry === undefined)
      throw new P.LanguageError({
        reason: "not-ready",
        message:
          "This file's language tooling is no longer attached. Reopen the file and try again.",
        retryable: true,
      });
    this.observations.invalidate();
    const api = this.api();

    if (api === undefined)
      throw new P.LanguageError({
        reason: "not-connected",
        message: "Language tooling is unavailable on this Host.",
        retryable: true,
      });
    await refreshHostTools(api, entry.input.file.hostKey, documentLanguageId(entry.language));
    await this.refreshEntry(entry, true, true, true);
  }
  private release(entry: Entry) {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.controller.abort();
    this.stopGroups(entry);
    entry.features.dispose();
    entry.diagnostics.dispose();
    entry.input.view.dispatch({ effects: entry.compartment.reconfigure([]) });
    const key = fileKey(entry.input.file.hostKey, entry.input.file.path);

    if (this.entries.get(key) === entry) {
      this.entries.delete(key);
      Status.statusClosed(key);
      languageStore.setState((state) => {
        const { [key]: _gone, ...files } = state.files;

        return { files };
      });
    }
  }
  dispose() {
    refreshers.delete(this.refresh);
    this.untrust();
    this.observations.invalidate();

    for (const entry of this.entries.values()) this.release(entry);

    for (const group of this.groups.values()) group.dispose();
    this.groups.clear();
  }
}
