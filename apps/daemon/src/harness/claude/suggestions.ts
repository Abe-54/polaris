import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { TurnId } from "@polaris/protocol";
import { HarnessEvent } from "../HarnessDriver.ts";

const started = HarnessEvent.$is("TurnStarted");

const ended = HarnessEvent.$is("TurnEnded");

/**
 * Claude Code's own Suggested Replies (`promptSuggestions`, ADR 0106). It sends at most one
 * per Turn, after `result`, so it follows the Turn's end and is stale once a newer Turn starts.
 */
export class ReplySuggestions {
  /** The preference as the running Turn started. */
  private wanted = false;
  /** The last ended Turn, until a newer Turn starts or it takes its suggestion. */
  private open: TurnId | null = null;

  constructor(private readonly enabled: () => boolean = () => false) {}

  /** The query option: fixed for the query's life, absent while the preference is off. */
  option(): Pick<Options, "promptSuggestions"> {
    return this.enabled() ? { promptSuggestions: true } : {};
  }

  /** Follows the session's Turns through the events the driver emits. */
  observe(event: HarnessEvent): HarnessEvent {
    if (started(event)) {
      this.wanted = this.enabled();
      this.open = null;
    } else if (ended(event)) {
      this.open = event.status === "completed" && this.wanted ? event.turnId : null;
    }

    return event;
  }

  /** Claude Code's suggestion, as the event for the Turn it follows, if that Turn may take it. */
  take(text: string): ReadonlyArray<HarnessEvent> {
    const turnId = this.open;
    this.open = null;

    if (turnId === null || text.trim() === "") return [];

    return [HarnessEvent.ReplySuggested({ turnId, text })];
  }
}
