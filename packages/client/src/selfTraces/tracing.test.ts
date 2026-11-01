import { describe, expect, test } from "bun:test";
import { type ByteTransport, makeWire, type TransportError } from "@polaris/protocol";
import { type Cause, Effect, Predicate, Queue, Schema, Stream, type Tracer } from "effect";
import { connectRpc } from "../rpc.ts";
import { selfSpanOf } from "./span.ts";
import { gatedTracer } from "./tracer.ts";

const origin = { service: "polaris-desktop-main", version: "1.0.0", scope: "@polaris/desktop" };

const recorder = (on: { value: boolean }) => {
  const ended: Array<Tracer.Span> = [];

  return { ended, tracer: gatedTracer({ enabled: () => on.value, onEnd: (s) => ended.push(s) }) };
};

describe("gated Tracer", () => {
  test("records ended Spans with their parent and failure only while on", async () => {
    const on = { value: true };
    const { ended, tracer } = recorder(on);

    const program = Effect.fail(new Error("boom")).pipe(
      Effect.withSpan("child"),
      Effect.withSpan("parent"),
      Effect.ignore,
      Effect.withTracer(tracer)
    );

    await Effect.runPromise(program);
    const [child, parent] = ended.map((span) => selfSpanOf(span, origin));

    expect(child?.name).toBe("child");
    expect(child?.parentId).toBe(parent?.id ?? "missing");
    expect(child?.traceId).toBe(parent?.traceId ?? "missing");
    expect(child?.status).toBe("error");
    expect(child?.statusMessage).toBe("boom");
    expect(parent?.resource["service.name"]).toBe("polaris-desktop-main");

    on.value = false;
    await Effect.runPromise(program);

    expect(ended).toHaveLength(2);
  });
});

const Sent = Schema.Struct({
  _tag: Schema.String,
  tag: Schema.optional(Schema.String),
  traceId: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
});

const decodeSent = Schema.decodeUnknownSync(Schema.fromJsonString(Sent));

type Pipe = Queue.Queue<Uint8Array, TransportError | Cause.Done>;

/** Sends one request to a peer that never answers, and returns the request as the peer read it. */
const sentRequest = (on: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const toPeer: Pipe = yield* Queue.unbounded<Uint8Array, TransportError | Cause.Done>();
      const toClient: Pipe = yield* Queue.unbounded<Uint8Array, TransportError | Cause.Done>();

      const side = (inbox: Pipe, outbox: Pipe): ByteTransport => ({
        incoming: Stream.fromQueue(inbox),
        write: (bytes) => Effect.sync(() => Queue.offerUnsafe(outbox, bytes)),
        close: Effect.sync(() => Queue.endUnsafe(outbox)),
      });

      const received: Array<typeof Sent.Type> = [];

      yield* makeWire(side(toPeer, toClient), (text) =>
        Effect.sync(() => void received.push(decodeSent(text)))
      );
      const transport = { ...side(toClient, toPeer), diagnose: Effect.die("unused") };
      const connection = yield* connectRpc(transport, { traceContext: () => on });
      const { tracer } = recorder({ value: on });
      const caller = { traceId: "" };

      yield* Effect.gen(function* () {
        caller.traceId = (yield* Effect.currentSpan).traceId;
        yield* connection.client["developerMode.get"]({});
      }).pipe(Effect.withSpan("composer.send"), Effect.withTracer(tracer), Effect.forkScoped);
      yield* Effect.sleep(50);

      return {
        request: received.find((message): boolean => Predicate.isTagged(message, "Request")),
        caller,
      };
    })
  );

describe("trace context on the wire", () => {
  test("while on, a request carries its RPC Span as traceparent, in the caller's Trace", async () => {
    const { request, caller } = await Effect.runPromise(sentRequest(true));
    const traceparent = request?.headers?.find(([name]) => name === "traceparent")?.[1];

    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(traceparent?.slice(3, 35)).toBe(caller.traceId);
  });

  test("while off, a request carries no trace context at all", async () => {
    const { request } = await Effect.runPromise(sentRequest(false));

    expect(request?.tag).toBe("developerMode.get");
    expect(request?.headers?.some(([name]) => name.startsWith("trace"))).toBe(false);
    expect(request?.traceId).toBeUndefined();
  });
});
