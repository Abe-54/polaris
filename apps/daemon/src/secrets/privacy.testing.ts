import { expect } from "bun:test";
import { statSync } from "node:fs";
import { system32 } from "../platform/processes.ts";

/** Checks the OS's access controls, rather than POSIX mode bits synthesized by Windows. */
export const expectPrivate = (path: string, kind: "file" | "directory") => {
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(kind === "file" ? 0o600 : 0o700);

    return;
  }

  const result = Bun.spawnSync([system32("icacls.exe"), path]);
  expect(result.exitCode).toBe(0);

  const entries = result.stdout
    .toString()
    .split(/\r?\n/)
    .map((line) => line.replace(path, "").trim())
    .filter((line) => line.includes(":("));

  const account = Bun.spawnSync([system32("whoami.exe")]);
  expect(account.exitCode).toBe(0);
  expect(entries.map((entry) => entry.toLowerCase())).toEqual([
    `${account.stdout.toString().trim().toLowerCase()}:${kind === "file" ? "(f)" : "(oi)(ci)(f)"}`,
  ]);
};
