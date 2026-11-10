import * as P from "@polaris/protocol";
import { Match } from "effect";
import type { EditorState } from "@codemirror/state";
import type { EditorLanguageCoordinator } from "./integration.ts";
import type { LanguageProvider } from "./types.ts";
import { languagePatch, languageStore, type LanguageRow } from "./state.ts";
import { offsetAt, positionAt } from "./position.ts";
import { fileKey } from "../model/drafts.ts";
import { openFile } from "../api.ts";
import { editorPlaces } from "../navigation/places.ts";
import { viewOf, whenLoaded, revealLine } from "../runtime/buffers.ts";
import * as Payload from "./payloads.ts";
import { pulledDiagnostics } from "./pull.ts";
import { providerLabel } from "../trust/store.ts";

export type LanguageCommand =
  | "definition"
  | "declaration"
  | "typeDefinition"
  | "implementation"
  | "references"
  | "symbols"
  | "workspaceSymbols"
  | "signature"
  | "problems"
  | "actions"
  | "rename";

export const locationPath = (uri: string, root: string): string | null => {
  try {
    const url = new URL(uri);

    if (url.protocol !== "file:" || url.hostname !== "") return null;
    const path = decodeURIComponent(url.pathname);

    return path.startsWith(`${root.replace(/\/+$/, "")}/`) && !path.split("/").includes("..")
      ? path
      : null;
  } catch {
    return null;
  }
};

type Location = typeof Payload.Location.Type | typeof Payload.LocationLink.Type;

/** The provider as the language status names it (trust/model.ts providerName). */
const named = (key: string, provider: LanguageProvider) =>
  providerLabel(key, provider.context.providerId);

const rowOf = (
  location: Location,
  provider: LanguageProvider,
  name: string,
  label?: string
): LanguageRow => {
  const uri = "targetUri" in location ? location.targetUri : location.uri;
  const range = "targetUri" in location ? location.targetSelectionRange : location.range;

  return {
    label: label ?? `${decodeURI(uri.split("/").pop() ?? uri)}:${range.start.line + 1}`,
    detail: name,
    uri,
    range,
    encoding: provider.capabilities.positionEncoding,
  };
};

/** "Rename BASE_DELAY_MS to RETRY_DELAY_MS": the preview's title names both. */
const renameLabel = (state: EditorState, head: number, to: string) => {
  const word = state.wordAt(head);

  return word === null
    ? `Rename to ${to}`
    : `Rename ${state.sliceDoc(word.from, word.to)} to ${to}`;
};

export class LanguageQueries {
  private readonly pending = new Map<string, AbortController>();
  private readonly previousIds = new Map<string, string>();

  private readonly last = new Map<string, { command: LanguageCommand; query: string }>();
  /** A panel cleared by a provider swap (Trust, restart) asks the replacement once it is ready. */
  readonly unwatch = languageStore.subscribe((state, previous) => {
    for (const [key, file] of Object.entries(state.files)) {
      const last = this.last.get(key);

      if (
        last !== undefined &&
        file.panel !== null &&
        file.busy &&
        file.status === "ready" &&
        previous.files[key]?.status !== "ready"
      )
        void this.run(key, last.command, last.query);
    }
  });

  constructor(readonly coordinator: EditorLanguageCoordinator) {}

  close(key: string) {
    this.last.delete(key);
    this.pending.get(key)?.abort();
    this.pending.delete(key);
    languagePatch(key, { panel: null, rows: [], busy: false });
  }

  async run(key: string, command: LanguageCommand, query = "") {
    const entry = this.coordinator.get(key);

    this.last.set(key, { command, query });

    if (entry === undefined) return;
    this.pending.get(key)?.abort();
    const controller = new AbortController();
    this.pending.set(key, controller);
    const buffer = entry.read();
    const ownership = entry.providerSignature;

    const panel = {
      definition: "Definitions",
      declaration: "Declarations",
      typeDefinition: "Type definitions",
      implementation: "Implementations",
      references: "References",
      symbols: "Document symbols",
      workspaceSymbols: "Workspace symbols",
      signature: "Signature help",
      problems: "Problems",
      actions: "Code actions",
      rename: "Rename",
    }[command];

    languagePatch(key, { panel, rows: [], busy: true });

    const current = () =>
      !controller.signal.aborted &&
      this.pending.get(key) === controller &&
      this.coordinator.get(key) === entry &&
      entry.providerSignature === ownership &&
      entry.read().doc === buffer.doc &&
      entry.read().version === buffer.version;

    try {
      let rows = await this.rowsFor(key, command, query, controller.signal);

      if (!current()) return;
      const seen = new Set<string>();
      rows = rows
        .filter((row) => {
          const signature = JSON.stringify([row.label, row.uri, row.range, row.detail]);

          if (seen.has(signature)) return false;
          seen.add(signature);

          return true;
        })
        .slice(0, 2000);
      languagePatch(key, { rows, busy: false });

      if (
        (command === "definition" ||
          command === "declaration" ||
          command === "typeDefinition" ||
          command === "implementation") &&
        rows.length === 1 &&
        rows[0]
      )
        await this.navigate(key, rows[0]);
    } catch {
      if (current())
        languagePatch(key, {
          rows: [
            {
              label: "Language request failed.",
              detail: "The document or Host may have changed. Try again.",
            },
          ],
          busy: false,
        });
    }
  }

  /** Rows for a command without the panel: the rename field and the symbol search read these. */
  lookup(key: string, command: LanguageCommand, query: string, signal: AbortSignal) {
    return this.rowsFor(key, command, query, signal);
  }

  private async rowsFor(
    key: string,
    command: LanguageCommand,
    query: string,
    signal: AbortSignal
  ): Promise<LanguageRow[]> {
    const entry = this.coordinator.get(key);

    if (entry === undefined) return [];
    const head = entry.input.view.state.selection.main.head;
    let rows: LanguageRow[] = [];
    const features = entry.features;

    if (
      command === "definition" ||
      command === "declaration" ||
      command === "typeDefinition" ||
      command === "implementation" ||
      command === "references"
    ) {
      const answers = await Match.value(command).pipe(
        Match.when("references", () => features.references(head, true, signal)),
        Match.when("declaration", () => features.declaration(head, signal)),
        Match.orElse((method) => features.navigation(`textDocument/${method}`, head, signal))
      );

      rows = answers.flatMap(({ provider, payload }) =>
        ("uri" in payload ? [payload] : payload).map((location) =>
          rowOf(location, provider, named(key, provider))
        )
      );
    } else if (command === "symbols") {
      rows = await this.symbolRows(entry, signal);
    } else if (command === "workspaceSymbols") {
      const answers = await features.workspaceSymbols(query, signal);
      rows = answers.flatMap(({ provider, payload }) =>
        payload.map((symbol): LanguageRow => ({
          label: symbol.name,
          detail: named(key, provider),
          uri: symbol.location.uri,
          ...(symbol.location.range
            ? { range: symbol.location.range, encoding: provider.capabilities.positionEncoding }
            : { run: () => void this.resolveSymbol(key, provider, symbol) }),
        }))
      );
    } else if (command === "signature") {
      const answers = await features.signature(head, signal);
      rows = answers.flatMap(({ provider, payload }) =>
        payload.signatures.map((signature) => ({
          label: signature.label,
          detail: `${named(key, provider)} · Parameter ${(signature.activeParameter ?? payload.activeParameter ?? 0) + 1}`,
        }))
      );
    } else if (command === "problems") {
      await this.pullProblems(key, signal);
      rows = entry.diagnostics.values().flatMap(({ provider, diagnostics }) =>
        diagnostics.items.map((item) => ({
          label: item.message,
          detail: `${named(key, provider)} · ${diagnostics.freshness}${diagnostics.truncated ? " · truncated" : ""}`,
          uri: diagnostics.uri,
          range: item.range,
          encoding: provider.capabilities.positionEncoding,
        }))
      );
    } else if (command === "rename") {
      if (query.trim() === "")
        return [{ label: "Enter a new name.", detail: "No edits were requested." }];
      const answers = await features.rename(head, query, signal);
      const label = renameLabel(entry.input.view.state, head, query);
      rows = answers.flatMap(({ provider, request, value }) => {
        const edit = Payload.decodePayload(P.LanguageWorkspaceEdit, value.result);

        return edit === undefined || edit === null
          ? []
          : [
              {
                label,
                detail: `${named(key, provider)} · Requires edit acceptance`,
                run: () =>
                  void this.coordinator.prepareEdit(
                    key,
                    provider,
                    request,
                    value,
                    edit,
                    "rename",
                    label
                  ),
              },
            ];
      });
    } else {
      const selection = entry.input.view.state.selection.main;
      const answers = await features.codeActions(selection.from, selection.to, signal);
      rows = answers.flatMap(({ provider, request, value, payload }) =>
        payload.map((action) => ({
          label: action.title,
          detail: action.disabled?.reason ?? `${named(key, provider)} · Requires edit acceptance`,
          run: () => void this.coordinator.action(key, provider, action, request, value),
        }))
      );
    }

    return rows;
  }

  private async symbolRows(
    entry: NonNullable<ReturnType<EditorLanguageCoordinator["get"]>>,
    signal: AbortSignal
  ): Promise<LanguageRow[]> {
    const key = fileKey(entry.input.file.hostKey, entry.input.file.path);
    const features = entry.features;
    const buffer = entry.read();
    const rows: LanguageRow[] = [];
    const answers = await features.documentSymbols(signal);

    for (const answer of answers) {
      const stack = [...answer.payload].reverse();

      while (stack.length && rows.length < 2000) {
        const symbol = stack.pop();

        if (symbol === undefined) continue;

        if ("location" in symbol)
          rows.push(
            rowOf(symbol.location, answer.provider, named(key, answer.provider), symbol.name)
          );
        else {
          rows.push(
            rowOf(
              { uri: buffer.uri, range: symbol.selectionRange },
              answer.provider,
              named(key, answer.provider),
              symbol.name
            )
          );
          stack.push(...[...(symbol.children ?? [])].reverse());
        }
      }
    }

    return rows;
  }

  private async resolveSymbol(
    key: string,
    provider: LanguageProvider,
    symbol: NonNullable<typeof Payload.WorkspaceSymbols.Type>[number]
  ) {
    const entry = this.coordinator.get(key);

    if (entry === undefined) return;
    const answers = await entry.features.resolve(provider, "workspaceSymbol/resolve", symbol);

    const resolved =
      answers[0] && Payload.decodePayload(Payload.SymbolInformation, answers[0].value.result);

    if (resolved)
      await this.navigate(
        key,
        rowOf(resolved.location, provider, named(key, provider), resolved.name)
      );
  }

  private async pullProblems(key: string, signal: AbortSignal) {
    const entry = this.coordinator.get(key);

    if (entry === undefined) return;
    const buffer = entry.read();
    const answers = await entry.features.pullDiagnostics(this.previousIds, signal);

    for (const { provider, payload } of answers) {
      const previousResultId = this.previousIds.get(provider.context.contextId) ?? null;
      const resultId = payload.resultId ?? null;

      if (resultId !== null) this.previousIds.set(provider.context.contextId, resultId);
      entry.diagnostics.receive(
        provider,
        pulledDiagnostics(provider, buffer, payload, previousResultId)
      );
    }
  }

  async navigate(key: string, row: LanguageRow) {
    if (row.run) {
      row.run();

      return;
    }

    const entry = this.coordinator.get(key);

    if (
      entry === undefined ||
      row.uri === undefined ||
      row.range === undefined ||
      row.encoding === undefined
    )
      return;
    const provider = entry.features.options.providers()[0];

    if (provider === undefined) return;
    const path = locationPath(row.uri, provider.context.checkout.path);

    if (path === null) {
      languagePatch(key, {
        rows: [
          {
            label: "This target is outside the current checkout.",
            detail: "Open it explicitly in its Workspace.",
          },
        ],
      });

      return;
    }

    const ownership = entry.providerSignature;
    const sourceVersion = entry.read().version;
    const origin = entry.input.view.state.selection.main.head;
    const point = positionAt(entry.input.view.state.doc, origin, "utf-16");
    editorPlaces.leave({ ...entry.input.file, line: point.line + 1, column: point.character + 1 });
    const file = { ...entry.input.file, path };
    openFile(file);
    await whenLoaded(fileKey(file.hostKey, path));
    const view = viewOf(fileKey(file.hostKey, path));

    if (
      view === null ||
      this.coordinator.get(key) !== entry ||
      entry.providerSignature !== ownership ||
      entry.read().version !== sourceVersion
    )
      return;

    try {
      const offset = offsetAt(view.state.doc, row.range.start, row.encoding);
      const line = view.state.doc.lineAt(offset);
      revealLine(view, line.number, offset - line.from + 1);
    } catch {
      languagePatch(key, {
        rows: [
          { label: "The target position is no longer valid.", detail: "Request navigation again." },
        ],
      });
    }
  }
}
