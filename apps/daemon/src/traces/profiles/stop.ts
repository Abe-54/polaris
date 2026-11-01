import { executableOf } from "../../platform/executable.ts";
import { pathToFileURL } from "node:url";
import { killTree } from "../../platform/processes.ts";

type Child = Pick<Bun.Subprocess, "pid" | "exited" | "exitCode" | "signalCode" | "send">;

const EXIT_MESSAGE = "polaris-profile-exit";

const START_MESSAGE = "polaris-profile-start";

export const ownedExitModule = process.platform === "win32" ? "exit.mjs" : "exit.cjs";

export const ownedExitPreload =
  process.platform === "win32"
    ? `await new Promise(resolve => {
  process.on("message", message => {
    if (message === ${JSON.stringify(EXIT_MESSAGE)}) process.exit(0);
    if (message === ${JSON.stringify(START_MESSAGE)}) resolve();
  });
});
process.channel?.unref();
`
    : 'process.once("SIGINT", () => process.exit(0));\n';

export const spawnOwned = (
  program: string,
  args: ReadonlyArray<string>,
  runtime: "node" | "bun",
  preload: string,
  options: Bun.Spawn.SpawnOptions<"ignore", "ignore", "ignore">
) => {
  let flag = runtime === "node" ? "--require" : "--preload";

  if (process.platform === "win32") {
    options.ipc = () => {};

    options.serialization = "json";

    if (runtime === "node") {
      flag = "--import";
      preload = pathToFileURL(preload).href;
    }
  }

  return Bun.spawn([executableOf(program), flag, preload, ...args], options);
};

export const resumeOwned = async (child: Child) => {
  if (process.platform !== "win32") return;

  try {
    const { containProcess } = await import("../../platform/windowsNative.ts");
    const release = containProcess(child.pid);
    void child.exited.finally(release);
    child.send(START_MESSAGE);
  } catch (error) {
    await killTree(child.pid, "SIGKILL");
    await child.exited;
    throw error;
  }
};

const exited = (child: Child) => child.exitCode !== null || child.signalCode !== null;

const waitForExit = async (child: Child, milliseconds: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      child.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const requestExit = async (child: Child, signal: "SIGINT" | "SIGTERM") => {
  if (process.platform === "win32" && signal === "SIGINT") {
    try {
      child.send(EXIT_MESSAGE);

      return;
    } catch {}
  }

  await killTree(child.pid, signal);
};

/** The owned preload exits cooperatively so --cpu-prof flushes before forceful fallback. */
export const stopOwned = async (child: Child) => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    if (exited(child)) return;
    await requestExit(child, signal);
    await waitForExit(child, 5000);
  }

  if (!exited(child)) await killTree(child.pid, "SIGKILL");
  await child.exited;
};
