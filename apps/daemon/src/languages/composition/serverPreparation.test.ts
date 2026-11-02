import { expect } from "bun:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as P from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { Documents } from "../runtime/documents.ts";
import { createProjectDiscovery } from "../discovery/index.ts";
import type { ServerPreparationAccess } from "../runtime/serverPreparation.ts";
import type { ExecutionTrustService } from "../trust/index.ts";
import { LanguageAcquisitionAuthority } from "./acquisitionAuthority.ts";
import { HostProposalEvidence } from "../preparation/provenance.ts";
import { ProposalProvenance } from "../preparation/provenanceService.ts";
import { prepareServerEdit } from "./serverPreparation.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const treeSnapshotTest = posixTest(
  "Windows bug: NTFS file IDs exceed a safe integer for LanguageResourceIdentity.inode in tree snapshots (ENG-296)"
);

treeSnapshotTest(
  "server preparation reads canonical closed snapshots and rejects replaced independent ownership",
  async () => {
    const root = newTempDir("m31-server-preparation-", { short: true });

    try {
      const path = join(root, "file.ts");

      const uri = pathToFileURL(path).href;

      await writeFile(path, "original");

      const context = P.LanguageContextIdentity.make({
        hostId: P.HostId.make("fake-host"),
        clientId: "fake-client",
        contextId: "fake-context",
        checkout: P.LanguageCheckout.cases.Workspace.make({
          workspaceId: P.WorkspaceId.make("fake-workspace"),
          path: root,
        }),
        projectRoot: root,
        providerId: "fake-provider",
        generation: 1,
        configurationFingerprint: "a".repeat(64),
      });

      const principal = P.LanguageConnectionIdentity.make({
        hostId: context.hostId,
        clientId: context.clientId,
      });

      let live = true;
      let treeAllowed = false;

      const owners = await Effect.runPromise(
        LanguageAcquisitionAuthority.pipe(Effect.provide(LanguageAcquisitionAuthority.layer))
      );

      const canonical = { checkout: context.checkout, root, workspaceRoot: root };

      owners.capture({
        principal,
        check: Effect.void,
        lost: () => !live,
        coordinates: () => Effect.void,
        checkout: () => Effect.succeed(canonical),
        supports: () => treeAllowed,
      });

      const trust: ExecutionTrustService["Service"] = {
        change: () => Effect.die("Not used"),
        claimAsk: () => false,
        require: () => Effect.succeed(canonical),
        inspect: () => Effect.die("unused"),
        set: () => Effect.die("unused"),
        execute: () => Effect.die("unused"),
      };

      const documents = new Documents(context);

      const signal = new AbortController().signal;

      const access: ServerPreparationAccess = {
        request: {
          context,
          signal,
          isCurrent: () => live,
          facts: await createProjectDiscovery({
            registry: async () => ({ checkout: context.checkout, workspacePath: root }),
          }).discover({
            checkout: context.checkout,
            path,
            providerId: context.providerId,
            settings: P.LanguageEffectiveSettings.make({
              revision: 0,
              settings: {},
              formatOnSave: true,
              formatter: P.LanguageFormatterSelection.cases.None.make({}),
              providers: [],
              origins: {},
            }),
          }),
        },
        encoding: () => "utf-16",
        fence: (fence) => documents.fence(fence),
        document: () => null,
        acknowledgment: () => {
          throw new Error("Closed mirror has no acknowledgment");
        },
      };

      const edit = P.LanguageWorkspaceEdit.make({
        changes: {
          [uri]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
              newText: "changed",
            },
          ],
        },
      });

      const proposal = P.LanguageEditProposal.make({
        proposalId: "host-delivery",
        fence: { context, requiredSequence: 0, documents: [] },
        origin: "server-apply-edit",
        label: "Server edit",
        edit,
        snapshots: [],
        expiresAt: Date.now() + 10000,
      });

      const evidence = new HostProposalEvidence();

      const provenance = ProposalProvenance.of({
        record: (owner, value, validate) =>
          Effect.promise(() => evidence.record(owner, value, validate)),
        verify: (owner, value) => Effect.promise(() => evidence.verify(owner, value)),
        revoke: (owner) => Effect.sync(() => evidence.revoke(owner)),
      });

      const prepare = prepareServerEdit(owners, trust, provenance);

      const result = await prepare(edit, proposal, access);
      await evidence.verify(principal, result);
      await assert.rejects(evidence.verify({ ...principal }, result));
      expect(result.proposalId).toBe(proposal.proposalId);
      expect(result.fence).toEqual(proposal.fence);
      expect(result.snapshots[0]?.diskText).toBe("original");
      expect(result.snapshots[0]?.buffer).toBeNull();
      expect(await Bun.file(path).text()).toBe("original");

      treeAllowed = true;

      const deletion = P.LanguageWorkspaceEdit.make({ documentChanges: [{ kind: "delete", uri }] });

      const tree = await prepare(
        deletion,
        P.LanguageEditProposal.make({
          ...proposal,
          proposalId: "host-tree-delivery",
          edit: deletion,
        }),
        access
      );

      if (!Schema.is(P.LanguageTreeEditProposal)(tree)) throw new Error("Tree snapshots missing");
      expect(tree.resourceSnapshots[0]?.canonicalPath).toBe(path);
      expect(tree.resourceSnapshots[0]?.tree?.entries[0]?.version?.hash).toHaveLength(64);
      expect(tree.edit.documentChanges).toEqual(deletion.documentChanges);
      expect(await Bun.file(path).text()).toBe("original");

      treeAllowed = false;
      await assert.rejects(evidence.verify(principal, tree));
      treeAllowed = true;

      owners.beginTrustChange(
        P.LanguageTrustScope.cases.Workspace.make({
          hostId: context.hostId,
          workspaceId: context.checkout.workspaceId,
        })
      )();
      await assert.rejects(evidence.verify(principal, tree));
      live = false;
      await assert.rejects(prepare(edit, proposal, access));
      evidence.dispose();
    } finally {
      await removeTempDirSettled(root);
    }
  }
);
