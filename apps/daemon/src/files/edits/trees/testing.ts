import { tempDir } from "../../../platform/tempDir.testing.ts";
import { expect } from "bun:test";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LanguageTreeEditProposal,
  LanguageTreeEditAcceptance,
  LanguageTreeDraftReceipt,
} from "@polaris/protocol";
import { Schema } from "effect";
import { fixture as fileFixture } from "../testing.ts";
import { fingerprint } from "../journal.ts";
import { createTreeEditCoordinator, snapshotTree, type CoordinatorOptions } from "./index.ts";

export const fixture = async () => {
  const home = await realpath(tempDir("m31-x2-"));
  const root = join(home, "checkout");
  await mkdir(join(root, "source", "nested"), { recursive: true });
  await writeFile(join(root, "source", "nested", "file"), "alpha\r\n");
  await writeFile(join(root, "source", "unicode-λ"), "beta");
  await mkdir(join(root, "target"));
  await writeFile(join(root, "target", "original"), "overwritten");
  const regular = await fileFixture();
  const { owner: originalOwner } = regular;
  await regular.cleanup();
  const owner = { ...originalOwner, checkout: { ...originalOwner.checkout, path: root } };
  const uri = (name: string) => pathToFileURL(join(root, name)).href;

  const coordinator = (options: Partial<CoordinatorOptions> = {}) =>
    createTreeEditCoordinator({
      journalRoot: join(home, "journal"),
      authorize: async () => {},
      authorizeRecovery: async () => {},
      ...options,
    });

  const request = async (operations: unknown[], names = ["source", "target", "final"]) => {
    const proposal = Schema.decodeUnknownSync(LanguageTreeEditProposal)({
      format: 2,
      proposalId: "proposal",
      origin: "rename",
      label: "Fixture",
      expiresAt: Date.now() + 60000,
      fence: {
        context: {
          hostId: owner.hostId,
          clientId: owner.clientId,
          checkout: owner.checkout,
          contextId: "context",
          providerId: "provider",
          projectRoot: root,
          generation: 1,
          configurationFingerprint: "a".repeat(64),
        },
        requiredSequence: 0,
        documents: [],
      },
      edit: { documentChanges: operations },
      snapshots: [],
      resourceSnapshots: await Promise.all(
        names.map(async (name) => ({
          uri: uri(name),
          canonicalPath: join(root, name),
          tree: await snapshotTree(root, join(root, name)),
        }))
      ),
    });

    const acceptance = Schema.decodeUnknownSync(LanguageTreeEditAcceptance)({
      format: 2,
      proposalId: proposal.proposalId,
      operationId: "operation",
      fence: proposal.fence,
      snapshots: proposal.snapshots,
      resourceSnapshots: proposal.resourceSnapshots,
      decision: "accept",
    });

    const drafts = Schema.decodeUnknownSync(LanguageTreeDraftReceipt)({
      format: 2,
      durable: true,
      groupId: "draft-group",
      previewFingerprint: fingerprint(proposal),
      resourceSnapshots: proposal.resourceSnapshots,
      descendants: [],
    });

    return { proposal, acceptance, drafts };
  };

  const chain = () => [
    { kind: "rename", oldUri: uri("source"), newUri: uri("target"), options: { overwrite: true } },
    { kind: "rename", oldUri: uri("target"), newUri: uri("final") },
    { kind: "delete", uri: uri("final"), options: { recursive: true } },
  ];

  return {
    home,
    root,
    owner,
    uri,
    coordinator,
    request,
    chain,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
};

export const expectFailure = async <A>(promise: Promise<A>, message: string) => {
  const result = await promise.catch((cause: unknown) => cause);
  expect(result).toBeInstanceOf(Error);
  expect(String(result)).toContain(message);
};
