import * as P from "@polaris/protocol";
import { Predicate, Schema } from "effect";
import * as Payload from "./payloads.ts";
import { positionAt } from "./position.ts";
import { LanguageRequests, providerFence, sameFence } from "./requests.ts";
import { bufferText, type LanguageAdapterOptions, type LanguageProvider } from "./types.ts";

type Method = typeof P.LanguageFeatureMethod.Type;

type JsonObject = typeof P.LanguageJsonObject.Type;

type PullDiagnosticParams = {
  textDocument: { uri: string };
  previousResultId?: string;
};

const formatterEligible = (provider: LanguageProvider, input: P.LanguageFormatPreflight): boolean =>
  !Predicate.isTagged(input.formatter, "Provider") ||
  (input.formatter.providerId === provider.context.providerId &&
    provider.capabilities.methods.includes("textDocument/formatting"));

const formattedFenceMatches = (
  value: P.LanguageFormatOutcome,
  input: P.LanguageFormatPreflight
): boolean =>
  !Predicate.isTagged(value, "Formatted") ||
  (sameFence(value.fence, input.fence) &&
    value.document.uri === input.document.uri &&
    value.document.version === input.document.version);

/** No document synchronization, navigation, save or durable edit ownership lives here. */
export class LanguageFeatures {
  readonly requests: LanguageRequests;
  constructor(readonly options: LanguageAdapterOptions) {
    this.requests = new LanguageRequests(options);
  }
  dispose() {
    this.requests.dispose();
  }
  invalidate() {
    this.requests.invalidate();
  }

  at(method: Method, offset: number, extra: JsonObject = {}, signal?: AbortSignal) {
    const buffer = this.options.buffer();

    return this.requests.query(
      method,
      (provider) => ({
        textDocument: { uri: buffer.uri },
        position: positionAt(buffer.doc, offset, provider.capabilities.positionEncoding),
        ...extra,
      }),
      signal
    );
  }

  private async decoded<S extends Schema.ConstraintDecoder<unknown>>(
    method: Method,
    schema: S,
    params: (provider: LanguageProvider) => JsonObject,
    signal?: AbortSignal,
    lane: string = method
  ) {
    const answers = await this.requests.query(method, params, signal, lane);

    return answers.flatMap(({ provider, request, value }) => {
      const payload = Payload.decodePayload(schema, value.result);

      return payload === undefined || payload === null
        ? []
        : [{ provider, request, value, payload, proposals: value.proposals ?? [] }];
    });
  }

  private point(offset: number, extra: JsonObject = {}) {
    const buffer = this.options.buffer();

    return (provider: LanguageProvider): JsonObject => ({
      textDocument: { uri: buffer.uri },
      position: positionAt(buffer.doc, offset, provider.capabilities.positionEncoding),
      ...extra,
    });
  }

  completion(offset: number, signal?: AbortSignal, triggerCharacter?: string) {
    const point = this.point(offset);

    return this.decoded(
      "textDocument/completion",
      Payload.CompletionResult,
      (provider) => ({
        ...point(provider),
        context:
          triggerCharacter && provider.completionTriggerCharacters?.includes(triggerCharacter)
            ? { triggerKind: 2, triggerCharacter }
            : { triggerKind: 1 },
      }),
      signal
    );
  }
  hover(offset: number, signal?: AbortSignal) {
    return this.decoded("textDocument/hover", Payload.Hover, this.point(offset), signal);
  }
  signature(offset: number, signal?: AbortSignal) {
    return this.decoded(
      "textDocument/signatureHelp",
      Payload.Signature,
      this.point(offset),
      signal
    );
  }
  navigation(
    method:
      | "textDocument/definition"
      | "textDocument/declaration"
      | "textDocument/typeDefinition"
      | "textDocument/implementation",
    offset: number,
    signal?: AbortSignal
  ) {
    return this.decoded(method, Payload.Locations, this.point(offset), signal);
  }
  /** Each server's declarations; one without `declarationProvider` answers with its definitions. */
  async declaration(offset: number, signal?: AbortSignal) {
    const declares = (provider: LanguageProvider) =>
      provider.capabilities.methods.includes("textDocument/declaration");

    const [declared, defined] = await Promise.all([
      this.navigation("textDocument/declaration", offset, signal),
      this.options.providers().every(declares)
        ? []
        : this.decoded(
            "textDocument/definition",
            Payload.Locations,
            this.point(offset),
            signal,
            "textDocument/declaration:definition"
          ),
    ]);

    return [...declared, ...defined.filter((answer) => !declares(answer.provider))];
  }
  references(offset: number, includeDeclaration = true, signal?: AbortSignal) {
    return this.decoded(
      "textDocument/references",
      Payload.Locations,
      this.point(offset, { context: { includeDeclaration } }),
      signal
    );
  }
  documentSymbols(signal?: AbortSignal) {
    return this.decoded(
      "textDocument/documentSymbol",
      Payload.DocumentSymbols,
      () => ({ textDocument: { uri: this.options.buffer().uri } }),
      signal
    );
  }
  workspaceSymbols(query: string, signal?: AbortSignal) {
    return this.decoded(
      "workspace/symbol",
      Payload.WorkspaceSymbols,
      () => ({ query: query.slice(0, 1024) }),
      signal
    );
  }

  pullDiagnostics(previousIds: ReadonlyMap<string, string>, signal?: AbortSignal) {
    return this.decoded(
      "textDocument/diagnostic",
      Payload.PullDiagnostic,
      (provider) => {
        const params: PullDiagnosticParams = {
          textDocument: { uri: this.options.buffer().uri },
        };

        const previous = previousIds.get(provider.context.contextId);

        if (previous) params.previousResultId = previous;

        return params;
      },
      signal
    );
  }

  /** R1 snapshots/revalidates these proposals again at acceptance; this never applies them. */
  editProposals(results: readonly import("./types.ts").ProviderResult[]): P.LanguageEditProposal[] {
    const buffer = this.options.buffer();

    return results
      .flatMap(({ provider, request, value }) => {
        if (!this.requests.intentCurrent(provider, buffer, request.fence)) return [];

        return (value.proposals ?? []).filter(
          (proposal) => sameFence(proposal.fence, value.fence) && proposal.expiresAt > Date.now()
        );
      })
      .slice(0, 128);
  }
  codeActions(from: number, to: number, signal?: AbortSignal) {
    const buffer = this.options.buffer();

    return this.decoded(
      "textDocument/codeAction",
      Payload.CodeActions,
      (provider) => ({
        textDocument: { uri: buffer.uri },
        range: {
          start: positionAt(buffer.doc, from, provider.capabilities.positionEncoding),
          end: positionAt(buffer.doc, to, provider.capabilities.positionEncoding),
        },
        context: { diagnostics: [] },
      }),
      signal
    );
  }
  /** Quick fixes for one diagnostic, on their own lane so a code action menu request survives. */
  quickFixes(
    from: number,
    to: number,
    diagnostic: JsonObject,
    signal?: AbortSignal,
    lane = "quickfix"
  ) {
    const buffer = this.options.buffer();

    return this.decoded(
      "textDocument/codeAction",
      Payload.CodeActions,
      (provider) => ({
        textDocument: { uri: buffer.uri },
        range: {
          start: positionAt(buffer.doc, from, provider.capabilities.positionEncoding),
          end: positionAt(buffer.doc, to, provider.capabilities.positionEncoding),
        },
        context: { diagnostics: [diagnostic], only: ["quickfix"], triggerKind: 2 },
      }),
      signal,
      lane
    );
  }
  rename(offset: number, newName: string, signal?: AbortSignal) {
    return this.at("textDocument/rename", offset, { newName }, signal);
  }

  /** Resolve and commands stay on their originating provider and actual capability. */
  async resolve(
    provider: LanguageProvider,
    method: "completionItem/resolve" | "codeAction/resolve" | "workspaceSymbol/resolve",
    item: JsonObject,
    signal?: AbortSignal,
    lane = `${method}-${provider.context.contextId}`
  ) {
    if (method === "completionItem/resolve" && !provider.capabilities.completionResolve) return [];

    if (method === "codeAction/resolve" && !provider.capabilities.actionResolve) return [];

    return this.requests.query(method, () => item, signal, lane, provider);
  }
  async execute(
    provider: LanguageProvider,
    command: string,
    args: readonly (typeof P.LanguageJson.Type)[],
    signal?: AbortSignal
  ) {
    if (!provider.capabilities.executeCommands.includes(command)) return [];

    return this.requests.query(
      "workspace/executeCommand",
      () => ({ command, arguments: [...args] }),
      signal,
      `command-${provider.context.contextId}`,
      provider
    );
  }

  /** F2 revalidates edits before application and owns the separate disk-save outcome. */
  async format(
    provider: LanguageProvider,
    input: P.LanguageFormatPreflight,
    signal?: AbortSignal
  ): Promise<P.LanguageFormatOutcome> {
    const buffer = this.options.buffer();

    if (Predicate.isTagged(input.formatter, "None"))
      return P.LanguageFormatOutcome.cases.Skipped.make({
        requestId: input.requestId,
        reason: "no-formatter",
      });

    const failed = (
      reason: "stale" | "timeout" | "cancelled" | "formatter-failed" | "unavailable"
    ) =>
      P.LanguageFormatOutcome.cases.Failed.make({
        requestId: input.requestId,
        reason,
        message: `Language formatting: ${reason}`,
      });

    if (!formatterEligible(provider, input)) return failed("unavailable");

    if (
      !this.requests.current(provider, buffer) ||
      !sameFence(input.fence, providerFence(provider, buffer)) ||
      input.snapshot !== bufferText(buffer)
    )
      return failed("stale");
    const deadline = Math.min(input.deadline - Date.now(), this.requests.timeoutMs);

    if (deadline <= 0) return failed("timeout");
    const controller = new AbortController();

    const joined = AbortSignal.any([
      controller.signal,
      this.requests.signal,
      ...(signal ? [signal] : []),
    ]);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};

    const release = this.requests.reserve();

    if (release === null) return failed("formatter-failed");
    let dispatched = false;

    try {
      const cancelled = new Promise<null>((resolve) => {
        abort = () => resolve(null);
        joined.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => controller.abort(), deadline);
      });

      if (joined.aborted) return failed("cancelled");

      const remote = this.options.api
        .request("languages.format", { hostKey: provider.hostKey, ...input })
        .finally(release);

      dispatched = true;

      const answer = await Promise.race([remote, cancelled]);

      if (answer === null) {
        void this.options.api
          .request("languages.cancel", {
            hostKey: provider.hostKey,
            context: provider.context,
            requestId: input.requestId,
          })
          .catch(() => undefined);

        return failed(controller.signal.aborted ? "timeout" : "cancelled");
      }

      if (!answer.ok) return failed("formatter-failed");
      const value = Schema.decodeUnknownSync(P.LanguageFormatOutcome)(answer.value);

      if (!this.requests.current(provider, buffer) || value.requestId !== input.requestId)
        return failed("stale");

      if (!formattedFenceMatches(value, input)) return failed("stale");

      return value;
    } catch {
      return failed("formatter-failed");
    } finally {
      clearTimeout(timer);
      joined.removeEventListener("abort", abort);

      if (!dispatched) release();
    }
  }
}
