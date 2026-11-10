import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { SessionId, TurnId } from "@polaris/protocol";
import { checkpointRef } from "./Checkpoints.ts";
import { computeDiff, DiffNotFound, DiffSpec } from "./diff.ts";
import { indexDiff, unquotePath } from "./diffIndex.ts";
import { gitText } from "./git.ts";
import { showFile } from "./show.ts";
import { commitAll, makeRepo, removeTempDir, write } from "./testing.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const text = new TextDecoder();

describe("the diff index", () => {
  test("each file's byte range slices the patch exactly, with its status and counts", async () => {
    const root = await makeRepo({
      "keep.ts": "one\ntwo\nthree\n",
      "gone.ts": "bye\n",
      "old name.ts": "a\nb\nc\nd\ne\nf\n",
      "tool.sh": "echo\n",
    });

    cleanup.push(root);
    const base = await gitText(root, ["rev-parse", "HEAD"]);

    write(root, "keep.ts", "one\n2\nthree\nfour\n");
    write(root, "new.ts", "fresh\n");
    write(root, "logo.png", "\u0000\u0001binary");
    await gitText(root, ["rm", "-q", "gone.ts"]);
    await gitText(root, ["mv", "old name.ts", "new name.ts"]);
    chmodSync(join(root, "tool.sh"), 0o755);
    // Git for Windows has no file mode to read (core.fileMode off): set the index's.
    await gitText(root, ["update-index", "--chmod=+x", "tool.sh"]);
    const head = await commitAll(root, "change");

    const diff = await computeDiff(root, DiffSpec.cases.Range.make({ base, head }));
    const index = indexDiff(diff.bytes);

    expect(index.length).toBe(diff.files);
    expect(
      index.map((f) => [f.path, f.oldPath, f.status, f.additions, f.deletions, f.binary])
    ).toEqual([
      ["gone.ts", null, "deleted", 0, 1, false],
      ["keep.ts", null, "modified", 2, 1, false],
      ["logo.png", null, "added", 0, 0, true],
      ["new name.ts", "old name.ts", "renamed", 0, 0, false],
      ["new.ts", null, "added", 1, 0, false],
      ["tool.sh", null, "mode-changed", 0, 0, false],
    ]);

    // The ranges tile the patch: each starts at its `diff --git` line and ends at the next.
    let at = 0;

    for (const file of index) {
      expect(file.offset).toBe(at);
      expect(text.decode(diff.bytes.subarray(file.offset, file.offset + 11))).toBe("diff --git ");
      at = file.offset + file.length;
    }

    expect(at).toBe(diff.bytes.length);
  });

  test("a line that reads like a file's header inside a hunk isn't one", () => {
    const patch = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,2 +1,2 @@",
      " intro",
      "-diff --git a/old b/old",
      "+diff --git a/fake b/fake",
      "diff --git a/other.md b/other.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/other.md",
      "@@ -0,0 +1 @@",
      "+diff --git a/x b/x",
      "",
    ].join("\n");

    const index = indexDiff(new TextEncoder().encode(patch));

    expect(index.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ["notes.md", "modified", 1, 1],
      ["other.md", "added", 1, 0],
    ]);
  });

  test("a patch cut inside a header's first word ends at the file before it", () => {
    const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git";
    const index = indexDiff(new TextEncoder().encode(patch));

    expect(index.map((file) => [file.path, file.length])).toEqual([["a", patch.length]]);
  });

  test("an empty patch has no files; quoted paths are unquoted", () => {
    expect(indexDiff(new Uint8Array())).toEqual([]);
    expect(unquotePath('"caf\\303\\251\\tx"')).toBe("café\tx");
    expect(unquotePath("plain.ts")).toBe("plain.ts");
  });
});

describe("Turns diffs and files at a revision", () => {
  test("a run of Turns spans the first one's before to the last one's after", async () => {
    const root = await makeRepo({ "a.ts": "1\n" });
    cleanup.push(root);
    const sessionId = SessionId.make("s");
    const [t1, t2] = [TurnId.make("t1"), TurnId.make("t2")];
    const c0 = await gitText(root, ["rev-parse", "HEAD"]);
    write(root, "a.ts", "2\n");
    const c1 = await commitAll(root, "one");
    write(root, "b.ts", "new\n");
    const c2 = await commitAll(root, "two");

    for (const [turn, label, commit] of [
      [t1, "before", c0],
      [t1, "after", c1],
      [t2, "before", c1],
      [t2, "after", c2],
    ] as const) {
      await gitText(root, ["update-ref", checkpointRef(sessionId, turn, label), commit]);
    }

    const both = await computeDiff(
      root,
      DiffSpec.cases.Turns.make({ sessionId, firstTurnId: t1, lastTurnId: t2 })
    );

    expect(indexDiff(both.bytes).map((f) => f.path)).toEqual(["a.ts", "b.ts"]);

    const last = await computeDiff(
      root,
      DiffSpec.cases.Turns.make({ sessionId, firstTurnId: t2, lastTurnId: t2 })
    );

    expect(indexDiff(last.bytes).map((f) => f.path)).toEqual(["b.ts"]);
  });

  test("git.show reads a file at a revision, never the working tree", async () => {
    const root = await makeRepo({ "src/a.ts": "old\n" });
    cleanup.push(root);
    const first = await gitText(root, ["rev-parse", "HEAD"]);
    write(root, "src/a.ts", "uncommitted\n");

    const shown = await showFile(root, first, "src/a.ts");
    expect(text.decode(shown.bytes)).toBe("old\n");
    expect(shown.size).toBe(4);
    expect(shown.mimeType).toBe("text/typescript");

    await Promise.resolve(
      expect(showFile(root, first, "missing.ts")).rejects.toBeInstanceOf(DiffNotFound)
    );
  });

  test("git.show with no revision reads the index, as the Editor's staged diffs do", async () => {
    const root = await makeRepo({ "src/a.ts": "old\n" });
    cleanup.push(root);
    write(root, "src/a.ts", "staged\n");
    await gitText(root, ["add", "src/a.ts"]);
    write(root, "src/a.ts", "unstaged\n");

    const shown = await showFile(root, "", "src/a.ts");
    expect(text.decode(shown.bytes)).toBe("staged\n");
  });
});
