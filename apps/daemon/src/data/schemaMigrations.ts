/** Literal known migration paths, checked only on committed Turn boundaries. */
import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { runGitRaw } from "../git/git.ts";
import { checkpointRef } from "../git/checkpointRefs.ts";
import type { Turn } from "@polaris/protocol";

export const migrationPath = (path: string) =>
  /^(?:prisma\/migrations|drizzle|db\/migrate|supabase\/migrations|[^/]+\/migrations)(?:\/|$)/.test(
    path
  );

export const migrationCheckout = async (checkout: string) => {
  const paths = ["prisma/migrations", "drizzle", "db/migrate", "supabase/migrations"];
  const children = await readdir(checkout, { withFileTypes: true }).catch(() => []);

  for (const child of children.slice(0, 256))
    if (child.isDirectory() && !child.name.startsWith(".")) paths.push(`${child.name}/migrations`);

  for (const path of paths) {
    const stat = await lstat(join(checkout, path)).catch(() => null);

    if (stat?.isDirectory() && !stat.isSymbolicLink()) return true;
  }

  return false;
};

export const migrationChanged = async (checkout: string, turn: Turn) => {
  const result = await runGitRaw(
    checkout,
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      checkpointRef(turn.sessionId, turn.id, "before"),
      checkpointRef(turn.sessionId, turn.id, "after"),
      "--",
    ],
    { timeoutMs: 5000, maxOutputBytes: 1024 * 1024 }
  );

  return (
    result.code === 0 && new TextDecoder().decode(result.stdout).split("\0").some(migrationPath)
  );
};
