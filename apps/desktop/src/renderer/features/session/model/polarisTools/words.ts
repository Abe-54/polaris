/** The small phrases every Polaris row is built from: counts, workers, quotes, checks. */
import { harnessEntry } from "@polaris/protocol";
import { Predicate } from "effect";
import type { Receipt, Worker } from "./inputs.ts";
import type { CheckMark, Segment } from "./types.ts";

export { plural as count } from "../format.ts";

export const clip = (text: string, max = 120) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** A sentence quoted on the row, as it was sent ("“Rebase on main…”"). */
export const quote = (text: string): Segment => ({ text: `“${clip(text.trim())}”` });

/** "B2, B3, B4"; "B2, B3, B4 and 3 more" past five. */
export const ids = (list: ReadonlyArray<string>) =>
  list.length <= 5 ? list.join(", ") : `${list.slice(0, 5).join(", ")} and ${list.length - 5} more`;

/** A commit head as git shows it short. */
export const shortHead = (head: string) =>
  /^[0-9a-f]{12,}$/i.test(head) ? head.slice(0, 7) : head;

export const harnessName = (kind: string) => harnessEntry(kind)?.name ?? kind;

/** Where a worker runs: "Codex · gpt-5.5 · devbox" behind its hue dot, or its session. */
export const workerSegments = (worker: typeof Worker.Type | undefined): ReadonlyArray<Segment> => {
  if (worker === undefined) return [];

  if (worker.session !== undefined)
    return [{ text: "in its session" }, { text: worker.session, mono: true }];
  const harness = worker.selection?.harness;

  const parts = [
    harness === undefined ? null : harnessName(harness),
    worker.selection?.model,
    worker.selection?.serviceTier === "priority" ? "fast mode" : null,
  ];

  const text = [...parts, worker.host].filter((part) => part != null && part !== "").join(" · ");

  if (text === "") return [];

  return [harness === undefined ? { text } : { text, hue: harness }];
};

/** A check receipt: verified from its command, or only reported (failed by its exit code). */
export const checkOf = (receipt: typeof Receipt.Type): CheckMark => {
  const label = receipt.label ?? "check";

  if (Predicate.isTagged(receipt, "Verified")) return { label, state: "passed" };

  const exit = receipt.exitCode;

  return { label, state: exit != null && exit !== 0 ? "failed" : "reported" };
};

export const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
