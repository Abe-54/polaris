import { tempDir } from "../../platform/tempDir.testing.ts";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SlashCommand as SdkCommand } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import type { QueryFn } from "./ClaudeDriver.ts";
import { FakeClaude } from "./fakeClaude.ts";
import { classify, listClaudeCommands, type SkillDirs, skillDirs } from "./commands.ts";
import fixture from "./fixtures/supported-commands-2.1.286.json";

// SAFETY: captured from `supportedCommands()` of Claude Code 2.1.286 (trimmed descriptions).
const SDK = fixture as ReadonlyArray<SdkCommand>;

const dirs: SkillDirs = {
  user: (name) => name === "tdd" || name === "handoff",
  project: (name) => name === "product-design",
  pluginCommand: (plugin, name) => plugin === "codex" && name === "rescue",
};

const byName = (name: string) => classify(SDK, dirs).find((c) => c.name === name);

describe("Claude Code's commands", () => {
  test("terminal-only built-ins and internal ones are left out", () => {
    const names = classify(SDK, dirs).map((c) => c.name);

    for (const hidden of ["color", "context", "heapdump", "reload-skills", "__remote-workflow"])
      expect(names).not.toContain(hidden);
  });

  test("built-ins run as text or as a Polaris action", () => {
    expect(byName("compact")).toMatchObject({ run: "text", kind: "command", source: "built-in" });
    expect(byName("init")).toMatchObject({ run: "text" });
    expect(byName("clear")).toMatchObject({ run: "polaris", action: "new-session" });
    expect(byName("model")).toMatchObject({ run: "polaris", action: "model" });
    expect(byName("effort")).toMatchObject({ run: "polaris", action: "model" });
    expect(byName("usage")).toMatchObject({ run: "polaris", action: "usage" });
  });

  test("a (user) suffix names the source; a Skill folder makes it a Skill", () => {
    expect(byName("grill-me")).toMatchObject({
      kind: "command",
      source: "user",
      run: "text",
      description: "A relentless interview to sharpen a plan or design.",
    });
    expect(byName("handoff")).toMatchObject({
      kind: "skill",
      source: "user",
      description: "Compact the current conversation into a handoff document.",
      argumentHint: "What will the next session be used for?",
    });
  });

  test("Skills come from the user, the project, or Claude Code itself", () => {
    expect(byName("tdd")).toMatchObject({ kind: "skill", source: "user" });
    expect(byName("product-design")).toMatchObject({ kind: "skill", source: "project" });
    expect(byName("simplify")).toMatchObject({ kind: "skill", source: "built-in" });
    expect(byName("compact")?.argumentHint).toBe("<optional custom summarization instructions>");
    expect(byName("tdd")?.argumentHint).toBeNull();
  });

  test("plugin entries name their plugin, by name or alias", () => {
    expect(byName("codex:rescue")).toMatchObject({
      source: "plugin",
      plugin: "codex",
      kind: "command",
    });
    expect(byName("codex:rescue")?.description.startsWith("Delegate")).toBe(true);
    expect(byName("engineering:standup")).toMatchObject({ plugin: "engineering", kind: "skill" });
    expect(byName("docx")).toMatchObject({ source: "plugin", plugin: "anthropic-skills" });
  });

  test("Skills come before commands; each takes the / sigil and no template", () => {
    const listed = classify(SDK, dirs);
    const firstCommand = listed.findIndex((c) => c.kind === "command");

    expect(listed.slice(firstCommand).every((c) => c.kind === "command")).toBe(true);
    expect(listed.every((c) => c.sigil === "/" && c.template === null)).toBe(true);
  });

  test("skill folders are found up to the git root, plugin commands by install path", () => {
    const home = tempDir("polaris-claude-home-");
    const repo = tempDir("polaris-claude-repo-");
    const cwd = join(repo, "packages", "app");
    const plugin = join(home, "plugin");

    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, ".claude", "skills", "ship"), { recursive: true });
    mkdirSync(join(home, ".claude", "skills", "mine"), { recursive: true });
    mkdirSync(join(plugin, "commands"), { recursive: true });
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(plugin, "commands", "rescue.md"), "");
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "codex@openai": [{ installPath: plugin }] } })
    );

    const found = skillDirs(cwd, home);
    expect([found.project("ship"), found.user("mine"), found.user("ship")]).toEqual([
      true,
      true,
      false,
    ]);
    expect([found.pluginCommand("codex", "rescue"), found.pluginCommand("codex", "x")]).toEqual([
      true,
      false,
    ]);
  });

  test("listing starts claude in the directory with project settings and closes it", async () => {
    const fake = new FakeClaude();
    fake.commands = [...SDK];

    const listed = await Effect.runPromise(
      listClaudeCommands({ claudePath: () => "/bin/claude", query: fake.query })("/tmp")
    );

    expect(listed.length).toBeGreaterThan(10);
    expect(fake.options?.cwd).toBe("/tmp");
    expect(fake.options?.settingSources).toEqual(["user", "project", "local"]);
    expect(fake.options?.settings).toEqual({ disableAllHooks: true });
    expect(fake.closed).toBe(true);
  });

  test("no claude on PATH is an error", async () => {
    const query: QueryFn = () => {
      throw new Error("not started");
    };

    const list = listClaudeCommands({ claudePath: () => null, query });
    const error = await Effect.runPromise(list("/tmp").pipe(Effect.flip));
    expect(error.message).toContain("not installed");
  });
});
