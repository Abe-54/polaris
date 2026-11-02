/**
 * A fake remote Host for tests: a temporary HOME that commands "sent over
 * ssh" run in, and a Daemon build whose `polaris` is a shell stand-in that
 * installs, upgrades and (optionally) bridges to a real Daemon from source.
 * Used by `service.slow.test.ts` and the smoke test; not shipped.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const hostPlatform = (): string => {
  const uname = (flag: string) => spawnSync("uname", [flag]).stdout.toString().trim().toLowerCase();
  const arch = uname("-m") === "x86_64" ? "x64" : "arm64";

  return `${uname("-s")}-${arch}`;
};

export interface StandIn {
  readonly paddingBytes?: number;
  readonly version: string;
  readonly platform: string;
  /** Runs a real Daemon: `[bun, apps/daemon/src/main.ts]`; absent, install only lays files down. */
  readonly daemon?: ReadonlyArray<string>;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A `polaris` that installs itself into `$HOME/.polaris` like the real one. */
export const standInPolaris = ({ version, platform, daemon }: StandIn): string => {
  const run = daemon === undefined ? null : daemon.map(quote).join(" ");

  const start =
    run === null
      ? ""
      : [
          `    POLARIS_HOME="$HOME/.polaris" nohup ${run} serve --foreground >"$HOME/.polaris/daemon.log" 2>&1 &`,
          `    echo $! > "$HOME/.polaris/stand-in.pid"`,
          `    i=0; while [ ! -S "$HOME/.polaris/daemon.sock" ] && [ $i -lt 150 ]; do sleep 0.1; i=$((i+1)); done`,
        ].join("\n");

  const bridge = run === null ? "exit 69" : `POLARIS_HOME="$HOME/.polaris" exec ${run} bridge`;

  return `#!/bin/sh
case "$1" in
  version) echo "polaris ${version} ${platform}" ;;
  install)
    dir="$HOME/.polaris/bin/${version}"; mkdir -p "$dir"
    [ "$0" = "$dir/polaris" ] || cp "$0" "$dir/polaris"
    ln -sfn "${version}" "$HOME/.polaris/bin/current"
${start}
    echo '{"ok":true,"action":"install","version":"${version}","notes":[]}' ;;
  upgrade)
    new=$("$2" version | cut -d' ' -f2); dir="$HOME/.polaris/bin/$new"; mkdir -p "$dir"
    cp "$2" "$dir/polaris"; ln -sfn "$new" "$HOME/.polaris/bin/current"
    # Like the real hand-off: a running Daemon is replaced by the new build's.
    if [ -f "$HOME/.polaris/stand-in.pid" ]; then
      kill "$(cat "$HOME/.polaris/stand-in.pid")" 2>/dev/null; rm -f "$HOME/.polaris/daemon.sock"
      "$dir/polaris" install >/dev/null
    fi
    echo "{\\"ok\\":true,\\"action\\":\\"handoff\\",\\"version\\":\\"$new\\"}" ;;
  bridge) ${bridge} ;;
esac
`;
};

/** Writes `<dist>/manifest.json` and `<dist>/<platform>/polaris` as `build-daemon.ts` does. */
export const writeDist = (dist: string, standIn: StandIn): string => {
  const binary =
    standInPolaris(standIn) +
    (standIn.paddingBytes ? `#${"x".repeat(standIn.paddingBytes)}\n` : "");

  const sha256 = createHash("sha256").update(binary).digest("hex");
  mkdirSync(join(dist, standIn.platform), { recursive: true });
  writeFileSync(join(dist, standIn.platform, "polaris"), binary);
  chmodSync(join(dist, standIn.platform, "polaris"), 0o755);
  writeFileSync(
    join(dist, "manifest.json"),
    JSON.stringify({
      version: standIn.version,
      commit: "test",
      platforms: {
        [standIn.platform]: {
          target: `bun-${standIn.platform}`,
          binary: "polaris",
          sha256,
          files: { polaris: { sha256, size: Buffer.byteLength(binary) } },
        },
      },
    })
  );

  return sha256;
};

/** Runs a remote command line as sshd would, with the fake Host's HOME. */
export const runOnFakeHost = (home: string, command: string, stdinFile?: string) => {
  const proc = spawnSync("sh", ["-c", command], {
    env: { PATH: process.env.PATH, HOME: home },
    input: stdinFile === undefined ? undefined : readFileSync(stdinFile),
  });

  return {
    code: proc.status ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
};

/**
 * A stand-in `ssh` for PATH: for `alias` it drops the options and runs the
 * remote command in `sh` with HOME at the fake Host's; any other alias goes
 * to the real ssh.
 */
export const fakeSshScript = (
  alias: string,
  home: string,
  realSsh = "/usr/bin/ssh"
): string => `#!/bin/sh
for arg in "$@"; do [ "$arg" = ${quote(alias)} ] && fake=1; done
[ -n "$fake" ] || exec ${quote(realSsh)} "$@"
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -o|-e|-p|-l|-i|-F|-J) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
HOME=${quote(home)} exec sh -c "$*"
`;
