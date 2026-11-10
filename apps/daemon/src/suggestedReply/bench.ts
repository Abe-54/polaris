import { Effect, Schema } from "effect";
import { HarnessError } from "../harness/HarnessDriver.ts";
import type { ReplyBackend } from "./backend.ts";
import { decodeAnswer } from "./prompt.ts";

/** `model: "bench:{...}"` scripts the answer, a delay (for cancellation) or a failure. */
const Script = Schema.Struct({
  answer: Schema.optionalKey(Schema.Unknown),
  delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  fail: Schema.optionalKey(Schema.String),
});

export const benchReply: ReplyBackend = Effect.fn("suggestedReply.bench")(function* (harness, job) {
  const script = job.model?.startsWith("bench:")
    ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Script))(job.model.slice(6)).pipe(
        Effect.mapError(() => new HarnessError({ harness, message: "Invalid bench script" }))
      )
    : {};

  yield* Effect.sleep(script.delayMs ?? 0);

  if (script.fail !== undefined) return yield* new HarnessError({ harness, message: script.fail });

  return yield* decodeAnswer(harness)(script.answer ?? { reply: "Go ahead." });
});
