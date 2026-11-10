/**
 * What a Working session is doing now, from its open feed: the item still in
 * progress ("Running bun test", "Editing index.ts", a plan's current step).
 * Null when the feed isn't open or nothing is in progress.
 */
import type { TurnItem } from "@polaris/protocol";
import { Match, Predicate } from "effect";
import { completedItemView } from "../features/session/model/items.ts";
import { toolActivity } from "../features/session/model/runs.ts";
import type { LiveItem, SessionModel } from "../store/sessionModel.ts";
import { desktopCallOf } from "../features/session/model/computerUse/index.ts";

type ToolCall = Extract<TurnItem, { readonly _tag: "ToolCall" }>;

/** A computer use call's app (Paper CU5's row line, "Using Simulator"). */
const desktopApp = (i: ToolCall): string => {
  const passed = Predicate.hasProperty(i.input, "app") ? i.input.app : null;

  return i.computerUse?.app?.name ?? (Predicate.isString(passed) ? passed : "an app");
};

const MAX = 80;

const clip = (text: string) => {
  const line = text.split("\n")[0]?.trim() ?? "";

  return line.length > MAX ? `${line.slice(0, MAX - 1)}…` : line;
};

const basename = (path: string) => path.split("/").at(-1) ?? path;

const itemActivity = (item: TurnItem): string | null =>
  Match.value(item).pipe(
    Match.tagsExhaustive({
      AssistantMessage: () => "Writing a reply…",
      UserMessage: () => null,
      Reasoning: () => "Thinking…",
      CommandExecution: (i) => `Running ${clip(i.command)}`,
      FileChange: (i) => {
        const first = i.changes[0];

        if (first === undefined) return "Editing files…";

        return i.changes.length === 1
          ? `Editing ${basename(first.path)}`
          : `Editing ${i.changes.length} files`;
      },
      ToolCall: (i) => {
        if (desktopCallOf(i) !== null) return `Using ${desktopApp(i)}`;

        const view = completedItemView(i);

        return clip(view.kind === "tool" ? toolActivity(view) : `Using ${i.name}`);
      },
      Plan: (i) => {
        const step = i.steps.find((s) => s.status === "in-progress");

        return step === undefined ? null : `${clip(step.text)}…`;
      },
      Error: () => null,
    })
  );

const liveActivity = (live: LiveItem): string | null => {
  if (live.item !== null) return itemActivity(live.item);

  return live.output !== "" ? "Running a command…" : "Writing a reply…";
};

export const activityOf = (model: SessionModel | undefined): string | null => {
  const turn = model?.turns.at(-1);

  if (turn === undefined || turn.turn.status !== "working") return null;
  const live = [...turn.live.values()].at(-1);

  return live === undefined ? null : liveActivity(live);
};
