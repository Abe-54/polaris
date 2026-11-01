/**
 * Daemon Sources (CONTEXT.md; ENG-714): the Daemon's own `POLARIS_HOME/*.sqlite` files, read-only,
 * only while Developer Mode is effective. Listed per request: no watcher, nothing runs while off.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  DataError,
  type DataSource,
  type DeveloperMode,
  type WorkspaceId,
} from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { polarisHome } from "../paths.ts";
import { connectionUrl, type Candidate } from "./connection.ts";

/** Display names start here; manual and discovered names can't contain it, so they never clash. */
export const DAEMON_SOURCE_PREFIX = "Daemon · ";

export const DAEMON_SOURCE_LABEL: DataSource["label"] = { text: "DAEMON", colour: "grey" };

export const isDaemonSource = (source: Pick<DataSource, "foundIn">) =>
  source.foundIn.kind === "daemon";

/** Agents read a Daemon Source without approval while it is listed; nothing writes to it. */
export const daemonPolicy: Pick<DataSource, "access" | "writes"> = {
  access: "read",
  writes: "off",
};

export const daemonReadOnly = () =>
  new DataError({
    code: "E-DATA-READ-ONLY",
    message: "Daemon Sources can never be written to.",
    fix: "Use query to read the Daemon's database.",
  });

export const daemonUnchangeable = () =>
  new DataError({
    code: "E-DATA-READ-ONLY",
    message: "Daemon Sources can't be removed, renamed, relabelled or saved.",
    fix: "They follow Developer Mode; turn it off to hide them.",
  });

/** The regular `*.sqlite` files directly in the Daemon's home, by real path, sorted by name. */
export async function daemonFiles(home: string): Promise<ReadonlyArray<string>> {
  const root = await realpath(home).catch(() => undefined);

  if (root === undefined) return [];
  const names = await readdir(root).catch(() => []);
  const files: string[] = [];

  for (const name of names.filter((entry) => entry.endsWith(".sqlite")).sort()) {
    const stat = await lstat(join(root, name)).catch(() => undefined);

    if (stat?.isFile()) files.push(name);
  }

  return files.map((name) => join(root, name));
}

const candidate = (file: string): Candidate => {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const engine = { engine: "sqlite", host: "", port: 0, database: "", user: "", path: file };

  return {
    name: `${DAEMON_SOURCE_PREFIX}${name.slice(0, -".sqlite".length)}`,
    url: connectionUrl(engine, ""),
    foundIn: { kind: "daemon", file: name },
  };
};

/** Shown in the Polaris Workspace's checkouts, or in every checkout when there is none. */
export const daemonSourcesShown = (mode: DeveloperMode, workspaceId: WorkspaceId | undefined) =>
  mode.effective && (mode.polarisWorkspaceId === null || mode.polarisWorkspaceId === workspaceId);

export interface DaemonSourceOptions {
  readonly mode: Effect.Effect<DeveloperMode>;
  readonly changes: Stream.Stream<DeveloperMode>;
  readonly home?: () => string;
}

/** The candidates a session's checkout lists, and a signal when that may have changed. */
export const daemonSources = (options: DaemonSourceOptions) => ({
  candidates: (workspaceId: WorkspaceId | undefined) =>
    Effect.gen(function* () {
      if (!daemonSourcesShown(yield* options.mode, workspaceId)) return [];
      const home = (options.home ?? polarisHome)();

      return (yield* Effect.promise(() => daemonFiles(home))).map(candidate);
    }),
  /** Emits once at once (DeveloperModeState's changes start with the current mode), then per change. */
  changes: options.changes.pipe(
    Stream.changesWith(
      (a, b) => a.effective === b.effective && a.polarisWorkspaceId === b.polarisWorkspaceId
    ),
    Stream.map(() => undefined)
  ),
});

export type DaemonSources = ReturnType<typeof daemonSources>;
