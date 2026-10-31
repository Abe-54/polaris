/** Scripted launches may reach only explicitly supplied, disposable local Daemons. */
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isPipePath, localEndpoint } from "@polaris/protocol/endpoint";

const canonical = (path: string): string => {
  const absolute = resolve(path);

  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);

  return parent === absolute ? absolute : join(canonical(parent), relative(parent, absolute));
};

const within = (root: string, target: string): boolean => {
  const child = relative(root, target);

  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

const temporary = (path: string): boolean => {
  const target = canonical(path);
  const userHome = canonical(homedir());
  const systemHome = canonical(join(userHome, ".polaris"));
  const roots = process.platform === "win32" ? [tmpdir()] : [tmpdir(), "/tmp"];

  if (target === userHome || target === systemHome || within(systemHome, target)) return false;

  return roots.some((root) => within(canonical(root), target));
};

/** Only dedicated install smokes opt in; launchd's label is shared even with a temporary HOME. */
export const scriptedInstallHome = (
  home: string | null,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): string | null => {
  if (env.POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL !== "1") return null;

  if (home === null || !temporary(home))
    throw new Error("scripted local install requires a canonical temporary home");

  if (
    platform === "darwin" &&
    env.CI !== "1" &&
    env.CI !== "true" &&
    env.POLARIS_DESKTOP_SCRIPTED_VM !== "1"
  )
    throw new Error(
      "local install smokes require CI or a disposable VM on macOS: even a temporary HOME registers the shared dev.lux.polaris launchd job and may write ~/Library/LaunchAgents"
    );

  return canonical(home);
};

/** Reject system endpoints and symlinks escaping the temporary directory, including in packaged apps. */
export const assertScriptedDaemon = (socket: string, home: string | null): void => {
  if (home !== null && !temporary(home))
    throw new Error("scripted local Daemon home must be a temporary directory");

  if (isPipePath(socket)) {
    if (home !== null && socket === localEndpoint(join(home, ".polaris"), "win32")) return;
  } else if (temporary(socket)) return;

  throw new Error("scripted local Daemon socket must belong to a temporary directory");
};
