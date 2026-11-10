import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

/** How a Turn ends when every message sent for it is answered. */
export interface TurnOutcome {
  readonly status: "completed" | "failed";
  readonly error: string | null;
}

export const resultOutcome = (result: SDKResultMessage): TurnOutcome => {
  if (result.subtype === "success")
    return result.is_error
      ? { status: "failed", error: result.result || "Claude reported an error" }
      : { status: "completed", error: null };

  return {
    status: "failed",
    error: result.errors.length > 0 ? result.errors.join("\n") : result.subtype,
  };
};
