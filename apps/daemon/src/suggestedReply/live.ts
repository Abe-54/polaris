import { Effect } from "effect";
import { HarnessError } from "../harness/HarnessDriver.ts";
import { connectStdio } from "../harness/codex/RpcConnection.ts";
import { claudeStructured } from "../inline/claude.ts";
import { codexStructured } from "../inline/codex.ts";
import { harnessBinary } from "../inline/live.ts";
import type { ReplyBackend } from "./backend.ts";
import { decodeAnswer, decodeAnswerText } from "./prompt.ts";

const quiet = () => Effect.void;

export const liveReply: ReplyBackend = Effect.fn("suggestedReply.live")(
  function* (harness, job, cwd) {
    const binary = harnessBinary(harness);

    if (!binary)
      return yield* new HarnessError({ harness, message: `${harness} was not found on PATH` });

    return harness === "claude"
      ? yield* decodeAnswer(harness)(yield* claudeStructured(binary, job, cwd, quiet))
      : yield* decodeAnswerText(yield* codexStructured(connectStdio(binary), job, cwd, quiet));
  }
);
