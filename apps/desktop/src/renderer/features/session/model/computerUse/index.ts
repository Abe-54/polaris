/**
 * Computer use in the transcript (ENG-846; Paper CU5, DESIGN.md Computer use): a session's
 * `polaris_desktop` calls fold into one Tool Run line per app ("Using Simulator · clicking ·
 * 2 actions"), and that line's live view shows one of four states.
 */
import type {
  AppRef,
  AppWindow,
  ComputerUseCall,
  ControlledApp,
  PreviewIdleReason,
} from "@polaris/protocol";
import { Predicate } from "effect";
import { plural } from "../format.ts";
import type { ItemView } from "../items.ts";
import type { ToolInput } from "../toolCalls/index.ts";

/** The MCP server the Daemon gives Agent Sessions for computer use. */
export const DESKTOP_SERVER = "polaris_desktop";

const CLAUDE_NAME = /^mcp__polaris_desktop__(.+)$/;

/** A `polaris_desktop` call: its tool, and the app and window it acted on once it returned. */
export interface DesktopCall {
  readonly tool: string;
  readonly call: ComputerUseCall | null;
}

/** The computer use call an item is, from its MCP server (or Claude's name), else null. */
export const desktopCallOf = (item: {
  readonly name: string;
  readonly mcp?: { readonly server: string; readonly tool: string } | null;
  readonly computerUse?: ComputerUseCall | null;
}): DesktopCall | null => {
  const call = item.computerUse ?? null;

  if (item.mcp?.server === DESKTOP_SERVER) return { tool: item.mcp.tool, call };
  const named = CLAUDE_NAME.exec(item.name)?.[1];

  if (named !== undefined) return { tool: named, call };

  return call === null ? null : { tool: item.name, call };
};

type ToolItem = Extract<ItemView, { kind: "tool" }>;

export type DesktopItem = ToolItem & { readonly desktop: DesktopCall };

export const isDesktopItem = (item: ItemView): item is DesktopItem =>
  item.kind === "tool" && item.desktop !== null;

const stringAt = (input: ToolInput, key: string): string | null => {
  const value = Predicate.hasProperty(input, key) ? input[key] : undefined;

  return Predicate.isString(value) && value.trim() !== "" ? value.trim() : null;
};

const clip = (text: string, max = 24) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

type Phrase = readonly [running: string, done: string];

const POINTER: Phrase = ["moving the pointer", "moved the pointer"];

const CLICK: Phrase = ["clicking", "clicked"];

const TYPE: Phrase = ["typing", "typed"];

/** Each `polaris_desktop` tool (the Daemon's `harness/desktop/catalog.ts`) as a verb phrase. */
const PHRASES = new Map<string, (input: ToolInput) => Phrase>([
  ["snapshot", () => ["reading the window", "read the window"]],
  [
    "find",
    (input) => {
      const what = stringAt(input, "name") ?? stringAt(input, "text");

      return what === null
        ? ["finding elements", "found elements"]
        : [`finding ${clip(what)}`, `found ${clip(what)}`];
    },
  ],
  ["click", () => CLICK],
  ["physical_click", () => CLICK],
  ["mouse_click", () => CLICK],
  ["type", () => TYPE],
  ["physical_type", () => TYPE],
  ["set_value", () => ["setting a value", "set a value"]],
  ["scroll", () => ["scrolling", "scrolled"]],
  [
    "press",
    (input) => {
      const combo = stringAt(input, "combo");

      return combo === null
        ? ["pressing a key", "pressed a key"]
        : [`pressing ${combo}`, `pressed ${combo}`];
    },
  ],
  ["screenshot", () => ["taking a screenshot", "took a screenshot"]],
  ["list_apps", () => ["listing apps", "listed apps"]],
  ["list_windows", () => ["listing windows", "listed windows"]],
  ["launch", () => ["opening the app", "opened the app"]],
  ["focus_window", () => ["focusing a window", "focused a window"]],
  ["mouse_move", () => POINTER],
  ["hover", () => POINTER],
  ["drag", () => ["dragging", "dragged"]],
]);

/** What one call does, as the line's second part: "clicking", "pressed cmd+s". */
export const actionPhrase = (tool: string, input: ToolInput, running: boolean): string => {
  const phrase = PHRASES.get(tool)?.(input) ?? [
    tool.replaceAll("_", " "),
    tool.replaceAll("_", " "),
  ];

  return phrase[running ? 0 : 1];
};

const LOCKED = /^The screen on (.+) is locked\.$/;

/** Why the run's last call failed, as the live view tells it. */
export type DesktopFailure =
  /** The Daemon answered without acting (`harness/desktop/host.ts`, `lockedMessage`). */
  | { readonly kind: "locked"; readonly message: string }
  /** Any other failure; a refusal while another session holds the app shows as in use. */
  | { readonly kind: "failed"; readonly message: string | null };

const failureOf = (item: DesktopItem): DesktopFailure | null => {
  if (item.status !== "failed") return null;
  const text = item.result?.text ?? (Predicate.isString(item.output) ? item.output : null);
  const line = text?.trim() ?? null;

  return line !== null && LOCKED.test(line)
    ? { kind: "locked", message: line }
    : { kind: "failed", message: line };
};

/** A Tool Run of computer use: consecutive calls on one app. */
export interface DesktopRun {
  /** The first call's id: stable while later calls join. */
  readonly id: string;
  readonly items: ReadonlyArray<DesktopItem>;
  /** The app the calls acted on; null until one returns naming it (a running first call). */
  readonly app: AppRef | null;
  /** The app's name, or the name a running call passed, for the line. */
  readonly appName: string | null;
  readonly window: AppWindow | null;
  /** A call is still running. */
  readonly running: boolean;
  /** The last call, as a phrase: "clicking", "found Book". */
  readonly doing: string;
  readonly actions: number;
  readonly failure: DesktopFailure | null;
}

/** The last non-null `pick` over the list. */
const lastOf = <A, B>(list: ReadonlyArray<A>, pick: (a: A) => B | null): B | null =>
  list.reduce<B | null>((was, a) => pick(a) ?? was, null);

/** A run's calls: never empty. */
export type RunCalls = readonly [DesktopItem, ...ReadonlyArray<DesktopItem>];

export const desktopRun = (items: RunCalls): DesktopRun => {
  const [first] = items;
  const last = items.at(-1) ?? first;
  const app = lastOf(items, (i) => i.desktop.call?.app ?? null);
  const window = lastOf(items, (i) => i.desktop.call?.window ?? null);
  const running = items.some((i) => i.status === "running");
  const passed = lastOf(items, (i) => stringAt(i.input, "app"));

  return {
    id: first.id,
    items,
    app,
    appName: app?.name ?? passed,
    window,
    running,
    doing: actionPhrase(last.desktop.tool, last.input, last.status === "running"),
    actions: items.length,
    failure: failureOf(last),
  };
};

/** A run known only from the Host feed (the session's feed isn't open): its app, no calls. */
export const controlledRun = (controlled: ControlledApp): DesktopRun => ({
  id: `controlled:${controlled.sessionId}`,
  items: [],
  app: controlled.app,
  appName: controlled.app.name,
  window: null,
  running: true,
  doing: `using ${controlled.app.name}`,
  actions: 0,
  failure: null,
});

/** The line: "Using Simulator" while a call runs, else "Used Simulator". */
export const runTitle = (run: DesktopRun): string =>
  `${run.running ? "Using" : "Used"} ${run.appName ?? "an app"}`;

/** The line's second part: "clicking · 2 actions". */
export const runDetail = (run: DesktopRun): string =>
  `${run.doing} · ${plural(run.actions, "action")}`;

/** A run's app, or the app a running call names, so calls on one app join. */
const appKey = (item: DesktopItem): string | null =>
  item.desktop.call?.app?.id ?? stringAt(item.input, "app");

/** Whether `item` continues the run so far: the same app, or a call that names none. */
const joins = (run: ReadonlyArray<DesktopItem>, item: DesktopItem) => {
  const key = appKey(item);
  const was = lastOf(run, appKey);

  if (key === null || was === null) return true;

  return key === was || run.some((i) => i.desktop.call?.app?.name === key);
};

/** Consecutive computer use calls, split where the app changes. */
export const splitRuns = (items: ReadonlyArray<DesktopItem>): ReadonlyArray<RunCalls> => {
  const runs: Array<[DesktopItem, ...Array<DesktopItem>]> = [];

  for (const item of items) {
    const current = runs.at(-1);

    if (current !== undefined && joins(current, item)) current.push(item);
    else runs.push([item]);
  }

  return runs;
};

// ── The live view ───────────────────────────────────────────────────────────

/** What the hover popover and the peek show (Paper CU5, "States"). */
export type LiveState =
  /** Frames from the Host's capture, macOS. */
  | { readonly kind: "live" }
  /** The session's last screenshot, on a Host without live capture (Linux, Windows). */
  | { readonly kind: "last-frame" }
  /** The run's last call was refused: another session controls the app. */
  | { readonly kind: "in-use"; readonly holder: string }
  /** The screen is locked: the last frame, with a note. */
  | { readonly kind: "locked"; readonly message: string | null };

export interface LiveInputs {
  readonly failure: DesktopFailure | null;
  /** The session holding the run's app now, from the Host feed; null when none. */
  readonly holder: string | null;
  readonly sessionId: string;
  /** The Host captures live (`computer-use.preview`). */
  readonly hostLive: boolean;
  /** The feed's idle reason; null while frames come. */
  readonly idle: PreviewIdleReason | null;
}

export const liveState = (inputs: LiveInputs): LiveState => {
  const { failure, holder } = inputs;

  if (failure?.kind === "failed" && holder !== null && holder !== inputs.sessionId)
    return { kind: "in-use", holder };

  if (failure?.kind === "locked") return { kind: "locked", message: failure.message };

  if (inputs.idle === "screen-locked") return { kind: "locked", message: null };

  return inputs.hostLive ? { kind: "live" } : { kind: "last-frame" };
};

const SECOND = 1000;

/** "3S AGO", "2M AGO", "1H AGO": the kicker's age of a still frame. */
export const frameAge = (capturedAt: string | null, now: number): string | null => {
  if (capturedAt === null) return null;
  const ms = Math.max(0, now - Date.parse(capturedAt));

  if (Number.isNaN(ms)) return null;

  if (ms < 60 * SECOND) return `${Math.floor(ms / SECOND)}S AGO`;

  if (ms < 3600 * SECOND) return `${Math.floor(ms / (60 * SECOND))}M AGO`;

  return `${Math.floor(ms / (3600 * SECOND))}H AGO`;
};

/** The card's kicker: LIVE, LAST FRAME · 3S AGO, IN USE. */
export const stateKicker = (state: LiveState, age: string | null): string => {
  switch (state.kind) {
    case "live":
      return "LIVE";
    case "in-use":
      return "IN USE";
    case "last-frame":
    case "locked":
      return age === null ? "LAST FRAME" : `LAST FRAME · ${age}`;
  }
};

export type Platform = "macos" | "linux" | "windows" | null;

const PLATFORM_NAME = { macos: "macOS", linux: "Linux", windows: "Windows" } as const;

export interface FooterFacts {
  readonly harness: string;
  readonly host: string;
  readonly platform: Platform;
  readonly run: DesktopRun;
}

/** The card's footer line (Paper CU5): what the agent is doing, or why the view is still. */
export const stateFooter = (state: LiveState, facts: FooterFacts): string => {
  switch (state.kind) {
    case "live":
      return `${facts.harness} ${facts.run.running ? "is " : ""}${facts.run.doing}`;
    case "last-frame":
      return facts.platform === null || facts.platform === "macos"
        ? "Updates after each action"
        : `Updates after each action on ${PLATFORM_NAME[facts.platform]}`;
    case "in-use":
      return `Refused · ${facts.harness} may retry`;
    case "locked":
      return state.message ?? `The screen on ${facts.host} is locked.`;
  }
};

/** Why there's no picture yet, in the view's body; null when there is one to show. */
export const idleLine = (reason: PreviewIdleReason | null, host: string): string | null => {
  switch (reason) {
    case "no-window":
      return "No window yet";
    case "not-ready":
      return `Computer use isn't ready on ${host}`;
    default:
      return null;
  }
};
