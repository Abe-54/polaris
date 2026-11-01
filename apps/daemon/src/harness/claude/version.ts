import { harnessEnv } from "../environment.ts";

export const defaultRunVersion = async (path: string) => {
  const proc = Bun.spawn([path, "--version"], {
    env: harnessEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10_000,
  });

  const stdout = await new Response(proc.stdout).text();

  return { exitCode: await proc.exited, stdout };
};
