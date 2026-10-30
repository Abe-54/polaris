/**
 * One Daemon Turn's rows inside the Turn the UI shows (`turnGroups.ts`): the user's
 * prompt or what woke a Turn the Harness started, each item, and how it ended. Cached
 * per Turn view, so a streaming Turn rebuilds only its own rows each frame.
 */
import type { TurnId, TurnItem } from "@polaris/protocol";
import { Predicate } from "effect";
import { entriesInStartOrder, type TurnEntry, type TurnView } from "../../../store/sessionModel.ts";
import { quietOpening } from "./idleCompaction.ts";
import type { Row } from "./conversation.ts";
import { completedItemView, isUserShell, liveItemView, type ShellView } from "./items.ts";
import { type Entry, groupItems } from "./runs.ts";
import { subagentCard } from "./subagents.ts";
import { noTitles, type SubagentTitles, withSubagentTitle } from "./subagentTitles.ts";

/** Where a Daemon Turn sits in the Turn the UI shows. */
export interface Part {
  /** The shown Turn's id (its first Turn's). */
  readonly turnId: TurnId;
  /** The shown Turn's number. */
  readonly number: number;
  /** This Turn opens the shown one (else the Harness started it after the user's). */
  readonly opens: boolean;
  /** The shown Turn is the session's latest (in-Turn defaults read it). */
  readonly latest: boolean;
  /** This is the session's last Turn: an ending offers Continue or Retry. */
  readonly isLast: boolean;
  /** The session's Subagents by handle: a message to one reads its title. */
  readonly titles?: SubagentTitles;
}

type ToolCallItem = Extract<TurnItem, { readonly _tag: "ToolCall" }>;

const itemOf = (entry: TurnEntry) => (entry.kind === "completed" ? entry.item : entry.live.item);

const entryView = (entry: TurnEntry) =>
  entry.kind === "completed" ? completedItemView(entry.item) : liveItemView(entry.id, entry.live);

/**
 * A shell Turn's command with its output, shown as the user's: its item once the Daemon
 * reports it, else the command as sent (running, or never run if the Turn ended first).
 */
const shellOf = (view: TurnView): ShellView | null => {
  const command = view.turn.shellCommand ?? null;

  if (command === null) return null;
  const entry = entriesInStartOrder(view).find((e) => isUserShell(itemOf(e)));
  const shown = entry === undefined ? null : entryView(entry);

  if (shown?.kind === "command") return shown;
  const running = view.turn.status === "working";

  return {
    kind: "command",
    id: `shell:${view.turn.id}`,
    live: running,
    command,
    output: "",
    exitCode: null,
    status: running ? "running" : "failed",
  };
};

/** The Turn's items with each Subagent in place of the call that spawned it (else at the end). */
const turnEntries = (view: TurnView, titles: SubagentTitles): ReadonlyArray<Entry> => {
  const byParent = new Map(
    view.subagents.map((s) => [s.subagent.parentItemId ?? s.subagent.id, s])
  );

  const placed = new Set<string>();

  const calls = new Map(
    view.items.flatMap((i): Array<readonly [string, ToolCallItem]> =>
      Predicate.isTagged(i, "ToolCall") ? [[i.id, i]] : []
    )
  );

  // In the order the model started them (H2), so a running command stays where it began.
  const items = entriesInStartOrder(view)
    .filter((entry) => !isUserShell(itemOf(entry)))
    .map((entry) => withSubagentTitle(entryView(entry), titles));

  const entries = groupItems(items).map((entry): Entry => {
    const sub = entry.kind === "item" ? byParent.get(entry.item.id) : undefined;

    if (sub === undefined) return entry;
    placed.add(sub.subagent.id);

    return {
      kind: "subagent",
      card: subagentCard(sub, calls.get(sub.subagent.parentItemId ?? "")),
    };
  });

  const orphans = view.subagents
    .filter((s) => !placed.has(s.subagent.id))
    .map((s): Entry => ({ kind: "subagent", card: subagentCard(s, undefined) }));

  return [...entries, ...orphans];
};

const entryKey = (entry: Entry) => {
  switch (entry.kind) {
    case "item":
      return entry.item.id;
    case "run":
      return `run:${entry.id}`;
    case "subagent":
      return `subagent:${entry.card.id}`;
    case "sources":
      return `sources:${entry.id}`;
  }
};

const isSteer = (entry: Entry | undefined) => entry?.kind === "item" && entry.item.kind === "user";

/** When each item started, by id; null when the Harness didn't say (`TurnItem.startedAt`). */
const itemStarts = (view: TurnView): ReadonlyMap<string, string | null> =>
  new Map([
    ...view.items.map((item): [string, string | null] => [item.id, item.startedAt]),
    ...[...view.live].map(([id, live]): [string, string | null] => [
      id,
      live.item?.startedAt ?? null,
    ]),
  ]);

const entryStart = (entry: Entry, starts: ReadonlyMap<string, string | null>) =>
  entry.kind === "item" ? (starts.get(entry.item.id) ?? null) : null;

/** The Turn's sources move to its first agent row, across from the avatar, when it has one. */
const liftSources = (entries: ReadonlyArray<Entry>) => {
  const pill = entries.find((entry) => entry.kind === "sources");
  const rest = entries.filter((entry) => entry !== pill);
  const carrier = rest.findIndex((entry) => !isSteer(entry));

  return pill?.kind === "sources" && carrier !== -1
    ? { rest, carrier, sources: pill.sources }
    : { rest: entries, carrier: -1, sources: undefined };
};

const itemRows = (view: TurnView, part: Part): ReadonlyArray<Row> => {
  const partId = view.turn.id;

  const {
    rest: entries,
    carrier,
    sources,
  } = liftSources(turnEntries(view, part.titles ?? noTitles));

  const starts = itemStarts(view);

  // The first agent row carries the avatar, and so does the first one after a steer.
  return entries.map((entry, n) => ({
    kind: "item",
    key: `${partId}:${entryKey(entry)}`,
    turnId: part.turnId,
    partId,
    entry,
    lead: !isSteer(entry) && (n === 0 || isSteer(entries[n - 1])),
    latest: part.latest,
    startedAt: entryStart(entry, starts),
    sources: n === carrier ? sources : undefined,
  }));
};

const endingRow = (view: TurnView, part: Part): ReadonlyArray<Row> => {
  const { status, id } = view.turn;

  if (status !== "interrupted" && status !== "failed") return [];

  return [
    {
      kind: "ending",
      key: `${id}:ending`,
      turnId: part.turnId,
      number: part.number,
      status,
      canContinue: part.isLast && status === "interrupted",
      canRetry: part.isLast && status === "failed",
    },
  ];
};

const openingRow = (view: TurnView, part: Part): Row => {
  const { turn } = view;
  const quiet = quietOpening(turn);

  return quiet === null
    ? {
        kind: "prompt",
        key: `${turn.id}:prompt`,
        turnId: part.turnId,
        number: part.number,
        text: turn.prompt,
        attachments: turn.attachments,
        model: turn.model,
        effort: turn.effort,
        startedAt: turn.startedAt,
        shell: shellOf(view),
      }
    : {
        kind: "trigger",
        key: `${turn.id}:trigger`,
        turnId: part.turnId,
        partId: turn.id,
        opensTurn: part.opens,
        number: part.number,
        text: quiet,
        model: turn.model,
        effort: turn.effort,
        startedAt: turn.startedAt,
      };
};

interface Cached {
  readonly part: string;
  readonly rows: ReadonlyArray<Row>;
}

const cache = new WeakMap<TurnView, Cached>();

const partKey = (part: Part) =>
  `${part.turnId}:${part.number}:${part.opens}:${part.latest}:${part.isLast}:${part.titles?.key ?? ""}`;

/** One Daemon Turn's rows, open; the same array while its view and place are unchanged. */
export const partRows = (view: TurnView, part: Part): ReadonlyArray<Row> => {
  const key = partKey(part);
  const hit = cache.get(view);

  if (hit?.part === key) return hit.rows;

  const rows = [openingRow(view, part), ...itemRows(view, part), ...endingRow(view, part)];

  cache.set(view, { part: key, rows });

  return rows;
};
