import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { CODEX_BUILTINS, listCodexCommands, readPrompts, toPrompt } from "./commands.ts";
import { startFakeAppServer } from "./testing/FakeAppServer.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** Socket paths must stay under ~104 bytes, so tests use /tmp directly. */
const tempDir = () => {
  const dir = newTempDir("pcc-", { short: true });
  cleanup.push(() => removeTempDir(dir));

  return dir;
};

interface SkillExtra {
  readonly shortDescription?: string;
  readonly enabled?: boolean;
  readonly pluginId?: string;
}

const skill = (name: string, scope: string, extra: SkillExtra = {}) => ({
  name,
  description: `The ${name} skill`,
  path: `/skills/${name}/SKILL.md`,
  scope,
  enabled: true,
  pluginId: null,
  ...extra,
});

describe("Codex's commands", () => {
  test("custom prompts send their body; frontmatter names the description and arguments", () => {
    const prompt = toPrompt(
      "ship.md",
      '---\ndescription: "Ship the branch"\nargument-hint: <branch>\n---\nPush $ARGUMENTS and open a PR.\n'
    );

    expect(prompt).toMatchObject({
      name: "prompts:ship",
      sigil: "/",
      description: "Ship the branch",
      argumentHint: "<branch>",
      run: "text",
      template: "Push $ARGUMENTS and open a PR.",
    });
    expect(toPrompt("plain.md", "Explain this code.\nCarefully.")).toMatchObject({
      description: "Explain this code.",
      argumentHint: null,
      template: "Explain this code.\nCarefully.",
    });
  });

  test("prompts are read from CODEX_HOME/prompts, if it exists", () => {
    const home = tempDir();
    expect(readPrompts(home)).toEqual([]);
    mkdirSync(join(home, "prompts"));
    writeFileSync(join(home, "prompts", "a.md"), "Do a");
    writeFileSync(join(home, "prompts", "notes.txt"), "not a prompt");
    expect(readPrompts(home).map((p) => p.name)).toEqual(["prompts:a"]);
  });

  test("built-ins run through Codex or Polaris", () => {
    expect(CODEX_BUILTINS.map((c) => [c.name, c.run, c.action])).toEqual([
      ["fast", "polaris", "fast"],
      ["compact", "harness", null],
      ["review", "harness", null],
      ["model", "polaris", "model"],
      ["new", "polaris", "new-session"],
      ["diff", "polaris", "diff"],
    ]);
  });

  test("Skills come from skills/list for the directory, enabled ones only, invoked with $", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "s.sock");
    const codexHome = join(dir, "home");
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    cleanup.push(() => {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    });

    const server = startFakeAppServer(socketPath, (request, conn) => {
      if (request.method === "initialize") return conn.reply({ userAgent: "fake" });

      if (request.method === "skills/list")
        conn.reply({
          data: [
            {
              cwd: "/repo",
              errors: [],
              skills: [
                skill("zeta", "repo"),
                skill("alpha", "user", { shortDescription: "Short alpha" }),
                skill("off", "user", { enabled: false }),
                skill("bundled", "system"),
                skill("plugged", "user", { pluginId: "tools@market" }),
              ],
            },
          ],
        });
    });

    cleanup.push(server.stop);

    const listed = await Effect.runPromise(
      listCodexCommands({ codexPath: "/opt/codex", socketPath, clientVersion: "test" })("/repo")
    );

    expect(server.requests("skills/list")[0]?.params).toEqual({ cwds: ["/repo"] });
    expect(
      listed.filter((c) => c.kind === "skill").map((c) => [c.name, c.sigil, c.source])
    ).toEqual([
      ["alpha", "$", "user"],
      ["bundled", "$", "built-in"],
      ["plugged", "$", "plugin"],
      ["zeta", "$", "project"],
    ]);
    expect(listed.find((c) => c.name === "alpha")?.description).toBe("Short alpha");
    expect(listed.filter((c) => c.kind === "command").map((c) => c.name)).toEqual([
      "compact",
      "diff",
      "fast",
      "model",
      "new",
      "review",
    ]);
  });
});
