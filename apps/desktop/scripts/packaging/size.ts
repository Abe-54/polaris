import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIB = 1024 * 1024;

/**
 * The release Mac app's size budget (packaging/README.md, "Size budget"): 0.8.5's DMG was
 * 194 MiB and 0.8.2's installed app 470 MiB; each budget leaves about 15% headroom.
 */
export const SIZE_BUDGET = { dmgBytes: 225 * MIB, appBytes: 540 * MIB } as const;

export type SizeBudget = { readonly dmgBytes: number; readonly appBytes: number };

/** Bytes of the regular files under `path`; symlinks count as themselves, never their targets. */
export const treeSize = (path: string): number => {
  const stat = lstatSync(path);

  if (!stat.isDirectory()) return stat.size;

  return readdirSync(path).reduce((total, name) => total + treeSize(join(path, name)), 0);
};

const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

/** The app's largest parts, so a failed budget says where the bytes went. */
const breakdown = (app: string) =>
  ["Contents/Frameworks", "Contents/Resources/daemon", "Contents/Resources/app.asar"].map(
    (part) => `  ${part}: ${mib(treeSize(join(app, part)))}`
  );

/** Checks a packaged `Polaris.app` and its DMG against `budget`; throws when either is over. */
export const checkSizeBudget = (
  paths: { readonly app: string; readonly dmg: string },
  budget: SizeBudget = SIZE_BUDGET
): string => {
  const app = treeSize(paths.app);
  const dmg = treeSize(paths.dmg);

  const lines = [
    `DMG ${mib(dmg)} of ${mib(budget.dmgBytes)}`,
    `Polaris.app ${mib(app)} of ${mib(budget.appBytes)}`,
  ];

  const over = [
    ...(dmg > budget.dmgBytes ? ["DMG"] : []),
    ...(app > budget.appBytes ? ["Polaris.app"] : []),
  ];

  if (over.length > 0)
    throw new Error(
      [`size budget exceeded (${over.join(", ")}):`, ...lines, ...breakdown(paths.app)].join("\n")
    );

  return `size budget: ${lines.join(", ")}`;
};
