/**
 * Set up tracing's install (ENG-694): writes the bundled polaris-tracing skill into each global
 * skills folder the Harness reads, as `npx skills add -g` would, without fetching anything.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type HarnessKind,
  isKnownHarness,
  type KnownHarnessKind,
  TraceSkillError,
  TracingSkillRpcs,
} from "@polaris/protocol";
import { Effect } from "effect";
import { SKILL_NAME } from "./name.ts";

export interface SkillHome {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const set = (value: string | undefined) => {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/** Each Harness's global skills folder, as skills@1.7.4's agent table names it. */
const FOLDERS: Readonly<Record<KnownHarnessKind, (at: SkillHome) => string>> = {
  claude: ({ home, env }) => join(set(env.CLAUDE_CONFIG_DIR) ?? join(home, ".claude"), "skills"),
  codex: ({ home }) => join(home, ".agents", "skills"),
  opencode: ({ home, env }) =>
    join(set(env.XDG_CONFIG_HOME) ?? join(home, ".config"), "opencode", "skills"),
  gemini: ({ home }) => join(home, ".gemini", "skills"),
  copilot: ({ home }) => join(home, ".copilot", "skills"),
};

/** The skill folders to write for `harness`; an unknown or absent one gets Claude's and Codex's. */
export const skillFolders = (harness: HarnessKind | null, at: SkillHome): ReadonlyArray<string> => {
  const kinds: ReadonlyArray<KnownHarnessKind> =
    harness !== null && isKnownHarness(harness) ? [harness] : ["claude", "codex"];

  return kinds.map((kind) => join(FOLDERS[kind](at), SKILL_NAME));
};

/** Replaces `folder` with the bundled copy; a skills CLI symlink there is replaced, not followed. */
const writeSkill = async (folder: string) => {
  const staging = `${folder}.${randomBytes(4).toString("hex")}.tmp`;

  // The skill's text loads on first install, keeping it out of the Daemon's start-up graph.
  const { BUNDLED_SKILL } = await import("./bundled.ts");

  try {
    for (const [path, contents] of BUNDLED_SKILL) {
      const file = join(staging, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents);
    }

    await rm(folder, { recursive: true, force: true });
    await rename(staging, folder);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

export const installTracingSkill = Effect.fn("traces.installSkill")(function* (
  harness: HarnessKind | null,
  at: SkillHome = { home: homedir(), env: process.env }
) {
  const paths = skillFolders(harness, at);

  yield* Effect.forEach(paths, (folder) =>
    Effect.tryPromise({
      try: () => writeSkill(folder),
      catch: (cause) =>
        new TraceSkillError({
          code: "E-TRACE-SKILL-INSTALL",
          message: `Couldn't write the polaris-tracing skill to ${folder}: ${String(cause)}`,
          fix: `Check that ${dirname(folder)} is writable on this host, then try again.`,
        }),
    })
  );

  return { paths };
});

export const TracingSkillRpcsLive = TracingSkillRpcs.toLayer({
  "traces.installSkill": ({ harness }) => installTracingSkill(harness),
});
