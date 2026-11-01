import { Schema } from "effect";
import { attachError } from "./target.ts";

const Reply = Schema.Struct({
  id: Schema.optionalKey(Schema.Int),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Reply));

const Identity = Schema.Struct({
  result: Schema.Struct({
    value: Schema.Struct({
      pid: Schema.Int,
      node: Schema.String,
      bun: Schema.Boolean,
    }),
  }),
});

const ProfileResult = Schema.Struct({ profile: Schema.Unknown });

/** The only remote commands are identity, Profiler.enable/start/stop. The target owns shutdown. */
export class ProfileConnection {
  private readonly socket: WebSocket;
  private serial = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: (typeof Reply.Type)["result"]) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly ready: Promise<void>;
  readonly disconnected: Promise<void>;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(attachError("Inspector connection timed out."));
        this.close();
      }, 5000);

      this.socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };

      this.socket.onerror = () => {
        clearTimeout(timer);
        reject(attachError("Inspector connection failed."));
        this.close();
      };
    });
    this.disconnected = new Promise((resolve) => {
      this.socket.onclose = () => {
        this.rejectPending();
        resolve();
      };
    });
    this.socket.onmessage = (event) => {
      try {
        const text = Schema.decodeUnknownSync(
          Schema.String.check(Schema.isMaxLength(64 * 1024 * 1024))
        )(event.data);

        const reply = decode(text);

        if (reply.id === undefined) return;
        const pending = this.pending.get(reply.id);

        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(reply.id);

        if (reply.error !== undefined)
          pending.reject(attachError("The inspector refused a profiler command."));
        else pending.resolve(reply.result);
      } catch {
        this.close();
      }
    };
  }

  private rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(attachError("The inspector connection closed."));
    }

    this.pending.clear();
  }

  private send(method: string, params = {}) {
    const id = ++this.serial;

    return new Promise<(typeof Reply.Type)["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(attachError("The inspector did not answer in time."));
      }, 5000);

      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async start(pid: number) {
    await this.ready;

    const identity = Schema.decodeUnknownSync(Identity)(
      await this.send("Runtime.evaluate", {
        expression:
          "({ pid: process.pid, node: process.versions.node, bun: !!process.versions.bun })",
        returnByValue: true,
      })
    ).result.value;

    if (identity.pid !== pid || identity.bun)
      throw attachError("The inspector belongs to another runtime or process.");
    await this.send("Profiler.enable");
    await this.send("Profiler.start");
  }

  async stop() {
    return Schema.decodeUnknownSync(ProfileResult)(await this.send("Profiler.stop")).profile;
  }

  close() {
    this.rejectPending();
    this.socket.close();
  }
}
