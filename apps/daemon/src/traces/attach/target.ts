import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { dlopen, ptr } from "bun:ffi";
import { ProfileError } from "@polaris/protocol";
import { findExecutable } from "../../platform/executable.ts";
import { libcPath } from "../../platform/index.ts";

export const attachError = (
  message: string,
  code: ProfileError["code"] = "E-PROFILE-ATTACH-REFUSED"
) =>
  new ProfileError({
    code,
    message,
    fix: "Use Restart with profiling for an unregistered process.",
  });

export interface AttachTarget {
  readonly pid: number;
  readonly executable: string;
  readonly identity: string;
  readonly command: string;
}

const darwin = () =>
  dlopen(libcPath(), {
    proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" },
    proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
    sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
  });

let native: ReturnType<typeof darwin> | undefined;

/** KERN_PROCARGS2 has padding after the executable, but argv itself may contain empty strings. */
export const darwinArgs = (bytes: Buffer) => {
  if (bytes.length < 5) throw attachError("The process arguments are unavailable.");
  const argc = bytes.readInt32LE(0);
  const executableEnd = bytes.indexOf(0, 4);

  if (argc < 1 || argc > bytes.length || executableEnd < 0)
    throw attachError("The process arguments are unavailable.");
  let offset = executableEnd + 1;

  while (bytes[offset] === 0) offset++;
  const argv: string[] = [];

  for (let n = 0; n < argc; n++) {
    const end = bytes.indexOf(0, offset);

    if (end < 0) throw attachError("The process arguments are unavailable.");
    argv.push(bytes.subarray(offset, end).toString());
    offset = end + 1;
  }

  return { argv, env: bytes.subarray(offset).toString().split("\0").filter(Boolean) };
};

// Darwin's proc_bsdinfo and KERN_PROCARGS2 layouts come from the system SDK headers.
const onDarwin = (pid: number) => {
  native ??= darwin();
  const path = Buffer.alloc(4096);
  const info = Buffer.alloc(136);
  const args = Buffer.alloc(1024 * 1024);
  const size = new BigUint64Array([BigInt(args.length)]);
  const mib = new Int32Array([1, 49, pid]);

  if (
    native.symbols.proc_pidpath(pid, ptr(path), path.length) <= 0 ||
    native.symbols.proc_pidinfo(pid, 3, 0, ptr(info), info.length) !== info.length ||
    native.symbols.sysctl(ptr(mib), mib.length, ptr(args), ptr(size), null, 0) !== 0
  )
    throw attachError("The process identity or launch options could not be verified.");

  return {
    executable: path.toString().split("\0")[0]!,
    start: info.subarray(120, 136).toString("hex"),
    uid: info.readUInt32LE(20),
    ...darwinArgs(args.subarray(0, Number(size[0]))),
  };
};

const onLinux = (pid: number) => {
  const root = `/proc/${pid}`;
  const fields = readFileSync(`${root}/stat`, "utf8").split(") ").at(-1)!.split(" ");

  return {
    executable: readlinkSync(`${root}/exe`),
    start: fields[19]!,
    uid: statSync(root).uid,
    argv: readFileSync(`${root}/cmdline`, "utf8").split("\0").filter(Boolean),
    env: readFileSync(`${root}/environ`, "utf8").split("\0").filter(Boolean),
  };
};

/** Kernel executable identity corroborates cooperative registration; argv/process.title never identifies Node. */
export const inspectTarget = (pid: number, launchToken: string): AttachTarget => {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw attachError("Inspector attach is unavailable on this platform.");

  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647 || pid === process.pid)
    throw attachError("Select another live Node process.");
  const facts = process.platform === "darwin" ? onDarwin(pid) : onLinux(pid);

  if (!facts.env.includes(`POLARIS_PROFILE_TOKEN=${launchToken}`))
    throw attachError("The process was not launched with this registration capability.");

  const installed = findExecutable("node");

  if (
    !installed ||
    realpathSync(facts.executable) !== realpathSync(installed) ||
    basename(facts.executable) !== "node" ||
    facts.uid !== process.getuid?.()
  )
    throw attachError(
      "Only the Host's installed Node executable, owned by this user, can be attached. Bun is refused."
    );

  const options = [...facts.argv, ...facts.env.filter((v) => v.startsWith("NODE_OPTIONS="))].join(
    " "
  );

  if (/--(?:disable-sigusr1|experimental-permission|permission)\b/.test(options))
    throw attachError("This process opts out of inspector attach or restricts inspector access.");
  const file = statSync(facts.executable);

  return {
    pid,
    executable: facts.executable,
    identity: `${pid}:${facts.start}:${file.dev}:${file.ino}`,
    command: facts.argv.join(" ").slice(0, 4096),
  };
};

export const recheckTarget = (target: AttachTarget, launchToken: string) => {
  const now = inspectTarget(target.pid, launchToken);

  if (now.identity !== target.identity || now.command !== target.command)
    throw attachError("The process changed while approval was pending.");
};
