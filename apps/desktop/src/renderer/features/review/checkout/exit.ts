/**
 * A terminal's end, followed even while no drawer shows it: the drawer only listens to the
 * terminals it renders, and a clone or a run must still learn its exit code.
 */
import type { TerminalId } from "@polaris/protocol";
import { Predicate } from "effect";
import { polaris } from "../../bridge.ts";
import { applyStatus } from "../../terminal/store.ts";

export interface FollowHooks {
  /** Any other end of the feed, such as the Host dropping; no exit arrives after it. */
  readonly onLost?: () => void;
  /** Each chunk the terminal prints before it exits. */
  readonly onOutput?: (data: Uint8Array) => void;
}

/** Calls `onExit` once with the exit code (null: the Host no longer knows the terminal). */
export const followExit = (
  hostKey: string,
  terminalId: string,
  onExit: (code: number | null) => void,
  hooks: FollowHooks = {}
) => {
  let done = false;

  const finish = (code: number | null) => {
    if (done) return;
    done = true;
    applyStatus(terminalId, { kind: "exited", code });
    onExit(code);
  };

  const off = polaris().subscribe(
    "terminal",
    // SAFETY: terminal ids come from `terminal.open` answers.
    { hostKey, terminalId: terminalId as TerminalId },
    {
      items: (items) => {
        for (const item of items)
          if (Predicate.isTagged(item, "Output")) hooks.onOutput?.(item.data);
          else finish(item.code);

        if (done) off();
      },
      end: (error) => {
        if (error?.code === "NotFound") return finish(null);

        if (!done) hooks.onLost?.();
      },
    }
  );

  return off;
};
