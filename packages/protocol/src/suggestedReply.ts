/**
 * Suggested Replies (ENG-884, ADR 0106): a whole reply the composer offers when a Turn ends.
 * The Harness writes it when it has its own; otherwise the Daemon does with the fallback
 * chosen in Settings. Either way it is a `SessionReplySuggested` event in the session's log,
 * folded into `AgentSession.suggestedReply` until a newer Turn starts.
 */
import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Unsupported } from "./errors.ts";
import { FileError } from "./files.ts";
import { HarnessKind } from "./harnesses.ts";
import { TurnId } from "./ids.ts";
import { ModelId, ReasoningEffort } from "./models.ts";

/** Who wrote it: the session's own Harness, or Polaris with the Settings fallback. */
export const SuggestedReplySource = Schema.Literals(["harness", "polaris"]);

export type SuggestedReplySource = typeof SuggestedReplySource.Type;

export class SuggestedReply extends Schema.Class<SuggestedReply>("SuggestedReply")({
  /** The Turn it follows; it is stale once a newer Turn starts. */
  turnId: TurnId,
  text: Schema.String,
  source: SuggestedReplySource,
}) {}

/** The Harness, Model and effort the Daemon writes fallback suggestions with. */
export class SuggestedReplyFallback extends Schema.Class<SuggestedReplyFallback>(
  "SuggestedReplyFallback"
)({
  harness: HarnessKind,
  model: Schema.NullOr(ModelId),
  effort: Schema.NullOr(ReasoningEffort),
}) {}

/** The automatic fallbacks, first ready wins: Codex's small model, then Claude Haiku. */
export const AUTO_SUGGESTED_REPLY_FALLBACKS: ReadonlyArray<SuggestedReplyFallback> = [
  SuggestedReplyFallback.make({ harness: "codex", model: "gpt-6-luna", effort: "low" }),
  SuggestedReplyFallback.make({ harness: "claude", model: "claude-haiku-5-5", effort: null }),
];

/** The Host preference (capability `sessions.suggested-replies`). */
export class SuggestedReplySettings extends Schema.Class<SuggestedReplySettings>(
  "SuggestedReplySettings"
)({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false))
  ),
  /** Null picks the first ready of `AUTO_SUGGESTED_REPLY_FALLBACKS` on the Daemon. */
  fallback: Schema.NullOr(SuggestedReplyFallback).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null))
  ),
}) {}

export const DEFAULT_SUGGESTED_REPLY_SETTINGS = SuggestedReplySettings.make({});

/** The fallback the Daemon would use now; `choice` is null when no Harness for it is ready. */
export class ResolvedSuggestedReplyFallback extends Schema.Class<ResolvedSuggestedReplyFallback>(
  "ResolvedSuggestedReplyFallback"
)({
  choice: Schema.NullOr(SuggestedReplyFallback),
  source: Schema.Literals(["settings", "auto"]),
}) {}

/** This Host's preference and the fallback it resolves to (capability `sessions.suggested-replies`). */
export const GetSuggestedReplySettings = Rpc.make("sessions.suggestedReplies", {
  payload: {},
  success: Schema.Struct({
    settings: SuggestedReplySettings,
    resolved: ResolvedSuggestedReplyFallback,
  }),
  error: Unsupported,
});

/** Replaces the Host's preference; it applies from the next ended Turn. */
export const SetSuggestedReplySettings = Rpc.make("sessions.setSuggestedReplies", {
  payload: { settings: SuggestedReplySettings },
  error: Schema.Union([Unsupported, FileError]),
});

export class SuggestedReplyRpcs extends RpcGroup.make(
  GetSuggestedReplySettings,
  SetSuggestedReplySettings
) {}
