/**
 * Test Hosts for computer use: a temp directory with fake commands on PATH, live Unix sockets
 * and a fake helper app, all read through the real probe. Not used at runtime.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { afterEach } from "bun:test";
import { newTempDir } from "../platform/tempDir.testing.ts";
import { launcherOf } from "../service/computerUse/bundle.ts";
import { type HostProbe, hostProbe, type ProbeOptions } from "./probe.ts";

const servers: Array<Server> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

export interface FakeHost {
  readonly root: string;
  readonly bin: string;
  /** A command on PATH that prints `stdout` and exits `code`, logging its arguments. */
  readonly command: (name: string, script: string) => void;
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
    command: (name, script) => {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\necho "$*" >> '${log(name)}'\n${script}\n`);
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

/**
 * A helper app whose launcher prints what `status` holds for `run agent-desktop status`,
 * so a test changes a grant by rewriting it. Its calls are logged as `launcher`.
 */
export const fakeHelper = (host: FakeHost, status: string) => {
  const bundle = join(host.root, "Polaris Computer Use.app");
  const statusFile = host.file(join(host.root, "status.json"), status);
  const launcher = host.file(launcherOf(bundle));
  const calls = join(host.root, "launcher.calls");
  writeFileSync(launcher, `#!/bin/sh\necho "$*" >> '${calls}'\n/bin/cat '${statusFile}'\n`);
  chmodSync(launcher, 0o755);

  return {
    bundle,
    grant: (next: string) => writeFileSync(statusFile, next),
    calls: () => host.calls("launcher"),
  };
};
