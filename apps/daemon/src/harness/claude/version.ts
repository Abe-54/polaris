import { childEnv } from "../../service/childEnv.ts";

export const defaultRunVersion = async (path: string) => {
  const proc = Bun.spawn([path, "--version"], {
    env: childEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10_000,
  });

  const stdout = await new Response(proc.stdout).text();

  return { exitCode: await proc.exited, stdout };
};
