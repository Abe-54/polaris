import type { HarnessError } from "../harness/HarnessDriver.ts";
import type { StructuredJob } from "../inline/structured.ts";
import type { Effect, Scope } from "effect";
import type { ReplyAnswer } from "./prompt.ts";
import type { InlineHarness } from "./rules.ts";

/** Runs one structured job and decodes the Harness's answer at the boundary. */
export type ReplyBackend = (
  harness: InlineHarness,
  job: StructuredJob,
  cwd: string
) => Effect.Effect<ReplyAnswer, HarnessError, Scope.Scope>;
