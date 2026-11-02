import { tempDir } from "../../platform/tempDir.testing.ts";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  HostId,
  LanguageCheckout,
  WorkspaceId,
  LanguageEditProposal,
  LanguageEditAcceptance,
} from "@polaris/protocol";
import { Schema } from "effect";
import { currentVersion } from "../version.ts";
import { createFileEditCoordinator, type Owner, type CoordinatorOptions } from "./index.ts";
import type { Fault } from "./moves.ts";

export const fixture = async () => {
  const home = await realpath(tempDir("m31-x1-"));
  const root = join(home, "checkout");
  await mkdir(root);
  await writeFile(join(root, "a"), "alpha\r\n");
  await writeFile(join(root, "b"), "beta");

  const owner: Owner = {
    hostId: HostId.make("fake-host"),
    clientId: "client",
    checkout: LanguageCheckout.cases.Workspace.make({
      workspaceId: WorkspaceId.make("fake-workspace"),
      path: root,
    }),
  };

  const uri = (name: string) => pathToFileURL(join(root, name)).href;

  const coordinator = (fault?: Fault) => {
    const options: CoordinatorOptions = {
      journalRoot: join(home, "journal"),
      authorize: async () => {},
    };

    return createFileEditCoordinator(fault ? { ...options, fault } : options);
  };

  const request = async (operations: unknown[], names = ["a", "b", "c"]) => {
    const proposal = Schema.decodeUnknownSync(LanguageEditProposal)({
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
      snapshots: await Promise.all(
        names.map(async (name) => ({
          uri: uri(name),
          canonicalPath: join(root, name),
          diskVersion: await currentVersion(join(root, name)),
          diskText: null,
          buffer: null,
        }))
      ),
    });

    const acceptance = Schema.decodeUnknownSync(LanguageEditAcceptance)({
      proposalId: proposal.proposalId,
      operationId: "operation",
      fence: proposal.fence,
      snapshots: proposal.snapshots,
      decision: "accept",
    });

    return { proposal, acceptance, drafts: { durable: true, groupId: "draft-group" } };
  };

  return {
    home,
    root,
    owner,
    uri,
    coordinator,
    request,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
};
