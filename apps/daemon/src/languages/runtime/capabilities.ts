import {
  LanguageJson,
  LanguageProviderCapabilities,
  LanguageRegistration,
} from "@polaris/protocol";
import { Match, Schema } from "effect";

const Provider = Schema.Union([Schema.Boolean, Schema.JsonObject]);

const Sync = Schema.Struct({
  openClose: Schema.optionalKey(Schema.Boolean),
  change: Schema.optionalKey(Schema.Literals([0, 1, 2])),
  save: Schema.optionalKey(
    Schema.Union([
      Schema.Boolean,
      Schema.Struct({ includeText: Schema.optionalKey(Schema.Boolean) }),
    ])
  ),
});

export const InitializeResult = Schema.Struct({
  capabilities: Schema.Struct({
    positionEncoding: Schema.optionalKey(Schema.Literals(["utf-8", "utf-16", "utf-32"])),
    textDocumentSync: Schema.optionalKey(Schema.Union([Schema.Literals([0, 1, 2]), Sync])),
    completionProvider: Schema.optionalKey(
      Schema.Struct({ resolveProvider: Schema.optionalKey(Schema.Boolean) })
    ),
    hoverProvider: Schema.optionalKey(Provider),
    signatureHelpProvider: Schema.optionalKey(Provider),
    definitionProvider: Schema.optionalKey(Provider),
    declarationProvider: Schema.optionalKey(Provider),
    typeDefinitionProvider: Schema.optionalKey(Provider),
    implementationProvider: Schema.optionalKey(Provider),
    referencesProvider: Schema.optionalKey(Provider),
    renameProvider: Schema.optionalKey(Provider),
    codeActionProvider: Schema.optionalKey(Provider),
    documentSymbolProvider: Schema.optionalKey(Provider),
    workspaceSymbolProvider: Schema.optionalKey(Provider),
    documentFormattingProvider: Schema.optionalKey(Provider),
    documentRangeFormattingProvider: Schema.optionalKey(Provider),
    diagnosticProvider: Schema.optionalKey(
      Schema.Struct({ workspaceDiagnostics: Schema.optionalKey(Schema.Boolean) })
    ),
    executeCommandProvider: Schema.optionalKey(
      Schema.Struct({ commands: Schema.Array(Schema.String).check(Schema.isMaxLength(256)) })
    ),
  }),
});

export function negotiate(result: typeof LanguageJson.Type): LanguageProviderCapabilities {
  const c = Schema.decodeUnknownSync(InitializeResult)(result).capabilities;

  const providers = {
    "textDocument/hover": c.hoverProvider,
    "textDocument/signatureHelp": c.signatureHelpProvider,
    "textDocument/definition": c.definitionProvider,
    "textDocument/declaration": c.declarationProvider,
    "textDocument/typeDefinition": c.typeDefinitionProvider,
    "textDocument/implementation": c.implementationProvider,
    "textDocument/references": c.referencesProvider,
    "textDocument/rename": c.renameProvider,
    "textDocument/codeAction": c.codeActionProvider,
    "textDocument/documentSymbol": c.documentSymbolProvider,
    "workspace/symbol": c.workspaceSymbolProvider,
    "textDocument/formatting": c.documentFormattingProvider,
    "textDocument/rangeFormatting": c.documentRangeFormattingProvider,
  };

  const methods = Object.entries(providers)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([method]) => method);

  if (c.completionProvider !== undefined) methods.push("textDocument/completion");

  if (c.completionProvider?.resolveProvider) methods.push("completionItem/resolve");

  if (Schema.is(Schema.Struct({ prepareProvider: Schema.Literal(true) }))(c.renameProvider))
    methods.push("textDocument/prepareRename");

  if (Schema.is(Schema.Struct({ resolveProvider: Schema.Literal(true) }))(c.codeActionProvider))
    methods.push("codeAction/resolve");

  if (
    Schema.is(Schema.Struct({ resolveProvider: Schema.Literal(true) }))(c.workspaceSymbolProvider)
  )
    methods.push("workspaceSymbol/resolve");

  if (c.executeCommandProvider !== undefined) methods.push("workspace/executeCommand");

  if (c.diagnosticProvider !== undefined) methods.push("textDocument/diagnostic");

  if (c.diagnosticProvider?.workspaceDiagnostics) methods.push("workspace/diagnostic");
  const sync = c.textDocumentSync;
  const change = Schema.is(Sync)(sync) ? sync.change : sync;
  const save = Schema.is(Sync)(sync) ? sync.save : false;

  return LanguageProviderCapabilities.make({
    positionEncoding: c.positionEncoding ?? "utf-16",
    synchronization: (["none", "full", "incremental"] as const)[change ?? 0],
    openClose: Schema.is(Sync)(sync) ? sync.openClose === true : sync !== undefined && sync !== 0,
    save: save !== undefined && save !== false,
    saveIncludeText: Schema.is(Schema.Struct({ includeText: Schema.Literal(true) }))(save),
    methods,
    completionResolve: c.completionProvider?.resolveProvider === true,
    actionResolve: methods.includes("codeAction/resolve"),
    executeCommands: c.executeCommandProvider?.commands ?? [],
    diagnostics: c.diagnosticProvider === undefined ? "push" : "push-and-pull",
    workspaceDiagnostics: c.diagnosticProvider?.workspaceDiagnostics === true,
  });
}

export function registeredCapabilities(
  base: LanguageProviderCapabilities,
  registrations: readonly (typeof LanguageRegistration.Type)[]
) {
  const methods = new Set(base.methods);

  for (const registration of registrations)
    if (
      !["workspace/didChangeWorkspaceFolders", "workspace/didChangeConfiguration"].includes(
        registration.method
      )
    )
      methods.add(registration.method);

  return LanguageProviderCapabilities.make({ ...base, methods: [...methods].slice(0, 256) });
}

/** Enforce Python provider roles on the Host, including dynamic registrations. */
export function pythonCapabilities(base: LanguageProviderCapabilities, providerId: string) {
  const disabled: readonly string[] = Match.value(providerId).pipe(
    Match.when("basedpyright", () => ["textDocument/formatting", "textDocument/rangeFormatting"]),
    Match.when("ruff", () => [
      "textDocument/hover",
      "textDocument/completion",
      "completionItem/resolve",
    ]),
    Match.orElse(() => [])
  );

  return LanguageProviderCapabilities.make({
    ...base,
    methods: base.methods.filter((method) => !disabled.includes(method)),
    completionResolve: base.completionResolve && providerId !== "ruff",
  });
}
