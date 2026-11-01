/**
 * The Spans a Client holds while the Polaris Workspace's Host is unreachable (ADR 0095): at most
 * 1 MiB or 5 minutes of them, dropping the oldest past either bound.
 */
import { SELF_TRACE_BATCH_BYTES, SELF_TRACE_BATCH_SPANS, type SelfSpan } from "@polaris/protocol";

export const SELF_TRACE_BUFFER_BYTES = 1024 * 1024;

export const SELF_TRACE_BUFFER_AGE_MS = 5 * 60_000;

/** Room left in a batch for `{"service":…,"spans":[…]}` around the Spans themselves. */
const BATCH_ENVELOPE_BYTES = 512;

export interface SelfTraceBufferLimits {
  readonly bytes: number;
  readonly ageMs: number;
}

export interface BufferedBatch {
  readonly service: string;
  readonly spans: ReadonlyArray<SelfSpan>;
  /** The entries this batch took; `ack` removes those still held. */
  readonly seqs: ReadonlySet<number>;
}

interface Entry {
  readonly seq: number;
  readonly service: string;
  readonly span: SelfSpan;
  readonly bytes: number;
  readonly at: number;
}

const encoder = new TextEncoder();

export const spanBytes = (span: SelfSpan): number =>
  encoder.encode(JSON.stringify(span)).byteLength;

export class SelfTraceBuffer {
  private entries: Array<Entry> = [];
  private held = 0;
  private nextSeq = 0;
  /** Spans dropped for either bound since the buffer was made. */
  dropped = 0;

  constructor(
    private readonly limits: SelfTraceBufferLimits = {
      bytes: SELF_TRACE_BUFFER_BYTES,
      ageMs: SELF_TRACE_BUFFER_AGE_MS,
    }
  ) {}

  get size(): number {
    return this.entries.length;
  }

  get bytes(): number {
    return this.held;
  }

  push(service: string, span: SelfSpan, now: number): void {
    const bytes = spanBytes(span);

    if (bytes > this.limits.bytes || bytes > SELF_TRACE_BATCH_BYTES - BATCH_ENVELOPE_BYTES) {
      this.dropped += 1;

      return;
    }

    this.entries.push({ seq: this.nextSeq++, service, span, bytes, at: now });
    this.held += bytes;
    this.expire(now);

    while (this.held > this.limits.bytes) this.dropFirst();
  }

  /** The oldest Spans of the oldest entry's service that fit one `traces.ingestSelf` call. */
  next(now: number): BufferedBatch | null {
    this.expire(now);
    const first = this.entries[0];

    if (first === undefined) return null;
    const spans: Array<SelfSpan> = [];
    const seqs = new Set<number>();
    let bytes = BATCH_ENVELOPE_BYTES;

    for (const entry of this.entries) {
      if (entry.service !== first.service) continue;

      if (spans.length === SELF_TRACE_BATCH_SPANS) break;

      if (bytes + entry.bytes + 1 > SELF_TRACE_BATCH_BYTES) break;
      bytes += entry.bytes + 1;
      spans.push(entry.span);
      seqs.add(entry.seq);
    }

    return { service: first.service, spans, seqs };
  }

  /** Removes a batch's Spans once they were delivered or refused for good. */
  ack(batch: BufferedBatch): void {
    this.entries = this.entries.filter((entry) => {
      if (!batch.seqs.has(entry.seq)) return true;
      this.held -= entry.bytes;

      return false;
    });
  }

  clear(): void {
    this.entries = [];
    this.held = 0;
  }

  private expire(now: number): void {
    const oldest = now - this.limits.ageMs;

    while (this.entries[0] !== undefined && this.entries[0].at < oldest) this.dropFirst();
  }

  private dropFirst(): void {
    const entry = this.entries.shift();

    if (entry === undefined) return;
    this.held -= entry.bytes;
    this.dropped += 1;
  }
}
