/**
 * A session's computer use, from its open feed: which run is its latest (only that one shows
 * the Host's window, which is always the session's last), and that run for the sidebar peek.
 */
import type { TurnItem } from "@polaris/protocol";
import type { SessionModel, TurnView } from "../../../../store/sessionModel.ts";
import { completedItemView, liveItemView } from "../items.ts";
import {
  type DesktopItem,
  type DesktopRun,
  desktopCallOf,
  desktopRun,
  isDesktopItem,
  splitRuns,
} from "./index.ts";

const isDesktopCall = (item: TurnItem | null): boolean =>
  item?._tag === "ToolCall" && desktopCallOf(item) !== null;

const turnDesktopItems = (turn: TurnView): ReadonlyArray<DesktopItem> =>
  [
    ...turn.items.flatMap((item) => (isDesktopCall(item) ? [completedItemView(item)] : [])),
    ...[...turn.live].flatMap(([id, live]) =>
      isDesktopCall(live.item) ? [liveItemView(id, live)] : []
    ),
  ].filter(isDesktopItem);

/** A Turn's last computer use call, running first; it reads ids only, as it runs per store change. */
const lastCallIn = (turn: TurnView): string | null => {
  const running = [...turn.live].findLast(([, live]) => isDesktopCall(live.item));

  return running?.[0] ?? turn.items.findLast(isDesktopCall)?.id ?? null;
};

/** The id of the session's last computer use call; null when it has made none. */
export const latestDesktopCallId = (model: SessionModel | undefined): string | null => {
  const turns = model?.turns ?? [];

  for (let n = turns.length - 1; n >= 0; n -= 1) {
    const turn = turns[n];
    const id = turn === undefined ? null : lastCallIn(turn);

    if (id !== null) return id;
  }

  return null;
};

/** The run the session's current Turn is in, for the peek; null when that Turn used no app. */
export const currentDesktopRun = (model: SessionModel | undefined): DesktopRun | null => {
  const turn = model?.turns.at(-1);

  if (turn === undefined || turn.turn.status !== "working") return null;
  const last = splitRuns(turnDesktopItems(turn)).at(-1);

  return last === undefined ? null : desktopRun(last);
};
