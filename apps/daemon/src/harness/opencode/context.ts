/**
 * How full an OpenCode session's context window is, as `ContextUsed` (ENG-571). Each
 * `step-finish` part gives the tokens its model call carried; the window is the Model's
 * `limit.context` from `/config/providers`. A compaction writes its summary into an assistant
 * message marked `summary`: that call read the old window, so it isn't usage, and its output
 * is the new window's size until the next model call reports it.
 */
import { HarnessEvent } from "../HarnessDriver.ts";
import type * as P from "./protocol.ts";

type Tokens = P.StepFinishPart["tokens"];

type MessageInfo = typeof P.MessageInfo.Type;

interface ModelRef {
  readonly providerID: string;
  readonly modelID: string;
}

/** The tokens one model call carried, counted as OpenCode's TUI counts its context. */
export const contextTokens = (tokens: Tokens) =>
  tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;

const modelKey = (model: ModelRef) => `${model.providerID}/${model.modelID}`;

export class OpenCodeContext {
  private readonly windows = new Map<string, number>();
  private readonly summaries = new Set<string>();
  private model: ModelRef | null = null;
  private used: number | null = null;
  private compaction: {
    readonly trigger: "auto" | "manual" | null;
    readonly before: number | null;
    after: number | null;
  } | null = null;

  /** The context windows of every Model OpenCode lists. */
  setWindows(providers: P.ConfigProviders) {
    for (const provider of providers.providers)
      for (const model of Object.values(provider.models))
        if (model.limit !== undefined && model.limit.context > 0)
          this.windows.set(
            modelKey({ providerID: provider.id, modelID: model.id }),
            model.limit.context
          );
  }

  /** An assistant message: the Model it ran on, and whether it holds a compaction's summary. */
  assistantMessage(info: MessageInfo) {
    if (info.providerID !== undefined && info.modelID !== undefined)
      this.model = { providerID: info.providerID, modelID: info.modelID };

    if (info.summary === true) this.summaries.add(info.id);
  }

  /** The Model of the latest assistant message; null before the first. */
  lastModel(): ModelRef | null {
    return this.model;
  }

  /** A model call finished: the window it carried, or null for a summary's call. */
  stepFinished(part: P.StepFinishPart) {
    if (this.summaries.has(part.messageID)) {
      if (this.compaction !== null) this.compaction.after = part.tokens.output;

      return null;
    }

    this.used = contextTokens(part.tokens);

    return HarnessEvent.ContextUsed({ usedTokens: this.used, windowTokens: this.window() });
  }

  /** A compaction's user message: `/compact` (manual) or OpenCode's own on a full window. */
  compactionStarted(auto: boolean) {
    this.compaction = { trigger: auto ? "auto" : "manual", before: this.used, after: null };
  }

  /** `session.compacted`: the report, or null when no summary's size was seen. */
  compacted() {
    const compaction = this.compaction ?? { trigger: null, before: this.used, after: null };
    this.compaction = null;

    if (compaction.after === null) return null;
    this.used = compaction.after;

    return HarnessEvent.ContextUsed({
      usedTokens: compaction.after,
      windowTokens: this.window(),
      compacted: {
        trigger: compaction.trigger,
        beforeTokens: compaction.before,
        afterTokens: compaction.after,
      },
    });
  }

  private window(): number | null {
    return this.model === null ? null : (this.windows.get(modelKey(this.model)) ?? null);
  }
}
