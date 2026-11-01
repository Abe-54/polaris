/**
 * The Mobile App's Self-Trace buffer (ADR 0095): at most 1 MiB or 5 minutes of finished Spans,
 * the oldest dropped first, taken out in batches that fit one `traces.ingestSelf`.
 */
import { SELF_TRACE_BATCH_BYTES, SELF_TRACE_BATCH_SPANS, type SelfSpan } from "@polaris/protocol";

export const SELF_TRACE_BUFFER_BYTES = 1024 * 1024;

export const SELF_TRACE_BUFFER_MS = 5 * 60_000;

/** Room in a batch for `{"service":"polaris-mobile","spans":[]}` and the commas. */
const BATCH_OVERHEAD_BYTES = 256;

/** The most a batch's Spans may take, so the batch stays under `SELF_TRACE_BATCH_BYTES`. */
export const BATCH_SPAN_BYTES = SELF_TRACE_BATCH_BYTES - BATCH_OVERHEAD_BYTES;

export interface BufferedSpan {
  readonly span: SelfSpan;
  /** Its JSON's UTF-8 length, counted once. */
  readonly bytes: number;
  /** When it was buffered (ms), which is what ages it out. */
  readonly at: number;
}

export interface SpanBuffer {
  readonly push: (span: SelfSpan, now: number) => void;
  /** Takes the oldest Spans that fit one batch, after dropping the expired ones. */
  readonly take: (now: number) => ReadonlyArray<BufferedSpan>;
  /** Puts a batch that wasn't sent back in front, then trims to the bounds again. */
  readonly restore: (batch: ReadonlyArray<BufferedSpan>, now: number) => void;
  readonly clear: () => void;
  readonly spans: () => number;
  readonly bytes: () => number;
}

/** UTF-8 length without TextEncoder, which older Hermes builds lack. */
export const utf8Length = (text: string): number => {
  let length = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      length += 4;
      index += 1;
    } else length += 3;
  }

  return length;
};

export interface SpanBufferLimits {
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
}

export const openSpanBuffer = (limits: SpanBufferLimits = {}): SpanBuffer => {
  const maxBytes = limits.maxBytes ?? SELF_TRACE_BUFFER_BYTES;
  const maxAgeMs = limits.maxAgeMs ?? SELF_TRACE_BUFFER_MS;
  let entries: Array<BufferedSpan> = [];
  let total = 0;

  const trim = (now: number) => {
    let drop = 0;

    while (
      drop < entries.length &&
      (total > maxBytes || now - (entries[drop]?.at ?? now) > maxAgeMs)
    ) {
      total -= entries[drop]?.bytes ?? 0;
      drop += 1;
    }

    if (drop > 0) entries = entries.slice(drop);
  };

  return {
    push: (span, now) => {
      const bytes = utf8Length(JSON.stringify(span));

      // One that could never fit a batch is never sent; keeping it would only push others out.
      if (bytes > BATCH_SPAN_BYTES) return;
      entries.push({ span, bytes, at: now });
      total += bytes;
      trim(now);
    },
    take: (now) => {
      trim(now);
      let count = 0;
      let size = 0;

      while (count < entries.length && count < SELF_TRACE_BATCH_SPANS) {
        const next = (entries[count]?.bytes ?? 0) + 1;

        if (size + next > BATCH_SPAN_BYTES) break;
        size += next;
        count += 1;
      }

      const batch = entries.slice(0, count);
      entries = entries.slice(count);

      for (const entry of batch) total -= entry.bytes;

      return batch;
    },
    restore: (batch, now) => {
      entries = [...batch, ...entries];

      for (const entry of batch) total += entry.bytes;
      trim(now);
    },
    clear: () => {
      entries = [];
      total = 0;
    },
    spans: () => entries.length,
    bytes: () => total,
  };
};
