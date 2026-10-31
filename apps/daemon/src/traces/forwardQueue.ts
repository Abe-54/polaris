import type { WorkspaceId } from "@polaris/protocol";

export interface ForwardRequest {
  readonly workspaceId: WorkspaceId;
  readonly url: string;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
}

export interface ForwardQueueOptions {
  readonly maxBytes?: number;
  readonly maxItems?: number;
  readonly timeoutMs?: number;
  readonly retryMs?: number;
  readonly maxAttempts?: number;
}

type Pending = { request: ForwardRequest; attempts: number; size: number };

/** Raw requests live only in this bounded queue; failures never reach the storage path. */
export class ForwardQueue {
  private pending: Pending[] = [];
  private bytes = 0;
  private active: { item: Pending; controller: AbortController } | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private dropped = 0;
  private failed = 0;
  private delivered = 0;

  constructor(private readonly options: ForwardQueueOptions = {}) {}

  get stats() {
    return {
      queued: this.pending.length,
      bytes: this.bytes,
      dropped: this.dropped,
      failed: this.failed,
      delivered: this.delivered,
    };
  }

  enqueue(request: ForwardRequest) {
    if (this.closed) return;
    let size = request.bytes.byteLength + request.url.length * 2;
    request.headers.forEach((value, key) => {
      size += (key.length + value.length) * 2;
    });
    const maxBytes = this.options.maxBytes ?? 8 * 1024 * 1024;
    const maxItems = this.options.maxItems ?? 32;

    if (size > maxBytes) {
      this.dropped++;

      return;
    }

    while (this.pending.length >= maxItems || this.bytes + size > maxBytes) {
      const oldest = this.pending[0];

      if (oldest === undefined) break;
      this.remove(oldest);

      if (this.active?.item === oldest) this.active.controller.abort();
      this.dropped++;
    }

    this.pending.push({ request, attempts: 0, size });
    this.bytes += size;
    this.pump();
  }

  cancel(workspaceId: WorkspaceId) {
    for (const item of this.pending.filter((entry) => entry.request.workspaceId === workspaceId)) {
      this.remove(item);

      if (this.active?.item === item) this.active.controller.abort();
    }

    if (this.pending.length === 0) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.pending = [];
    this.bytes = 0;
    this.active?.controller.abort();
  }

  private remove(item: Pending) {
    const index = this.pending.indexOf(item);

    if (index < 0) return;
    this.pending.splice(index, 1);
    this.bytes -= item.size;
  }

  private pump() {
    if (this.closed || this.active !== null || this.retry !== undefined) return;
    const item = this.pending[0];

    if (item === undefined) return;
    const controller = new AbortController();
    this.active = { item, controller };
    void this.send(item, controller);
  }

  private async send(item: Pending, controller: AbortController) {
    const deadline = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    deadline.unref();
    let retry = false;

    try {
      item.attempts++;

      const response = await fetch(item.request.url, {
        method: "POST",
        body: item.request.bytes,
        headers: item.request.headers,
        redirect: "manual",
        signal: controller.signal,
      });

      await response.body?.cancel();

      if (response.ok) this.delivered++;
      else {
        this.failed++;
        retry = response.status === 429 || response.status >= 500;
      }
    } catch {
      this.failed++;
      retry = true;
    } finally {
      clearTimeout(deadline);
      this.active = null;
    }

    if (!this.pending.includes(item)) {
      this.pump();

      return;
    }

    if (retry && item.attempts < (this.options.maxAttempts ?? 5) && !this.closed) {
      this.retry = setTimeout(
        () => {
          this.retry = undefined;
          this.pump();
        },
        Math.min((this.options.retryMs ?? 250) * 2 ** (item.attempts - 1), 30_000)
      );
      this.retry.unref();

      return;
    }

    this.remove(item);

    if (retry) this.dropped++;
    this.pump();
  }
}

/** Preserve application headers, excluding connection framing and hop-by-hop fields. */
export const forwardHeaders = (incoming: Headers, configured: Readonly<Record<string, string>>) => {
  const headers = new Headers(configured);
  incoming.forEach((value, key) => headers.set(key, value));
  const connection = headers.get("connection")?.split(",") ?? [];

  for (const key of [
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    ...connection,
  ])
    headers.delete(key.trim());

  return headers;
};
