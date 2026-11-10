/**
 * A tool running in the helper, over the three sockets the Daemon hands the launcher
 * (`handOff.ts`): control (the request, kills, the exit), data (stdin and stdout) and stderr.
 * Both ways of starting the launcher (`launch.ts`) end here.
 */
import { randomBytes } from "node:crypto";
import type { Socket } from "bun";
import { childEnv } from "../childEnv.ts";
import { COMPUTER_USE_BUNDLE_ID } from "./bundle.ts";
import { type Channels, closeAll, lookUp, openChannels, sendFiles } from "./handOff.ts";
import type { Launch, Launched, LauncherExit } from "./launch.ts";
import type { Env, HelperProcess, HelperRequest, SpawnVia } from "./process.ts";

export interface ChannelOptions {
  /** How long the launcher has to start and to accept the hand-off. */
  readonly connectTimeoutMs?: number;
}

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

interface Connection {
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
      if (open) controller.enqueue(new Uint8Array(chunk));
    },
    close: () => {
      if (open) controller.close();
      open = false;
    },
  };
};

/** One of the Daemon's socket ends as a Bun socket; `closed` settles when the launcher's end is gone. */
const adopt = async (fd: number, onData: (bytes: Uint8Array) => void) => {
  const closed = Promise.withResolvers<void>();

  const peer = await Bun.connect<Connection>({
    fd,
    data: { pending: [], ending: false },
    socket: {
      data: (_peer, chunk) => onData(chunk),
      drain: flush,
      close: () => closed.resolve(),
      error: () => closed.resolve(),
    },
  });

  return { peer, closed: closed.promise };
};

const describeExit = (exit: LauncherExit) =>
  `the helper's launcher exited ${exit.code}${exit.stderr === "" ? "" : `: ${exit.stderr}`}`;

interface Gone {
  exit: LauncherExit | null;
}

/** The launcher's Mach service, once it has checked it in; fails when it exits or takes too long. */
const serviceOf = async (name: string, launched: Launched, timeoutMs: number): Promise<number> => {
  const gone: Gone = { exit: null };
  const deadline = Date.now() + timeoutMs;

  void launched.exited?.then((exit) => {
    gone.exit = exit;
  });

  for (;;) {
    const port = lookUp(name);

    if (port !== null) return port;

    if (gone.exit !== null) throw new Error(describeExit(gone.exit));

    if (Date.now() > deadline) throw new Error("the helper did not start in time");
    await Bun.sleep(5);
  }
};

/** Gives the launcher its ends of fresh sockets; the Daemon's ends come back. */
const handOff = (port: number): Channels["mine"] => {
  const channels = openChannels();

  try {
    sendFiles(port, channels.theirs);
  } catch (error) {
    closeAll(channels.mine);
    throw error;
  } finally {
    closeAll(channels.theirs);
  }

  return channels.mine;
};

const exitLine = /^exit (\d+)$/m;

/**
 * Starts `request.tool` in the helper with `launch`. Resolves when the launcher has taken the
 * hand-off and answered `ok`; rejects when it can't be started, refuses, or takes too long.
 */
export const spawnInHelper = async (
  helper: string,
  request: HelperRequest,
  via: SpawnVia,
  launch: Launch,
  options: ChannelOptions = {}
): Promise<HelperProcess> => {
  const timeoutMs = options.connectTimeoutMs ?? 15_000;
  const name = `${COMPUTER_USE_BUNDLE_ID}.${randomBytes(16).toString("hex")}`;
  const launched = await launch(helper, name);
  const fds = handOff(await serviceOf(name, launched, timeoutMs));
  const stdout = byteStream();
  const stderr = byteStream();
  const accepted = Promise.withResolvers<void>();
  let controlText = "";

  const [control, data, errors] = await Promise.all([
    adopt(fds[0]!, (bytes) => {
      controlText += new TextDecoder().decode(bytes);

      if (controlText.startsWith("ok\n")) accepted.resolve();
    }),
    adopt(fds[1]!, stdout.push),
    adopt(fds[2]!, stderr.push),
  ]);

  void data.closed.then(stdout.close);
  void errors.closed.then(stderr.close);

  /** The tool's exit from control's last line; else the launcher's own, or 1 when unknown. */
  const exited = control.closed.then(async () => {
    const line = exitLine.exec(controlText);

    if (line !== null) return Number(line[1]);

    return launched.exited === null ? 1 : (await launched.exited).code;
  });

  // No `ok` before control closes: the launcher refused this process or died.
  void control.closed.then(async () => {
    const exit = launched.exited === null ? null : await launched.exited;
    const why = exit === null ? "the helper's launcher refused the hand-off" : describeExit(exit);
    accepted.reject(new Error(why));
  });

  const timeout = setTimeout(
    () => accepted.reject(new Error("the helper did not accept the hand-off in time")),
    timeoutMs
  );

  try {
    await accepted.promise;
  } catch (error) {
    for (const { peer } of [control, data, errors]) peer.end();
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  send(control.peer, encodeRequest(request, request.env ?? childEnv()));
  let controlOpen = true;
  void control.closed.then(() => {
    controlOpen = false;
  });

  return {
    via,
    write: (chunk) => send(data.peer, chunk),
    end: () => {
      data.peer.data.ending = true;
      flush(data.peer);
    },
    stdout: stdout.readable,
    stderr: stderr.readable,
    exited,
    kill: (signal = "SIGTERM") => {
      if (controlOpen) send(control.peer, signal === "SIGKILL" ? "k" : "t");
    },
  };
};
