/**
 * Steers on Codex, as Turn items. Codex answers `turn/steer` and reports the steer as
 * a `userMessage` item as soon as it queues it; the first of the two queues it, the
 * other is dropped. The model reads it only when it next samples, which a running
 * command can hold off, so it lands when the Turn's next item starts or the Turn ends.
 * A Turn's first user message is its prompt, not a steer. A steer with attachments
 * shows as the user sent it: its own text, without the files' note, and its attachments.
 */
import type { Attachment, TurnItem } from "@polaris/protocol";
import { steerItem } from "../userMessage.ts";

type Source = "item" | "response";

interface Awaiting {
  readonly source: Source;
  readonly id: string;
  readonly text: string;
}

/** A steer as the user wrote it, where what Codex got differs (it carried attachments). */
export interface SteerShown {
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
}

export class CodexSteers {
  /** Per Codex turn: the ids of its user message items seen so far. */
  private readonly messages = new Map<string, Set<string>>();
  /** Per Codex turn: steer texts recorded by one source, awaiting the other. */
  private readonly awaiting = new Map<string, Array<Awaiting>>();
  /** Per Codex turn: steers Codex took that the model hasn't read yet. */
  private readonly queued = new Map<string, Array<TurnItem>>();
  private count = 0;

  /** A `userMessage` item of a turn: queued as a steer unless it is the prompt or seen. */
  fromItem(codexTurnId: string, itemId: string, text: string | null) {
    const seen = this.messages.get(codexTurnId) ?? new Set<string>();
    const first = seen.size === 0;

    this.messages.set(codexTurnId, seen);

    if (seen.has(itemId)) return;
    seen.add(itemId);

    if (first || text === null) return;
    this.record(codexTurnId, "item", itemId, text, null);
  }

  /** `turn/steer` answered: queued, unless the Turn already reported it. `text` is what Codex got. */
  fromResponse(codexTurnId: string, text: string, shown: SteerShown | null = null) {
    this.count += 1;
    this.record(codexTurnId, "response", `steer:${codexTurnId}:${this.count}`, text, shown);
  }

  /** Another item of the Turn started: the model has read every steer queued before it. */
  take(codexTurnId: string): ReadonlyArray<TurnItem> {
    const queued = this.queued.get(codexTurnId) ?? [];
    this.queued.delete(codexTurnId);

    return queued;
  }

  /** The Turn ended: the steers still queued (it read them last), and the Turn forgotten. */
  end(codexTurnId: string): ReadonlyArray<TurnItem> {
    const queued = this.take(codexTurnId);
    this.messages.delete(codexTurnId);
    this.awaiting.delete(codexTurnId);

    return queued;
  }

  private record(
    codexTurnId: string,
    source: Source,
    id: string,
    text: string,
    shown: SteerShown | null
  ) {
    const waiting = this.awaiting.get(codexTurnId) ?? [];
    const match = waiting.findIndex((w) => w.source !== source && w.text === text);
    const queued = this.queued.get(codexTurnId) ?? [];

    if (match !== -1) {
      const [other] = waiting.splice(match, 1);

      // Codex's item came first: it shows as the user sent it, if the model hasn't read it yet.
      if (shown !== null && other !== undefined)
        this.queued.set(
          codexTurnId,
          queued.map((item) =>
            item.id === other.id ? steerItem(other.id, shown.text, shown.attachments) : item
          )
        );

      return;
    }

    this.awaiting.set(codexTurnId, [...waiting, { source, id, text }]);
    const item = steerItem(id, shown?.text ?? text, shown?.attachments);
    this.queued.set(codexTurnId, [...queued, item]);
  }
}
