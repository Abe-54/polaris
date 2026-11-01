import { killTree } from "../../platform/processes.ts";

type Child = Pick<Bun.Subprocess, "pid" | "exited" | "exitCode" | "signalCode">;

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

/** The owned launch preload turns SIGINT into a normal exit so --cpu-prof flushes. */
export const stopOwned = async (child: Child) => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    if (exited(child)) return;
    await killTree(child.pid, signal);
    await waitForExit(child, 5000);
  }

  if (!exited(child)) await killTree(child.pid, "SIGKILL");
  await child.exited;
};
