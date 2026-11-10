/**
 * Test Hosts for computer use: a temp directory with fake commands on PATH and live Unix
 * sockets, all read through the real probe, and agent-desktop's macOS status. Not used at runtime.
 * A fake command is a script this test's Bun runs, behind `sh` or a `.cmd`, so any OS starts it.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { afterEach } from "bun:test";
import { newTempDir } from "../platform/tempDir.testing.ts";
import { type HostProbe, hostProbe, type ProbeOptions } from "./probe.ts";

const servers: Array<Server> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** What a fake command answers when `when` is in its arguments (always, without one). */
export interface FakeReply {
  readonly when?: string;
  readonly stdout?: string;
  readonly code?: number;
}

const windows = process.platform === "win32";

/** The fake's program: logs its arguments on one line, then answers with the first reply that fits. */
const programOf = (log: string, replies: ReadonlyArray<FakeReply>) => `
const line = process.argv.slice(2).join(" ");
require("node:fs").appendFileSync(${JSON.stringify(log)}, line + "\\n");
const reply = ${JSON.stringify(replies)}.find((r) => r.when === undefined || line.includes(r.when));
process.stdout.write(reply?.stdout ?? "");
process.exit(reply?.code ?? 0);
`;

export interface FakeHost {
  readonly root: string;
  readonly bin: string;
  /** A command on PATH that logs its arguments and gives the first of `replies` that fits; exit 0 otherwise. */
  readonly command: (name: string, replies?: ReadonlyArray<FakeReply>) => void;
  /** Every logged call of a fake command, as its argument lines. */
  readonly calls: (name: string) => ReadonlyArray<string>;
  /** A Unix socket at `path` that accepts connections until the test ends. */
  readonly listen: (path: string) => Promise<void>;
  readonly file: (path: string, text?: string) => string;
  readonly probe: (options?: ProbeOptions) => HostProbe;
}

export const fakeHost = (): FakeHost => {
  const root = newTempDir("pl-cu-", { short: true });
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = (name: string) => join(root, `${name}.calls`);

  const file = (path: string, text = "") => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);

    return path;
  };

  return {
    root,
    bin,
    command: (name, replies = []) => {
      const program = join(bin, `${name}.fake.cjs`);
      writeFileSync(program, programOf(log(name), replies));

      if (windows) {
        writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${program}" %*\r\n`);

        return;
      }

      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${program}' "$@"\n`);
      chmodSync(path, 0o755);
    },
    calls: (name) => {
      try {
        return readFileSync(log(name), "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    listen: (path) => {
      mkdirSync(dirname(path), { recursive: true });
      const server = createServer((socket) => socket.end());
      servers.push(server);

      return new Promise((done) => server.listen(path, () => done()));
    },
    file,
    probe: (options = {}) =>
      hostProbe({
        uid: 1000,
        ...options,
        env: { PATH: bin, ...options.env },
        paths: {
          console: join(root, "console"),
          x11: join(root, "x11"),
          runtimeRoot: join(root, "run"),
          a11yServices: [join(root, "dbus-1", "org.a11y.Bus.service")],
          ...options.paths,
        },
      }),
  };
};

/** agent-desktop 1.2.0's `status` on macOS with each permission in a given state. */
export const macStatus = (accessibility: string, screenRecording: string) =>
  JSON.stringify({
    version: "2.6",
    ok: true,
    command: "status",
    data: {
      permissions: {
        accessibility: { state: accessibility },
        automation: { state: "unknown" },
        screen_recording: { state: screenRecording },
      },
      platform: "macos",
    },
  });

/** A Linux Host with a live Wayland desktop in the Daemon's environment. */
export const linuxDesktop = async (host: FakeHost) => {
  await host.listen(join(host.root, "run", "1000", "wayland-0"));

  return host.probe({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } });
};

export const a11yInstalled = (host: FakeHost) =>
  host.file(join(host.root, "dbus-1", "org.a11y.Bus.service"));

/** busctl answering the a11y bus's address, and the registry's ping exiting `ping`. */
export const busctl = (host: FakeHost, ping: number) =>
  host.command("busctl", [
    { when: "GetAddress", stdout: 's "unix:path=/tmp/a11y"\n' },
    { when: "Ping", code: ping },
  ]);
