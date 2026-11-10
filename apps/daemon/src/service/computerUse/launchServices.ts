/**
 * The fallback for a macOS that drops the disclaim SPI (ADR 0104): LaunchServices starts the
 * helper, which is then its own responsible process, and it connects back over a Unix socket
 * three times: control (the request, kills, the exit), data (stdin and stdout) and stderr.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { childEnv } from "../childEnv.ts";
import { launcherOf } from "./bundle.ts";
import type { Env, HelperProcess, HelperRequest } from "./process.ts";

/** Starts the helper so that it runs `connect <socket>`; resolves once it was asked to start. */
export type Launch = (helper: string, socket: string) => Promise<void>;

export interface LaunchServicesOptions {
  readonly launch?: Launch;
  /** How long the helper has to connect back. */
  readonly connectTimeoutMs?: number;
}

/** `open -n` starts a new instance per process; `-g -j` keep it hidden and in the background. */
export const openHelper: Launch = async (helper, socket) => {
  const proc = Bun.spawn(
    ["/usr/bin/open", "-n", "-g", "-j", "-a", helper, "--args", "connect", socket],
    { env: childEnv(), stdin: "ignore", stdout: "ignore", stderr: "pipe" }
  );

  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  if (code !== 0) throw new Error(`open exited ${code}: ${stderr.trim()}`);
};

/** Starts the launcher's `connect` directly, without LaunchServices: tests use this. */
export const execHelper: Launch = (helper, socket) => {
  Bun.spawn([launcherOf(helper), "connect", socket], {
    env: childEnv(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  return Promise.resolve();
};

const encoder = new TextEncoder();

/** The control connection's request: a kind byte and a string per record, NUL-terminated. */
export const encodeRequest = (request: HelperRequest, env: Env): Uint8Array => {
  const records = [
    ...[request.tool, ...request.args].map((value) => `a${value}`),
    ...Object.entries(env).flatMap(([key, value]) =>
      value === undefined ? [] : [`v${key}=${value}`]
    ),
    ...(request.cwd === undefined ? [] : [`w${request.cwd}`]),
    ".",
  ];

  return encoder.encode(records.map((record) => `${record}\0`).join(""));
};

type Tag = "c" | "d" | "e";

const isTag = (value: string): value is Tag => value === "c" || value === "d" || value === "e";

interface Connection {
  tag: Tag | null;
  /** Bytes the kernel hasn't taken yet, written again when the socket drains. */
  readonly pending: Array<Uint8Array>;
  /** Half-close once `pending` is empty. */
  ending: boolean;
}

type Peer = Socket<Connection>;

const flush = (peer: Peer) => {
  const { pending } = peer.data;

  while (pending.length > 0) {
    const head = pending[0]!;
    const written = peer.write(head);

    if (written < head.length) {
      pending[0] = head.subarray(Math.max(written, 0));

      return;
    }

    pending.shift();
  }

  if (peer.data.ending) peer.shutdown();
};

const send = (peer: Peer, chunk: string | Uint8Array) => {
  peer.data.pending.push(Buffer.from(chunk));
  flush(peer);
};

const byteStream = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;

  const readable = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });

  return {
    readable,
    push: (chunk: Uint8Array) => {
      if (open) controller.enqueue(chunk);
    },
    close: () => {
      if (open) controller.close();
      open = false;
    },
  };
};

/** `exit 3` from the control connection's last line; 1 when the helper went without one. */
const exitCodeOf = (control: string): number => {
  const match = /^exit (\d+)$/m.exec(control);

  return match === null ? 1 : Number(match[1]);
};

/**
 * Starts `request.tool` in the helper through LaunchServices. Resolves when the helper has
 * connected back; rejects when it can't be started or doesn't connect in time.
 */
export const spawnThroughLaunchServices = async (
  helper: string,
  request: HelperRequest,
  options: LaunchServicesOptions = {}
): Promise<HelperProcess> => {
  // mkdtemp makes the directory 0700, so only this user reaches the socket.
  const dir = mkdtempSync(join(tmpdir(), "polaris-cu-"));
  const path = join(dir, "s");
  const stdout = byteStream();
  const stderr = byteStream();
  const peers: Partial<Record<Tag, Peer>> = {};
  const beforeData: Array<string | Uint8Array> = [];
  const connected = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number>();
  let controlText = "";
  let endRequested = false;
  let done = false;
  const gone = new Set<Tag>();

  /** Stops listening and removes the socket; streams still open are closed. */
  const cleanUp = () => {
    if (done) return;
    done = true;
    stdout.close();
    stderr.close();
    listener.stop(true);
    rmSync(dir, { recursive: true, force: true });
    exited.resolve(exitCodeOf(controlText));
    connected.reject(new Error("the helper went away before it connected"));
  };

  /** The exit is known when control closes; output may still be arriving on the other two. */
  const closed = (tag: Tag) => {
    delete peers[tag];
    gone.add(tag);

    if (tag === "d") stdout.close();

    if (tag === "e") stderr.close();

    if (tag === "c") exited.resolve(exitCodeOf(controlText));

    if (gone.has("c") && peers.d === undefined && peers.e === undefined) cleanUp();
  };

  const adopt = (peer: Peer, tag: Tag) => {
    peer.data.tag = tag;
    peers[tag] = peer;

    if (tag === "c") send(peer, encodeRequest(request, request.env ?? childEnv()));

    if (tag === "d") {
      for (const chunk of beforeData.splice(0)) send(peer, chunk);
      peer.data.ending = endRequested;
      flush(peer);
    }

    if (peers.c !== undefined && peers.d !== undefined && peers.e !== undefined)
      connected.resolve();
  };

  const route = (tag: Tag, bytes: Uint8Array) => {
    if (tag === "c") controlText += new TextDecoder().decode(bytes);
    else (tag === "d" ? stdout : stderr).push(new Uint8Array(bytes));
  };

  const listener = Bun.listen<Connection>({
    unix: path,
    socket: {
      open: (peer) => {
        peer.data = { tag: null, pending: [], ending: false };
      },
      data: (peer, chunk) => {
        let bytes: Uint8Array = chunk;

        if (peer.data.tag === null) {
          const tag = String.fromCharCode(bytes[0] ?? 0);

          if (!isTag(tag)) return void peer.end();
          adopt(peer, tag);
          bytes = bytes.subarray(1);
        }

        if (bytes.length > 0) route(peer.data.tag!, bytes);
      },
      drain: flush,
      close: (peer) => {
        if (peer.data.tag !== null) closed(peer.data.tag);
      },
      error: () => {},
    },
  });

  // Nobody may be waiting when a late clean-up rejects this.
  connected.promise.catch(() => {});

  const timeout = setTimeout(
    () => connected.reject(new Error("the helper did not connect back in time")),
    options.connectTimeoutMs ?? 15_000
  );

  try {
    await (options.launch ?? openHelper)(helper, path);
    await connected.promise;
  } catch (error) {
    cleanUp();
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return {
    via: "launch-services",
    write: (chunk) => {
      if (peers.d === undefined) beforeData.push(chunk);
      else send(peers.d, chunk);
    },
    end: () => {
      endRequested = true;

      if (peers.d !== undefined) {
        peers.d.data.ending = true;
        flush(peers.d);
      }
    },
    stdout: stdout.readable,
    stderr: stderr.readable,
    exited: exited.promise,
    kill: (signal = "SIGTERM") => {
      if (peers.c !== undefined && !done) send(peers.c, signal === "SIGKILL" ? "k" : "t");
    },
  };
};
