import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LanguageCheckout,
  HostId,
  WorkspaceId,
  WorktreeId,
  ReviewCheckoutId,
} from "@polaris/protocol";
import { effectiveSettings } from "./configuration.ts";
import { checkoutKey, type CheckoutRegistry } from "../trust/index.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

export async function fixture() {
  const temporary = newTempDir("m31-d1-fixture-");
  const root = join(temporary, "workspace");
  const worktree = join(temporary, "worktree");
  const review = join(temporary, "review");
  await Promise.all([root, worktree, review].map((path) => mkdir(path)));
  const hostId = HostId.make("fake-host");
  const workspaceId = WorkspaceId.make("fake-workspace");
  const checkout = LanguageCheckout.cases.Workspace.make({ workspaceId, path: root });

  const treeCheckout = LanguageCheckout.cases.Worktree.make({
    workspaceId,
    worktreeId: WorktreeId.make("fake-tree"),
    path: worktree,
  });

  const reviewCheckout = LanguageCheckout.cases.ReviewCheckout.make({
    workspaceId,
    reviewCheckoutId: ReviewCheckoutId.make("fake-review"),
    path: review,
  });

  const registrations = new Map(
    [checkout, treeCheckout, reviewCheckout].map((value) => [
      checkoutKey(value),
      { checkout: value, workspacePath: root },
    ])
  );

  const registry: CheckoutRegistry = async (value) => {
    const registration = registrations.get(checkoutKey(value));

    if (registration === undefined) throw new Error("Not registered");

    return registration;
  };

  async function put(path: string, text = "") {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);

    return full;
  }

  return {
    temporary,
    root,
    worktree,
    review,
    hostId,
    workspaceId,
    checkout,
    treeCheckout,
    reviewCheckout,
    registry,
    registrations,
    put,
    settings: effectiveSettings({ hostId, workspaceId, language: "typescript" }, [], 0),
    cleanup: () => removeTempDirSettled(temporary),
  };
}
