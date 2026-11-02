import { expect, test } from "bun:test";
import {
  constellationRef,
  exportBundle,
  importBundle,
  pushOrigin,
  fetchOrigin,
} from "./constellationBundles.ts";
import { gitText, resolveCommit } from "./git.ts";
import { commitAll, makeRepo, removeDir, write } from "./testing.ts";

test("a self-contained base and a later Claim transfer exactly, leaving user branches unchanged", async () => {
  const owner = await makeRepo();
  const worker = await makeRepo({});

  try {
    const head = await exportBundle(owner, "HEAD");
    await importBundle({ ...head, repoPath: worker, targetRef: constellationRef("graph", null) });
    expect(await resolveCommit(worker, constellationRef("graph", null))).toBe(head.head);
    expect(await resolveCommit(worker, "HEAD")).toBeNull();
    await gitText(worker, ["checkout", "-b", "polaris/task", head.head]);
    write(worker, "task.txt", "worker change");
    const claimed = await commitAll(worker, "claim");
    const bundle = await exportBundle(worker, claimed);
    await importBundle({
      ...bundle,
      repoPath: owner,
      targetRef: constellationRef("graph", "attempt"),
    });
    expect(await resolveCommit(owner, constellationRef("graph", "attempt"))).toBe(claimed);
    expect(await resolveCommit(owner, "HEAD")).toBe(head.head);
    expect(await gitText(owner, ["branch", "--format=%(refname:short)"])).toBe("main");
    await Promise.resolve(
      expect(
        importBundle({
          ...bundle,
          head: head.head,
          repoPath: owner,
          targetRef: constellationRef("graph", "wrong"),
        })
      ).rejects.toThrow("expected commit")
    );
    expect(await resolveCommit(owner, constellationRef("graph", "wrong"))).toBeNull();
  } finally {
    removeDir(owner);
    removeDir(worker);
  }
});

test("origin transfer is restricted to the selected prefix and verifies the advertised head", async () => {
  const source = await makeRepo();
  const origin = await makeRepo({});
  const target = await makeRepo({});

  try {
    await gitText(origin, ["config", "core.bare", "true"]);
    await gitText(source, ["remote", "add", "origin", origin]);
    await gitText(target, ["remote", "add", "origin", origin]);
    const head = (await exportBundle(source, "HEAD")).head;
    await gitText(source, ["branch", "polaris/graph/claim", head]);
    await pushOrigin(source, "polaris/graph/claim", head, "polaris");
    await fetchOrigin(target, "polaris/graph/claim", head, constellationRef("g", "a"));
    expect(await resolveCommit(target, constellationRef("g", "a"))).toBe(head);
    await Promise.resolve(
      expect(pushOrigin(source, "main", head, "polaris")).rejects.toThrow("prefix")
    );
    await Promise.resolve(
      expect(
        fetchOrigin(target, "polaris/graph/claim", "bad", constellationRef("g", "b"))
      ).rejects.toThrow("Claim head")
    );
    expect(await resolveCommit(target, constellationRef("g", "b"))).toBeNull();
  } finally {
    removeDir(source);
    removeDir(origin);
    removeDir(target);
  }
});
