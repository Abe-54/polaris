/**
 * Batches a process's Self-Trace Spans and sends them with `traces.ingestSelf` (ADR 0095). While
 * off it holds nothing and arms no timer; while the Host is unreachable it buffers within bounds.
 */
import type { SelfSpan, SelfTraceBatch } from "@polaris/protocol";
import { type BufferedBatch, SelfTraceBuffer, type SelfTraceBufferLimits } from "./buffer.ts";

/** `sent`: delivered. `unreachable`: keep and retry. `dropped`: refused for good. */
export type SelfTraceSendOutcome = "sent" | "unreachable" | "dropped";

/** Cancels a pending timer. */
export type CancelTimer = () => void;

export interface SelfTraceClock {
  readonly now: () => number;
  readonly setTimeout: (run: () => void, ms: number) => CancelTimer;
}

export const DEFAULT_FLUSH_DELAY_MS = 1_000;

export interface SelfTraceExporterOptions {
  readonly send: (batch: SelfTraceBatch) => Promise<SelfTraceSendOutcome>;
  readonly clock?: SelfTraceClock;
  /** How long a first Span waits for others to join its batch. */
  readonly flushDelayMs?: number;
  readonly retryMs?: { readonly initial: number; readonly max: number };
  readonly limits?: SelfTraceBufferLimits;
}

export interface SelfTraceExporter {
  readonly enabled: () => boolean;
  /** Off drops every held Span and cancels the pending flush. */
  readonly setEnabled: (on: boolean) => void;
  /** Ignored while off. */
  readonly record: (service: string, span: SelfSpan) => void;
  /** Sends what is held now, as the timer would. */
  readonly flush: () => Promise<void>;
  readonly held: () => { readonly spans: number; readonly bytes: number; readonly dropped: number };
}

export const systemClock: SelfTraceClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms);

    return () => clearTimeout(handle);
  },
};

const RETRY = { initial: 2_000, max: 60_000 };

export const makeSelfTraceExporter = ({
  send,
  clock = systemClock,
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  retryMs = RETRY,
  limits,
}: SelfTraceExporterOptions): SelfTraceExporter => {
  const buffer = new SelfTraceBuffer(limits);
  let on = false;
  let cancelTimer: CancelTimer | null = null;
  let inFlight = false;
  let retry = retryMs.initial;

  const cancel = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  const schedule = (ms: number) => {
    if (cancelTimer !== null || inFlight || !on || buffer.size === 0) return;
    cancelTimer = clock.setTimeout(() => {
      cancelTimer = null;
      void flush();
    }, ms);
  };

  const deliver = async (batch: BufferedBatch): Promise<SelfTraceSendOutcome> => {
    try {
      return await send({ service: batch.service, spans: batch.spans });
    } catch {
      return "unreachable";
    }
  };

  const flush = async (): Promise<void> => {
    cancel();

    if (!on || inFlight) return;
    const batch = buffer.next(clock.now());

    if (batch === null) return;
    inFlight = true;
    const outcome = await deliver(batch);
    inFlight = false;

    if (!on) return;

    if (outcome === "unreachable") {
      schedule(retry);
      retry = Math.min(retry * 2, retryMs.max);

      return;
    }

    retry = retryMs.initial;
    buffer.ack(batch);
    schedule(0);
  };

  return {
    enabled: () => on,
    setEnabled: (next) => {
      on = next;

      if (next) return;
      cancel();
      buffer.clear();
      retry = retryMs.initial;
    },
    record: (service, span) => {
      if (!on) return;
      buffer.push(service, span, clock.now());
      schedule(flushDelayMs);
    },
    flush,
    held: () => ({ spans: buffer.size, bytes: buffer.bytes, dropped: buffer.dropped }),
  };
};
