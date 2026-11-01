import { createServer, type Socket } from "node:net";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
import type { SessionId } from "@polaris/protocol";
import bootstrap from "./bootstrap.mjs.txt" with { type: "text" };
import { polarisHome } from "../../paths.ts";
import { appendNodeImport } from "../nodeOptions.ts";
import { attachError, inspectTarget, recheckTarget, type AttachTarget } from "./target.ts";

const Message = Schema.Struct({
  kind: Schema.Literals(["register", "watchdog", "opened", "refused"]),
  token: Schema.optionalKey(Schema.String),
  nonce: Schema.optionalKey(Schema.String),
  pid: Schema.Int,
  runtime: Schema.optionalKey(Schema.Literal("node")),
  url: Schema.optionalKey(Schema.String),
});

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Message));

export interface RegisteredTarget extends AttachTarget {
  readonly sessionId: SessionId;
  readonly socket: Socket;
  readonly token: string;
}

interface Capture {
  readonly target: RegisteredTarget;
  readonly seconds: number;
  readonly resolve: (value: { url: string; close: () => Promise<void> }) => void;
  readonly reject: (error: Error) => void;
  socket?: Socket;
  heartbeat?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
}

/** Launch capabilities and live control connections exist only for this Daemon lifetime. */
export class TargetRegistry {
  private readonly tokens = new Map<string, SessionId>();
  private readonly targets = new Map<number, RegisteredTarget>();
  private readonly captures = new Map<string, Capture>();
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((socket) => this.accept(socket));
  private ready?: Promise<{ root: string; path: string; module: string }>;
  private closed = false;

  constructor(private readonly moduleRoot = join(polarisHome(), "profile-bootstrap")) {}

  private prepare() {
    this.ready ??= (async () => {
      const root = await mkdtemp("/tmp/polaris-profile-");
      const path = join(root, "control.sock");
      await mkdir(this.moduleRoot, { recursive: true, mode: 0o700 });

      const module = join(
        this.moduleRoot,
        `${createHash("sha256").update(bootstrap).digest("hex")}.mjs`
      );

      try {
        await writeFile(module, bootstrap, { mode: 0o600, flag: "wx" });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }

      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(path, () => {
          this.server.off("error", reject);
          resolve();
        });
      });

      return { root, path, module };
    })();

    return this.ready;
  }

  async environment(sessionId: SessionId, options?: string) {
    if (this.closed || process.platform === "win32") return {};
    const { path, module } = await this.prepare();

    if (this.closed) return {};

    if (this.tokens.size >= 1024) this.tokens.delete(this.tokens.keys().next().value!);
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, sessionId);

    return {
      NODE_OPTIONS: appendNodeImport(options, module),
      POLARIS_PROFILE_SOCKET: path,
      POLARIS_PROFILE_TOKEN: token,
    };
  }

  get(sessionId: SessionId, pid: number) {
    const target = this.targets.get(pid);

    if (!target || target.sessionId !== sessionId || target.socket.destroyed)
      throw attachError(
        "This Node process is not registered for this agent session. Restart with profiling instead."
      );
    recheckTarget(target, target.token);

    return target;
  }

  private accept(socket: Socket) {
    if (this.closed || this.sockets.size >= 256) return socket.destroy();
    this.sockets.add(socket);
    let buffer = "";
    let registered = false;
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.sockets.delete(socket);

      for (const [pid, target] of this.targets)
        if (target.socket === socket) this.targets.delete(pid);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();

      if (buffer.length > 16384) return socket.destroy();
      let end: number;

      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);

        try {
          const message = decode(line);

          if (!registered) {
            registered = true;
            this.register(socket, message);
          } else this.received(socket, message);
        } catch {
          socket.destroy();
        }
      }
    });
  }

  private register(socket: Socket, message: typeof Message.Type) {
    const sessionId = message.token && this.tokens.get(message.token);

    if (!sessionId) return socket.destroy();

    if (message.kind === "register" && message.runtime === "node") {
      if (this.targets.has(message.pid)) return socket.destroy();
      this.targets.set(message.pid, {
        ...inspectTarget(message.pid, message.token),
        sessionId,
        token: message.token,
        socket,
      });

      return;
    }

    const capture = message.nonce && this.captures.get(message.nonce);

    if (
      message.kind !== "watchdog" ||
      !capture ||
      capture.socket ||
      capture.target.pid !== message.pid ||
      capture.target.token !== message.token
    )
      return socket.destroy();
    recheckTarget(capture.target, capture.target.token);
    capture.socket = socket;
    socket.on("close", () => {
      this.finish(message.nonce!);
    });
    capture.heartbeat = setInterval(() => socket.write('{"kind":"ping"}\n'), 400);
    socket.write('{"kind":"open"}\n');
  }

  private received(socket: Socket, message: typeof Message.Type) {
    const entry = [...this.captures].find(([, capture]) => capture.socket === socket);

    if (!entry) return socket.destroy();
    const [, capture] = entry;

    if (message.kind !== "opened" || !message.url) {
      capture.reject(attachError("The target already has an inspector or refused profiling."));
      socket.write('{"kind":"close"}\n');

      return;
    }

    const url = new URL(message.url);

    if (
      url.protocol !== "ws:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      !/^\/[a-f0-9-]+$/.test(url.pathname)
    )
      throw attachError("The target returned an unsafe inspector endpoint.");
    clearTimeout(capture.timeout);
    capture.resolve({
      url: url.href,
      close: () =>
        new Promise<void>((resolve, reject) => {
          if (socket.destroyed) {
            resolve();

            return;
          }

          const timeout = setTimeout(() => {
            socket.destroy();
            reject(attachError("The target did not confirm inspector shutdown."));
          }, 2500);

          socket.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
          socket.write('{"kind":"close"}\n');
        }),
    });
  }

  open(target: RegisteredTarget, seconds: number) {
    if (
      this.closed ||
      this.captures.size !== 0 ||
      this.get(target.sessionId, target.pid) !== target
    )
      return Promise.reject(attachError("Another capture is active or the target changed."));
    const nonce = randomBytes(32).toString("hex");

    return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
      const capture: Capture = { target, seconds, resolve, reject };
      capture.timeout = setTimeout(() => {
        capture.socket?.destroy();
        this.finish(nonce);
      }, 5000);
      this.captures.set(nonce, capture);
      target.socket.write(JSON.stringify({ kind: "capture", nonce, seconds }) + "\n");
    });
  }

  private finish(nonce: string) {
    const capture = this.captures.get(nonce);

    if (!capture) return;
    clearInterval(capture.heartbeat);
    clearTimeout(capture.timeout);
    this.captures.delete(nonce);
    capture.reject(attachError("The target disconnected or the capture expired."));
  }

  async close() {
    this.closed = true;

    for (const socket of this.sockets) socket.destroy();

    for (const nonce of this.captures.keys()) this.finish(nonce);
    this.tokens.clear();
    this.targets.clear();

    if (!this.ready) return;
    const { root } = await this.ready;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(root, { force: true, recursive: true });
  }
}

export class InspectorTargets extends Context.Service<InspectorTargets, TargetRegistry>()(
  "polaris/traces/InspectorTargets"
) {
  static readonly layer = Layer.effect(
    InspectorTargets,
    Effect.acquireRelease(
      Effect.sync(() => new TargetRegistry()),
      (registry) => Effect.promise(() => registry.close())
    )
  );
}
