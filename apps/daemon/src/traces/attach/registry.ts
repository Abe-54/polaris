import { createServer, type Socket } from "node:net";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Context, Effect, Layer, Schema, Option, Stream, Predicate } from "effect";
import type { SessionId } from "@polaris/protocol";
import { EventStore } from "../../store/EventStore.ts";
import bootstrap from "./bootstrap.mjs.txt" with { type: "text" };
import { polarisHome } from "../../paths.ts";
import { appendNodeImport } from "../nodeOptions.ts";
import { attachError, inspectTarget, recheckTarget, peerPid, type AttachTarget } from "./target.ts";

const Message = Schema.Struct({
  kind: Schema.Literals(["register", "watchdog", "opened", "refused", "chunk", "completed"]),
  token: Schema.optionalKey(Schema.String),
  nonce: Schema.optionalKey(Schema.String),
  pid: Schema.Int,
  runtime: Schema.optionalKey(Schema.Literal("node")),
  data: Schema.optionalKey(Schema.String),
});

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Message));

export interface RegisteredTarget extends AttachTarget {
  readonly sessionId: SessionId;
  readonly socket: Socket;
  readonly token: string;
}

export interface CaptureHandle {
  /** Bounded raw JSON; parsing remains on the profiles worker. */
  readonly profile: Promise<string>;
  readonly close: () => Promise<void>;
}

interface Capture {
  readonly target: RegisteredTarget;
  readonly seconds: number;
  readonly resolve: (value: CaptureHandle) => void;
  readonly result: Promise<string>;
  readonly complete: (value: string) => void;
  readonly fail: (error: Error) => void;
  readonly chunks: string[];
  bytes: number;
  opened: boolean;
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
  private readonly registrations = new Set<Socket>();
  private readonly watchdogs = new Set<Socket>();
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

  private admit(socket: Socket) {
    if (this.closed) return false;

    try {
      const pid = peerPid(socket);
      const capturing = [...this.captures.values()].some((capture) => capture.target.pid === pid);
      const pool = capturing ? this.watchdogs : this.registrations;
      const limit = capturing ? 1 : 256;

      if (pool.size >= limit) return false;
      pool.add(socket);
      socket.once("close", () => pool.delete(socket));

      return true;
    } catch {
      return false;
    }
  }

  private accept(socket: Socket) {
    if (!this.admit(socket)) return socket.destroy();
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let registered = false;
    const handshake = setTimeout(() => socket.destroy(), 2000);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(handshake);
      this.sockets.delete(socket);

      for (const [pid, target] of this.targets)
        if (target.socket === socket) this.targets.delete(pid);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();

      let end: number;

      while ((end = buffer.indexOf("\n")) >= 0) {
        if (end > 64 * 1024) return socket.destroy();
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);

        try {
          const message = decode(line);

          if (!registered) {
            clearTimeout(handshake);
            registered = true;
            this.register(socket, message);
          } else this.received(socket, message);
        } catch {
          socket.destroy();
        }
      }

      if (buffer.length > 64 * 1024) socket.destroy();
    });
  }

  private register(socket: Socket, message: typeof Message.Type) {
    if (peerPid(socket) !== message.pid) return socket.destroy();
    const sessionId = message.token && this.tokens.get(message.token);

    if (message.kind === "register" && message.runtime === "node") {
      if (!sessionId || this.targets.size >= 256 || this.targets.has(message.pid))
        return socket.destroy();
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

    if (message.kind === "opened") {
      if (capture.opened) return socket.destroy();
      capture.opened = true;
      capture.resolve({
        profile: capture.result,
        close: async () => {
          socket.write('{"kind":"close"}\n');
          socket.destroy();
          this.finish(entry[0]);
        },
      });

      return;
    }

    if (!capture.opened) return socket.destroy();

    if (message.kind === "chunk" && message.data !== undefined) {
      capture.bytes += Buffer.byteLength(message.data);

      if (capture.bytes > 64 * 1024 * 1024) return socket.destroy();
      capture.chunks.push(message.data);

      return;
    }

    if (message.kind === "completed") {
      const profile = capture.chunks.join("");
      capture.chunks.length = 0;
      capture.complete(profile);
      clearTimeout(capture.timeout);

      return;
    }

    socket.destroy();
  }

  open(target: RegisteredTarget, seconds: number) {
    if (
      this.closed ||
      this.captures.size !== 0 ||
      this.get(target.sessionId, target.pid) !== target
    )
      return Promise.reject(attachError("Another capture is active or the target changed."));
    const nonce = randomBytes(32).toString("hex");

    return new Promise<CaptureHandle>((resolve, reject) => {
      const result = Promise.withResolvers<string>();
      void result.promise.catch(() => {});

      const capture: Capture = {
        target,
        seconds,
        resolve,
        reject,
        result: result.promise,
        complete: result.resolve,
        fail: result.reject,
        chunks: [],
        bytes: 0,
        opened: false,
      };

      capture.timeout = setTimeout(
        () => {
          capture.socket?.destroy();
          this.finish(nonce);
        },
        seconds * 1000 + 5000
      );
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
    const error = attachError("The target disconnected or the capture expired.");
    capture.reject(error);
    capture.fail(error);
  }

  revokeSession(id: SessionId) {
    for (const [token, sessionId] of this.tokens) if (sessionId === id) this.tokens.delete(token);

    for (const target of this.targets.values())
      if (target.sessionId === id) target.socket.destroy();

    for (const [nonce, capture] of this.captures)
      if (capture.target.sessionId === id) {
        capture.socket?.destroy();
        this.finish(nonce);
      }
  }

  prune(active: (id: SessionId) => boolean) {
    for (const id of new Set(this.tokens.values())) if (!active(id)) this.revokeSession(id);
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
  static layerAt = (moduleRoot?: string) =>
    Layer.effect(
      InspectorTargets,
      Effect.gen(function* () {
        const registry = yield* Effect.acquireRelease(
          Effect.sync(() => new TargetRegistry(moduleRoot)),
          (value) => Effect.promise(() => value.close())
        );

        const events = yield* Effect.serviceOption(EventStore);

        if (Option.isSome(events)) {
          const store = events.value;

          const changes = yield* store.subscribe({
            filter: (item) =>
              Predicate.isTagged(item, "Event") &&
              (Predicate.isTagged(item.envelope.event, "SessionStateChanged") ||
                Predicate.isTagged(item.envelope.event, "WorkspaceRemoved")),
          });

          yield* changes.pipe(
            Stream.runForEach((item) =>
              Effect.gen(function* () {
                if (!Predicate.isTagged(item, "Event")) return;
                const event = item.envelope.event;

                if (
                  Predicate.isTagged(event, "SessionStateChanged") &&
                  (event.state === "archived" || event.state === "failed")
                )
                  registry.revokeSession(event.sessionId);
                const model = yield* store.model;
                registry.prune((id) => {
                  const session = model.sessions.get(id)?.session;

                  return (
                    session !== undefined &&
                    session.state !== "archived" &&
                    session.state !== "failed" &&
                    model.workspaces.has(session.workspaceId)
                  );
                });
              })
            ),
            Effect.forkScoped
          );
        }

        return registry;
      })
    );
  static readonly layer = InspectorTargets.layerAt();
}
