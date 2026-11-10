import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { Effect } from "effect";
import { installTracingSkill, skillFolders } from "./index.ts";
import { BUNDLED_SKILL } from "./bundled.ts";

const SOURCE = join(import.meta.dir, "../../../../../skills/polaris-tracing");

const filesUnder = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });

  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join("/"))
    .toSorted();
};

const withHome = async (use: (home: string) => Promise<void>) => {
  const home = await mkdtemp(join(tmpdir(), "skill-"));

  try {
    await use(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

describe("the bundled polaris-tracing skill", () => {
  test("bundles every file of skills/polaris-tracing, unchanged", async () => {
    const source = await filesUnder(SOURCE);

    expect(BUNDLED_SKILL.map(([path]) => path).toSorted()).toEqual([...source]);

    for (const [path, contents] of BUNDLED_SKILL)
      expect(contents).toBe(await readFile(join(SOURCE, path), "utf8"));
  });

  test("installs for Claude and Codex by default, into the folders their CLIs read", () =>
    withHome(async (home) => {
      const { paths } = await Effect.runPromise(installTracingSkill(null, { home, env: {} }));

      expect(paths).toEqual([
        join(home, ".claude/skills/polaris-tracing"),
        join(home, ".agents/skills/polaris-tracing"),
      ]);

      for (const path of paths)
        expect(await filesUnder(path)).toEqual(BUNDLED_SKILL.map(([p]) => p).toSorted());
    }));

  test("follows CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME, and one Harness gets only its folder", () => {
    const env = { CLAUDE_CONFIG_DIR: "/c", XDG_CONFIG_HOME: "/x" };

    expect(skillFolders("claude", { home: "/h", env })).toEqual([
      join("/c", "skills/polaris-tracing"),
    ]);
    expect(skillFolders("opencode", { home: "/h", env })).toEqual([
      join("/x", "opencode/skills/polaris-tracing"),
    ]);
    expect(skillFolders("my-agent", { home: "/h", env: {} })).toEqual([
      join("/h", ".claude/skills/polaris-tracing"),
      join("/h", ".agents/skills/polaris-tracing"),
    ]);
  });

  test("replaces an older install and a skills CLI symlink without touching its target", () =>
    withHome(async (home) => {
      const stale = join(home, ".agents/skills/polaris-tracing");
      await mkdir(join(stale, "references"), { recursive: true });
      await writeFile(join(stale, "references/removed.md"), "old");
      const linked = join(home, ".claude/skills");
      await mkdir(linked, { recursive: true });
      await symlink(stale, join(linked, "polaris-tracing"));

      await Effect.runPromise(installTracingSkill("claude", { home, env: {} }));

      expect(await readFile(join(stale, "references/removed.md"), "utf8")).toBe("old");
      expect(await filesUnder(join(linked, "polaris-tracing"))).toEqual(
        BUNDLED_SKILL.map(([p]) => p).toSorted()
      );

      await Effect.runPromise(installTracingSkill("codex", { home, env: {} }));
      expect(await filesUnder(stale)).not.toContain("references/removed.md");
    }));

  test("an unwritable home fails with the folder and a fix", () =>
    withHome(async (home) => {
      await writeFile(join(home, ".claude"), "a file, not a folder");

      const exit = await Effect.runPromise(
        Effect.flip(installTracingSkill("claude", { home, env: {} }))
      );

      expect(exit.code).toBe("E-TRACE-SKILL-INSTALL");
      expect(exit.message).toContain(join(home, ".claude/skills/polaris-tracing"));
    }));
});
