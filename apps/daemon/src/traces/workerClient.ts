import { Match, Schema } from "effect";
import { TraceError } from "@polaris/protocol";
import { isEmbeddedPath } from "../platform/detect.ts";
import { TraceWorkerReply, TraceWorkerRequest, type TraceWorkerValue } from "./workerProtocol.ts";
import { SELF_RETENTION } from "./self/scope.ts";

export interface TraceWorkerOptions {
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  /** The Self-Trace byte budget; tests lower it. Its 24 h age limit is fixed. */
  readonly selfMaxBytes?: number;
  readonly flushMs?: number;
  readonly quietMs?: number;
}

export class WorkerFailure extends Error {
  constructor(
    readonly status: number,
    readonly error: TraceError
  ) {
    super(error.message);
  }
}

const unavailable = () =>
  new WorkerFailure(
    503,
    new TraceError({
      code: "E-TRACE-UNAVAILABLE",
      message: "The trace worker is unavailable.",
      fix: "Retry the request; check the Daemon's storage if it persists.",
    })
  );

const workerUrl = () => {
  const beside = new URL("./worker.ts", import.meta.url);

  return isEmbeddedPath(beside.pathname)
    ? new URL("./traces/worker.js", import.meta.url).href
    : beside.href;
};

const decodeReply = Schema.decodeUnknownSync(TraceWorkerReply);

/** One worker per service, allocated on demand and closed after 30 seconds without requests. */
export class TraceWorkerClient {
  private worker: Worker | null = null;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 0;
  private disposed = false;
  private pending = new Map<
    number,
    { resolve: (value: TraceWorkerValue) => void; reject: (error: WorkerFailure) => void }
  >();

  constructor(
    readonly filename: string,
    readonly options: TraceWorkerOptions,
    readonly changed: () => void,
    readonly retired: () => void = () => {}
  ) {}

  get running(): boolean {
    return this.worker !== null;
  }

  private armQuiet(): void {
    if (this.pending.size !== 0 || this.closing !== null) return;
    this.worker?.unref();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.stop().catch(() => {});
    }, this.options.quietMs ?? 30_000);
    this.timer.unref();
  }

  private fail(): void {
    const error = unavailable();

    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    clearTimeout(this.timer);
    this.changed();
  }

  private receive(reply: TraceWorkerReply): void {
    Match.value(reply).pipe(
      Match.tag("Changed", () => this.changed()),
      Match.tag("Success", (message) => {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        waiter?.resolve(message.value);
        this.armQuiet();
      }),
      Match.tag("Failure", (message) => {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        waiter?.reject(new WorkerFailure(message.status, new TraceError(message.error)));
        this.armQuiet();
      }),
      Match.exhaustive
    );
  }

  private send(request: TraceWorkerRequest): Promise<TraceWorkerValue> {
    if (this.worker === null) return Promise.reject(unavailable());

    if (this.pending.size >= 32) return Promise.reject(new WorkerFailure(429, unavailable().error));
    clearTimeout(this.timer);
    this.worker.ref();
    const id = ++this.nextId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      try {
        this.worker!.postMessage({ id, request });
      } catch {
        this.fail();
      }
    });
  }

  private async connect(): Promise<void> {
    if (this.disposed) throw unavailable();

    if (this.closing !== null) await this.closing;

    if (this.opening !== null) return this.opening;

    if (this.worker !== null) return;

    this.worker = new Worker(workerUrl());
    this.worker.addEventListener("close", () => this.retired(), { once: true });
    this.worker.onmessage = (event: MessageEvent<unknown>) => {
      try {
        this.receive(decodeReply(event.data));
      } catch {
        this.fail();
      }
    };

    this.worker.onerror = () => this.fail();
    this.opening = this.send(
      TraceWorkerRequest.cases.Open.make({
        filename: this.filename,
        maxBytes: this.options.maxBytes ?? 200 * 1024 * 1024,
        maxAgeMs: this.options.maxAgeMs ?? 7 * 86400_000,
        flushMs: this.options.flushMs ?? 25,
        selfMaxBytes: this.options.selfMaxBytes ?? SELF_RETENTION.maxBytes,
      })
    ).then(() => {});

    try {
      await this.opening;
    } catch (error) {
      this.fail();
      throw error;
    } finally {
      this.opening = null;
    }
  }

  async request(request: TraceWorkerRequest): Promise<TraceWorkerValue> {
    await this.connect();

    return this.send(request);
  }

  private async stop(): Promise<void> {
    if (this.worker === null || this.closing !== null) return this.closing ?? undefined;
    clearTimeout(this.timer);
    const worker = this.worker;
    this.closing = this.send(TraceWorkerRequest.cases.Close.make({})).then(() => {});

    try {
      await this.closing;
    } catch (error) {
      this.closing = null;

      if (!this.disposed) {
        this.armQuiet();
        throw error;
      }
    }

    worker.terminate();
    this.worker = null;
    this.closing = null;
    clearTimeout(this.timer);
  }

  async close(): Promise<void> {
    this.disposed = true;

    if (this.opening !== null) await this.opening.catch(() => {});
    await this.stop();
  }
}
