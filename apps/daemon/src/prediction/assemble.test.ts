import { afterEach, expect, test } from "bun:test";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HostId,
  LanguageConnectionIdentity,
  PredictionContextRequest,
  WorkspaceId,
} from "@polaris/protocol";
import { countTokens } from "@polaris/predict";
import { ContextAssembler } from "./assemble.ts";
import { readSource } from "./files.ts";
import { budgetContext } from "./budget.ts";
import { posixTest } from "../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

const pinnedReadTest = posixTest(
  "imported sources are read descriptor-relative through POSIX openat (languages/media/native.ts) (ENG-296)"
);

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempDirSettled(root);
});

async function fixture() {
  const root = newTempDir("prediction-", { short: true });
  roots.push(root);
  await writeFile(
    join(root, "dep.ts"),
    "export function value(input: number): string { return 'hidden'; }"
  );

  const request = PredictionContextRequest.make({
    workspaceId: WorkspaceId.make("prediction"),
    path: "file.ts",
    buffer: 'import { value } from "./dep";\nvalue(',
    cursor: 37,
    recentEdits: [{ path: "file.ts", from: 0, to: 0, text: "first edit" }],
    budgetTokens: 8192,
  });

  return { root, request, path: join(root, "file.ts"), signal: new AbortController().signal };
}

pinnedReadTest(
  "untrusted context uses bounded outlines, reflects imported edits, and freezes history until a pause",
  async () => {
    const f = await fixture();
    const assembler = new ContextAssembler();

    const owner = LanguageConnectionIdentity.make({
      hostId: HostId.make("host"),
      clientId: "client",
    });

    const first = await assembler.assemble(
      owner,
      f.root,
      f.path,
      f.request,
      undefined,
      f.signal,
      1000
    );

    expect(first.map((piece) => piece.kind)).toEqual(["importOutline", "editHunk"]);
    expect(first[0]?.text).not.toContain("hidden");

    const changed = {
      ...f.request,
      recentEdits: [{ path: "file.ts", from: 1, to: 1, text: "second edit" }],
    };

    const burst = await assembler.assemble(
      owner,
      f.root,
      f.path,
      changed,
      undefined,
      f.signal,
      1100
    );

    expect(burst).toEqual(first);

    const pause = await assembler.assemble(
      owner,
      f.root,
      f.path,
      changed,
      undefined,
      f.signal,
      1700
    );

    expect(pause.at(-1)?.text).toContain("second edit");
    await writeFile(
      join(f.root, "dep.ts"),
      "export function replacement(value: string): boolean { return true; }"
    );

    const edited = await assembler.assemble(
      owner,
      f.root,
      f.path,
      changed,
      undefined,
      f.signal,
      1800
    );

    expect(edited[0]?.text).toContain("replacement");
    expect(edited[0]?.text).not.toContain("function value");
  }
);

pinnedReadTest(
  "file reads refuse symlink escape and large files, and read a file in the root",
  async () => {
    const f = await fixture();
    const other = await fixture();
    await symlink(join(other.root, "dep.ts"), join(f.root, "escape.ts"));
    expect(await readSource(f.root, join(f.root, "escape.ts"), f.signal)).toBeUndefined();
    await writeFile(join(f.root, "large.ts"), "x".repeat(131073));
    expect(await readSource(f.root, join(f.root, "large.ts"), f.signal)).toBeUndefined();
    expect((await readSource(f.root, join(f.root, "dep.ts"), f.signal))?.text).toBeString();
  }
);

test("a cancelled file read rejects with AbortError", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await Promise.resolve(
    expect(readSource(f.root, join(f.root, "dep.ts"), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
  );
});

test("counter budget includes sources and UTF-8, keeps stable-first order and never splits a surrogate", () => {
  const result = budgetContext(
    [
      { kind: "diagnostic", source: "file.ts", text: "error" },
      { kind: "definition", source: "file.ts", text: "😀".repeat(20) },
    ],
    [{ kind: "importOutline", source: "dep.ts", text: "type X = string;" }],
    [{ kind: "editHunk", source: "file.ts", text: "edit" }],
    60
  );

  expect(result[0]?.kind).toBe("definition");
  expect(
    result.reduce((sum, piece) => sum + countTokens(`${piece.source}\n${piece.text}\n`), 0)
  ).toBeLessThanOrEqual(60);
  expect(result[0]?.text).not.toMatch(/[\uD800-\uDBFF]$/);
});
