import * as cp from "node:child_process";
import { execFile, spawn as start } from "node:child_process";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

declare const childEnv: (source?: Record<string, string | undefined>) => Record<string, string>;
declare const harnessEnv: () => Record<string, string>;
declare const inherited: Record<string, string>;

Bun.spawn(["/bin/true"]);
Bun.spawnSync(["/bin/true"], { stdout: "pipe" });
start("/bin/true", [], { env: process.env });
execFile("/bin/true", [], { env: { ...inherited } }, () => {});
cp.spawn("/bin/true");
const sdk: Options = { cwd: "/" };
Bun.spawn({ cmd: ["/bin/true"], env: inherited });

const built = childEnv();
const base = { stdout: "pipe" as const, env: childEnv() };
Bun.spawn(["/bin/true"], { env: childEnv() });
Bun.spawn(["/bin/true"], { env: built });
Bun.spawn(["/bin/true"], { ...base, stdin: "ignore" });
Bun.spawn(["/bin/true"], { env: process.platform === "win32" ? harnessEnv() : built });
Bun.spawn(["/bin/true"], { env: { LANG: "C", ...childEnv() } });
start("/bin/true", [], { env: childEnv({ ...process.env, TERM: "dumb" }) });
const ok: Options = { cwd: "/", env: harnessEnv() };
const regex = /x/;
regex.exec("x");
export { built, ok, sdk };
