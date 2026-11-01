/**
 * A Tracer that records Spans only while Self-Traces are on: off, it makes the same native Spans
 * Effect makes without a backend, so nothing is kept or exported.
 */
import { Tracer } from "effect";

export interface GatedTracerOptions {
  readonly enabled: () => boolean;
  /** An ended, sampled Span that started while on. */
  readonly onEnd: (span: Tracer.Span) => void;
}

type SpanOptions = ConstructorParameters<typeof Tracer.NativeSpan>[0];

class RecordedSpan extends Tracer.NativeSpan {
  constructor(
    options: SpanOptions,
    private readonly onEnd: (span: Tracer.Span) => void
  ) {
    super(options);
  }

  override end(endTime: bigint, exit: Parameters<Tracer.Span["end"]>[1]): void {
    super.end(endTime, exit);

    if (this.sampled) this.onEnd(this);
  }
}

export const gatedTracer = ({ enabled, onEnd }: GatedTracerOptions): Tracer.Tracer =>
  Tracer.make({
    span: (options) =>
      enabled() ? new RecordedSpan(options, onEnd) : new Tracer.NativeSpan(options),
  });
