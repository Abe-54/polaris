import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { WorkspaceId, WorktreeId, HostId } from "../ids.ts";
import {
  LanguageRequestInputs,
  LanguageRequestOutputs,
  LanguageSubscriptionInputs,
} from "../../../../apps/desktop/src/shared/languages.ts";
import {
  LANGUAGE_RPC_CAPABILITIES,
  LanguageRpcs,
  languageRpcAllowed,
  LanguageCheckout,
  LanguageFormatterSelection,
  LanguageCatalog,
  LanguageDeveloperCompanion,
  LanguageContextIdentity,
  LanguageDiagnostics,
  LanguageDocumentNotification,
  LanguageFormatPreflight,
  LanguageJson,
  LanguageJsonRpcEnvelope,
  LanguageOperationOutcome,
  LanguagePreviewPolicy,
  LanguageRange,
  LanguageRequestFence,
  LanguageSettingsPatch,
  LanguageSettingsScope,
  LanguageSyncAck,
  LanguageWorkspaceEdit,
  languageFenceSatisfied,
} from "./index.ts";

const decodeContext = Schema.decodeUnknownSync(LanguageContextIdentity);

const context = decodeContext({
  hostId: "fake-host",
  clientId: "client-a",
  contextId: "context-a",
  checkout: LanguageCheckout.cases.Worktree.make({
    workspaceId: WorkspaceId.make("workspace"),
    worktreeId: WorktreeId.make("tree-a"),
    path: "/tmp/fake/tree-a",
  }),
  projectRoot: "/tmp/fake/tree-a/project",
  providerId: "pyright",
  configurationFingerprint: "a".repeat(64),
  generation: 1,
});

const uri = "file:///tmp/fake/tree-a/project/main.py";

const fence = Schema.decodeUnknownSync(LanguageRequestFence)({
  context,
  requiredSequence: 2,
  documents: [{ uri, version: 3 }],
});

const ack = Schema.decodeUnknownSync(LanguageSyncAck)({
  context,
  acceptedSequence: 2,
  documents: [{ uri, version: 3 }],
});

const diskVersion = { mtimeMs: 10, size: 4, hash: "b".repeat(64) };

test("developer companion metadata round trips without becoming managed approval", () => {
  const metadata: typeof LanguageDeveloperCompanion.Type = {
    id: "shellcheck",
    executable: "shellcheck",
    version: ">=0.11.0",
    provider: "bash-language-server",
    capability: "shellcheck-diagnostics",
    setting: "bashIde.shellcheckPath",
    source: "developer",
    missingDetail: "Configure an existing executable to enable diagnostics.",
  };

  const decoded = Schema.decodeUnknownSync(LanguageDeveloperCompanion)(metadata);

  expect(Schema.encodeSync(LanguageDeveloperCompanion)(decoded)).toEqual(metadata);
  expect(() =>
    Schema.decodeUnknownSync(LanguageDeveloperCompanion)({ ...metadata, source: "managed" })
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(LanguageDeveloperCompanion)({ ...metadata, executable: "" })
  ).toThrow();
});

test("current catalog descriptors decode without changing tool/provider/formatter IDs", () => {
  const raw: unknown = JSON.parse(
    readFileSync(
      new URL("../../../../apps/daemon/src/languages/catalog/catalog.json", import.meta.url),
      "utf8"
    )
  );

  const catalog = Schema.decodeUnknownSync(LanguageCatalog)(raw);

  expect<unknown>(catalog).toEqual(raw);

  for (const ids of [catalog.tools.map((t) => t.id), catalog.integrations.map((i) => i.id)])
    expect(new Set(ids).size).toBe(ids.length);
  expect(catalog.tools.find((tool) => tool.id === "shellcheck")?.disposition).toBe("offered");

  expect(catalog.tools.find((tool) => tool.id === "sql-language-server")?.disposition).toBe(
    "evaluation"
  );

  for (const integration of catalog.integrations) {
    for (const provider of integration.providers)
      expect(catalog.tools.find((tool) => tool.id === provider.tool)?.disposition).toBe("offered");
  }
});

test("an association names a syntax ID, never an LSP document ID", () => {
  const accepts = (language: string) =>
    Schema.is(LanguageSettingsPatch)({ associations: [{ language, filenames: [".env.local"] }] });

  expect(accepts("dotenv")).toBe(true);
  expect(accepts("shellscript")).toBe(false);
});

test("every extension RPC has a gate and old peers cannot invoke language operations", () => {
  expect([...LanguageRpcs.requests.keys()].sort()).toEqual(
    Object.keys(LANGUAGE_RPC_CAPABILITIES).sort()
  );
  expect(languageRpcAllowed("languages.request", ["files.read"])).toBe(false);
  expect(languageRpcAllowed("languages.format", ["languages"])).toBe(false);
  expect(languageRpcAllowed("languages.format", ["languages", "languages.format"])).toBe(true);
  expect(languageRpcAllowed("languages.preview.media", ["languages.preview-media"])).toBe(true);
});

test("JSON-RPC validates bidirectional IDs, params and exclusive responses", () => {
  const valid = [
    { jsonrpc: "2.0", id: 1, method: "workspace/configuration", params: { items: [] } },
    { jsonrpc: "2.0", id: "server/request:1", method: "workspace/applyEdit", params: { edit: {} } },
    { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } },
    { jsonrpc: "2.0", id: 1, result: null },
    { jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method not found" } },
  ];

  for (const message of valid) expect(Schema.is(LanguageJsonRpcEnvelope)(message)).toBe(true);

  const invalid = [
    { jsonrpc: "1.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: 1.5, method: "initialize" },
    { jsonrpc: "2.0", id: 1, method: "initialize", params: "scalar" },
    { jsonrpc: "2.0", id: 1, result: null, error: { code: 1, message: "ambiguous" } },
    { jsonrpc: "2.0", id: 1 },
    { jsonrpc: "2.0", id: 1, result: undefined },
    { jsonrpc: "2.0", method: "initialize", result: null },
  ];

  for (const message of invalid) expect(Schema.is(LanguageJsonRpcEnvelope)(message)).toBe(false);

  expect(Schema.is(LanguageJson)({ value: Infinity })).toBe(false);

  expect(Schema.is(LanguageJson)({ text: "x".repeat(1048577) })).toBe(false);
});

test("request fences bind every context identity component and exact buffer version", () => {
  expect(languageFenceSatisfied(fence, ack)).toBe(true);

  const altered = [
    { generation: 2 },
    { clientId: "client-b" },
    { hostId: "other-host" },
    { contextId: "other-context" },
    { providerId: "ruff" },
    { projectRoot: "/tmp/fake/other" },
    { configurationFingerprint: "c".repeat(64) },
    { checkout: { ...context.checkout, path: "/tmp/fake/tree-b" } },
    { checkout: { ...context.checkout, worktreeId: "tree-b" } },
  ];

  for (const patch of altered)
    expect(
      languageFenceSatisfied(fence, { ...ack, context: decodeContext({ ...context, ...patch }) })
    ).toBe(false);

  expect(languageFenceSatisfied(fence, { ...ack, acceptedSequence: 1 })).toBe(false);

  expect(languageFenceSatisfied(fence, { ...ack, documents: [{ uri, version: 4 }] })).toBe(false);

  expect(languageFenceSatisfied(fence, { ...ack, documents: [] })).toBe(false);
});

test("ordered change versions and ranges reject malformed input before queuing", () => {
  const change = LanguageDocumentNotification.cases.Change.make({
    uri,
    previousVersion: 2,
    version: 3,
    changes: [{ text: "unsaved" }],
  });

  expect(Schema.is(LanguageDocumentNotification)(change)).toBe(true);

  expect(Schema.is(LanguageDocumentNotification)({ ...change, version: 2 })).toBe(false);

  expect(Schema.is(LanguageDocumentNotification)({ ...change, version: -1 })).toBe(false);

  expect(
    Schema.is(LanguageRange)({ start: { line: 1, character: 2 }, end: { line: 1, character: 1 } })
  ).toBe(false);

  expect(
    Schema.is(LanguageRange)({ start: { line: 0, character: 0 }, end: { line: 0, character: 2 } })
  ).toBe(true);
});

test("diagnostic sets are provider-owned and unversioned data cannot claim freshness", () => {
  const diagnostic = {
    context,
    uri,
    providerId: "pyright",
    generation: 1,
    version: null,
    freshness: "unversioned",
    kind: "full",
    resultId: null,
    previousResultId: null,
    items: [],
    truncated: false,
  };

  expect(Schema.is(LanguageDiagnostics)(diagnostic)).toBe(true);

  expect(Schema.is(LanguageDiagnostics)({ ...diagnostic, freshness: "versioned" })).toBe(false);

  expect(Schema.is(LanguageDiagnostics)({ ...diagnostic, providerId: "ruff" })).toBe(false);

  expect(Schema.is(LanguageDiagnostics)({ ...diagnostic, generation: 2 })).toBe(false);

  expect(Schema.is(LanguageDiagnostics)({ ...diagnostic, kind: "unchanged" })).toBe(false);
});

test("workspace edits retain both forms, null versions, annotations and ordered resource operations", () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

  const edit = {
    changes: { [uri]: [{ range, newText: "new", annotationId: "group" }] },
    documentChanges: [
      { kind: "create", uri: "file:///tmp/fake/new.py", options: { overwrite: false } },
      { textDocument: { uri, version: null }, edits: [{ range, newText: "new" }] },
      {
        kind: "rename",
        oldUri: uri,
        newUri: "file:///tmp/fake/renamed.py",
        options: { ignoreIfExists: true },
      },
      {
        kind: "delete",
        uri: "file:///tmp/fake/new.py",
        options: { recursive: false, ignoreIfNotExists: true },
      },
    ],
    changeAnnotations: { group: { label: "Rename", needsConfirmation: true } },
  };

  expect(JSON.stringify(Schema.decodeUnknownSync(LanguageWorkspaceEdit)(edit))).toBe(
    JSON.stringify(edit)
  );
});

test("resource operation applied success requires durable drafts and receipt", () => {
  const result = {
    operationId: "operation",
    proposalId: "proposal",
    owner: { hostId: context.hostId, clientId: context.clientId, checkout: context.checkout },
    state: "applied",
    draftsDurable: true,
    receiptDurable: true,
    receiptRevision: 1,
    draftGroupId: "group",
    steps: [],
    failedChange: null,
    message: "",
  };

  expect(Schema.is(LanguageOperationOutcome)(result)).toBe(true);

  expect(Schema.is(LanguageOperationOutcome)({ ...result, draftsDurable: false })).toBe(false);

  expect(Schema.is(LanguageOperationOutcome)({ ...result, receiptDurable: false })).toBe(false);

  expect(
    Schema.is(LanguageOperationOutcome)({
      ...result,
      state: "recovery-required",
      receiptDurable: false,
    })
  ).toBe(true);
});

test("formatting preflight requires exact document fence and a valid disk version", () => {
  const input = {
    requestId: "format",
    fence,
    document: { uri, version: 3 },
    snapshot: "text",
    expectedDiskVersion: diskVersion,
    formatter: LanguageFormatterSelection.cases.Provider.make({ providerId: "ruff" }),
    options: { tabSize: 2, insertSpaces: true },
    reason: "quit",
    deadline: 100,
  };

  expect(() => Schema.decodeUnknownSync(LanguageFormatPreflight)(input)).not.toThrow();

  expect(() =>
    Schema.decodeUnknownSync(LanguageFormatPreflight)({ ...input, document: { uri, version: 4 } })
  ).toThrow();

  expect(() =>
    Schema.decodeUnknownSync(LanguageFormatPreflight)({
      ...input,
      expectedDiskVersion: { ...diskVersion, hash: "bad" },
    })
  ).toThrow();
});

test("Settings/trust and sanitized preview are scoped; arbitrary script policies are rejected", () => {
  expect(
    Schema.is(LanguageSettingsScope)(
      LanguageSettingsScope.cases.Workspace.make({
        hostId: HostId.make("fake-host"),
        workspaceId: WorkspaceId.make("workspace"),
        language: "python",
      })
    )
  ).toBe(true);

  const policy = {
    hostId: "fake-host",
    workspaceId: "workspace",
    externalImages: "ask",
    scripts: "disabled",
    html: "sanitized",
    mermaid: "strict",
    maxMediaBytes: 10485760,
  };

  expect(Schema.is(LanguagePreviewPolicy)(policy)).toBe(true);

  expect(Schema.is(LanguagePreviewPolicy)({ ...policy, scripts: "enabled" })).toBe(false);

  expect(Schema.is(LanguagePreviewPolicy)({ ...policy, maxMediaBytes: 10485761 })).toBe(false);
});

test("IPC input and output tables cover every opt-in request and validate Host routing", () => {
  expect(Object.keys(LanguageRequestInputs)).toEqual(Object.keys(LanguageRequestOutputs));

  expect(
    Schema.is(LanguageRequestInputs["languages.document.sync"])({
      hostKey: "fake-host",
      context,
      sequence: 3,
      notification: LanguageDocumentNotification.cases.Close.make({ uri, version: 3 }),
    })
  ).toBe(true);

  expect(
    Schema.is(LanguageRequestInputs["languages.document.sync"])({
      context,
      sequence: 3,
      notification: LanguageDocumentNotification.cases.Close.make({ uri, version: 3 }),
    })
  ).toBe(false);

  expect(Object.keys(LanguageSubscriptionInputs)).toEqual([
    "languages.host.state.watch",
    "languages.log.watch",
    "languages.context.watch",
    "languages.install.watch",
    "languages.availability.watch",
  ]);
});

test("preview IPC rejects executable URLs, credentials and oversized fetch requests", () => {
  const input = {
    hostKey: "fake-host",
    workspaceId: "workspace",
    url: "https://example.test/image.png",
    maxBytes: 100,
  };

  expect(Schema.is(LanguageRequestInputs["languages.preview.external"])(input)).toBe(true);

  for (const url of [
    "file:///tmp/image.png",
    "javascript:alert(1)",
    "https://user:secret@example.test/image.png",
  ]) {
    expect(Schema.is(LanguageRequestInputs["languages.preview.external"])({ ...input, url })).toBe(
      false
    );
  }

  expect(
    Schema.is(LanguageRequestInputs["languages.preview.external"])({ ...input, maxBytes: 10485761 })
  ).toBe(false);
});
