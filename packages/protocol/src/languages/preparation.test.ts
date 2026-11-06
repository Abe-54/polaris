import { expect, test } from "bun:test";
import { Schema } from "effect";
import { HostId, WorkspaceId } from "../ids.ts";
import { LanguageCheckout } from "./base.ts";
import { languageRpcAllowed } from "./capabilities.ts";
import { LanguageTreeEditProposal } from "./trees.ts";
import { LanguageEditProposal } from "./edits.ts";
import { LanguagePreparedEditProposal } from "./preparation.ts";
import { PrepareLanguageEdit } from "./rpc.ts";

const fence = {
  context: {
    hostId: HostId.make("fake-host"),
    clientId: "client",
    checkout: LanguageCheckout.cases.Workspace.make({
      workspaceId: WorkspaceId.make("workspace"),
      path: "/checkout",
    }),
    contextId: "context",
    providerId: "provider",
    projectRoot: "/checkout",
    generation: 1,
    configurationFingerprint: "a".repeat(64),
  },
  requiredSequence: 1,
  documents: [{ uri: "file:///checkout/a", version: 3 }],
};

const text = LanguageEditProposal.make({
  proposalId: "proposal",
  fence,
  origin: "rename",
  label: "Rename",
  edit: { documentChanges: [] },
  snapshots: [],
  expiresAt: 1000,
});

const tree = LanguageTreeEditProposal.make({
  ...text,
  format: 2,
  resourceSnapshots: [{ uri: "file:///checkout/new", canonicalPath: "/checkout/new", tree: null }],
});

test("prepared tree snapshots survive protocol success roundtrip without legacy erasure", () => {
  const schema = PrepareLanguageEdit.successSchema;
  const result = Schema.decodeUnknownSync(schema)(tree);

  expect(result).toEqual(tree);
  expect(Schema.decodeUnknownSync(schema)(Schema.encodeSync(schema)(result))).toEqual(tree);
  expect(Schema.decodeUnknownSync(schema)(text)).toEqual(text);
});

test("unknown or missing tree format and versionless legacy resources fail before consumer", () => {
  for (const input of [
    { ...tree, format: 3 },
    { ...text, resourceSnapshots: tree.resourceSnapshots },
    { ...tree, resourceSnapshots: undefined },
    { ...text, edit: { documentChanges: [{ kind: "create", uri: "file:///checkout/new" }] } },
  ])
    expect(() => Schema.decodeUnknownSync(LanguagePreparedEditProposal)(input)).toThrow();
});

test("old peers and partial capabilities cannot invoke new preparation or acknowledgment methods", () => {
  expect(languageRpcAllowed("languages.edit.prepare", ["languages", "languages.edits"])).toBe(
    false
  );
  expect(languageRpcAllowed("languages.document.acknowledge", ["languages"])).toBe(false);
  expect(languageRpcAllowed("languages.edit.prepare", ["languages.edit-preparation"])).toBe(false);
  expect(
    languageRpcAllowed("languages.edit.prepare", ["languages", "languages.edit-preparation"])
  ).toBe(true);
  expect(
    languageRpcAllowed("languages.document.acknowledge", [
      "languages",
      "languages.buffer-acknowledgments",
    ])
  ).toBe(true);
});
