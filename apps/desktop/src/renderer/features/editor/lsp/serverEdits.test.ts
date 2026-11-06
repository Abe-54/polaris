import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import * as P from "@polaris/protocol";
import { Schema } from "effect";
import { offerServerEdit, type ServerEditIntent } from "./serverEdits.ts";

const fixture = () => {
  const context = P.LanguageContextIdentity.make({
    hostId: P.HostId.make("fake"),
    clientId: "client",
    contextId: "context",
    providerId: "provider",
    projectRoot: "/fixture",
    generation: 1,
    configurationFingerprint: "a".repeat(64),
    checkout: P.LanguageCheckout.cases.Workspace.make({
      workspaceId: P.WorkspaceId.make("fixture"),
      path: "/fixture",
    }),
  });

  const uri = "file:///fixture/a.ts";

  const fence = P.LanguageRequestFence.make({
    context,
    requiredSequence: 1,
    documents: [{ uri, version: 1 }],
  });

  const proposal = P.LanguageTreeEditProposal.make({
    format: 2,
    proposalId: "server-tree",
    origin: "server-apply-edit",
    label: "Create file",
    fence,
    expiresAt: Date.now() + 5000,
    edit: { documentChanges: [{ kind: "create", uri: "file:///fixture/new.ts" }] },
    snapshots: [],
    resourceSnapshots: [
      { uri: "file:///fixture/new.ts", canonicalPath: "/fixture/new.ts", tree: null },
    ],
  });

  const received: P.LanguageTreeEditProposal[] = [];

  const intent: ServerEditIntent = {
    context,
    proposal,
    kind: "tree",
    treeNegotiated: true,
    providers: [
      {
        hostKey: "fake",
        context,
        ack: P.LanguageSyncAck.make({ context, acceptedSequence: 1, documents: fence.documents }),
        capabilities: P.LanguageProviderCapabilities.make({
          positionEncoding: "utf-16",
          synchronization: "full",
          openClose: true,
          save: false,
          saveIncludeText: false,
          methods: [],
          completionResolve: false,
          actionResolve: false,
          executeCommands: [],
          diagnostics: "none",
          workspaceDiagnostics: false,
        }),
      },
    ],
    buffers: [{ uri, version: 1, doc: EditorState.create({ doc: "unsaved😀" }).doc }],
    current: () => true,
    offer: (value) => {
      received.push(Schema.decodeUnknownSync(P.LanguageTreeEditProposal)(value));
    },
  };

  return { intent, received, proposal };
};

test("tree server intent preserves authoritative metadata and never reports automatic acceptance", async () => {
  const f = fixture();
  const result = await offerServerEdit(f.intent);
  expect(result.applied).toBe(false);
  expect(result.failureReason).toBe("Edits require user acceptance.");
  expect(f.received).toEqual([f.proposal]);
});

test("legacy, old peer, foreign provider, stale draft and user-origin server intents never offer", async () => {
  const f = fixture();

  const variants: ServerEditIntent[] = [
    { ...f.intent, kind: "legacy" },
    { ...f.intent, treeNegotiated: false },
    { ...f.intent, context: { ...f.intent.context, providerId: "foreign" } },
    { ...f.intent, buffers: f.intent.buffers.map((buffer) => ({ ...buffer, version: 2 })) },
    { ...f.intent, proposal: { ...f.proposal, origin: "rename" } },
    { ...f.intent, current: () => false },
    { ...f.intent, offer: null },
  ];

  for (const intent of variants) expect((await offerServerEdit(intent)).applied).toBe(false);
  expect(f.received).toEqual([]);
});

test("held or failed preview never returns success after context replacement", async () => {
  const f = fixture();

  let current = true;

  const result = await offerServerEdit({
    ...f.intent,
    current: () => current,
    offer: async () => {
      current = false;
    },
  });

  expect(result.failureReason).toBe("The originating language context changed.");

  const failed = await offerServerEdit({
    ...f.intent,
    offer: async () => {
      throw new Error("Preview unavailable");
    },
  });

  expect(failed.applied).toBe(false);
  expect(failed.failureReason).toContain("No edits were applied");
});
