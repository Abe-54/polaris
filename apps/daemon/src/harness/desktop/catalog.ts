/**
 * The `polaris_desktop` tools: each one's input, its agent-desktop argv, and what it targets.
 * Headed tools drive the real pointer and keyboard; `authorize` gates them (ADR 0104).
 */
import { Option, Schema } from "effect";

const text = (description: string) => Schema.String.annotate({ description });

const number = (description: string) => Schema.Number.annotate({ description });

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);

const Ref = text("A qualified ref from snapshot or find, such as @s8f3k2p9:e5.").check(
  Schema.isPattern(/^@[\w-]+:e\d+$/)
);

const App = text('The app\'s display name, as list_apps shows it ("TextEdit").');

const WindowId = text("A window id from list_windows, such as w-4521.");

const X = number("Screen x in points, from a screenshot of a screen (see its result).");

const Y = number("Screen y in points.");

const Direction = Schema.Literals(["up", "down", "left", "right"]);

const Button = Schema.Literals(["left", "right", "middle"]);

/** What a call acts on, so its Tool Call can name the app and window. */
export interface Target {
  readonly app: string | null;
  readonly windowId: string | null;
  readonly ref: string | null;
}

export type Json = typeof Schema.Json.Type;

interface Definition<I> {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Codec<I, unknown>;
  /** Real pointer and keyboard input: refused until the user approves it (D3). */
  readonly headed: boolean;
  /** Reads the screen and changes nothing. */
  readonly observes: boolean;
  readonly argv: (input: I) => ReadonlyArray<string>;
  readonly target: (input: I) => Target;
}

/** A call's input, parsed: what it runs and what it acts on. */
export interface ParsedCall {
  readonly argv: ReadonlyArray<string>;
  readonly target: Target;
  /** The display a screenshot captures, when it captures a whole one. */
  readonly screen: number | null;
}

export interface DesktopTool {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Top;
  readonly headed: boolean;
  readonly observes: boolean;
  /** None when the input doesn't fit the tool's schema. */
  readonly parse: (input: Json) => Option.Option<ParsedCall>;
}

const ScreenOf = Schema.Struct({ screen: Schema.optionalKey(Schema.Number) });

const decodeScreenOf = Schema.decodeUnknownOption(ScreenOf);

const tool = <I>(definition: Definition<I>): DesktopTool => {
  const decode = Schema.decodeUnknownOption(definition.input);

  return {
    name: definition.name,
    description: definition.description,
    input: definition.input,
    headed: definition.headed,
    observes: definition.observes,
    parse: (json) =>
      Option.map(decode(json), (input) => ({
        argv: definition.argv(input),
        target: definition.target(input),
        screen: Option.getOrNull(decodeScreenOf(json))?.screen ?? null,
      })),
  };
};

/** `--name=value`, so a value starting with `-` can't pass for another flag. */
const flag = (name: string, value: string | number | undefined): ReadonlyArray<string> =>
  value === undefined ? [] : [`--${name}=${value}`];

/** Positionals after `--`, so agent-desktop reads them as values even when they start with `-`. */
const values = (...positionals: ReadonlyArray<string>) => ["--", ...positionals];

/** `--xy=x,y`: the `=` form lets a negative coordinate through. */
const point = (name: string, x: number, y: number) => `--${name}=${Math.round(x)},${Math.round(y)}`;

const none: Target = { app: null, windowId: null, ref: null };

const onApp = (input: { readonly app?: string; readonly window_id?: string }): Target => ({
  app: input.app ?? null,
  windowId: input.window_id ?? null,
  ref: null,
});

const onRef = (input: { readonly ref: string }): Target => ({ ...none, ref: input.ref });

const WEB = "For a web page in a browser, use polaris_browser instead.";

const Scope = { app: optional(App), window_id: optional(WindowId) };

const snapshot = tool({
  name: "snapshot",
  description: `Read a native app's window as an accessibility tree with refs to act on. Start here for a native app, or for any app the user names. ${WEB} Snapshot again after each change: refs go stale.`,
  input: Schema.Struct({
    ...Scope,
    root: optional(text("Drill into this ref's subtree instead of the whole window.")),
    interactive_only: optional(
      Schema.Boolean.annotate({ description: "Interactive elements only (default true)." })
    ),
    max_depth: optional(number("The deepest level to read (default 10).")),
  }),
  headed: false,
  observes: true,
  argv: (input) => [
    "snapshot",
    ...flag("app", input.app),
    ...flag("window-id", input.window_id),
    ...flag("root", input.root),
    ...flag("max-depth", input.max_depth),
    ...(input.interactive_only === false ? [] : ["-i"]),
    "--compact",
  ],
  target: onApp,
});

const find = tool({
  name: "find",
  description: `Find elements in a native app by role, name, value or text, with refs to act on. ${WEB}`,
  input: Schema.Struct({
    ...Scope,
    role: optional(text("An accessibility role: button, textfield, checkbox…")),
    name: optional(text("The accessible name or label.")),
    value: optional(text("The current value.")),
    text: optional(text("Text in the name, value, title or description.")),
    limit: optional(number("At most this many matches (default 50).")),
  }),
  headed: false,
  observes: true,
  argv: (input) => [
    "find",
    ...flag("app", input.app),
    ...flag("window-id", input.window_id),
    ...flag("role", input.role),
    ...flag("name", input.name),
    ...flag("value", input.value),
    ...flag("text", input.text),
    ...flag("limit", input.limit),
  ],
  target: onApp,
});

const click = tool({
  name: "click",
  description:
    "Press an element through accessibility, without moving the pointer or taking focus.",
  input: Schema.Struct({ ref: Ref }),
  headed: false,
  observes: false,
  argv: (input) => ["click", ...values(input.ref)],
  target: onRef,
});

const type = tool({
  name: "type",
  description: "Insert text into a text field through accessibility, without taking focus.",
  input: Schema.Struct({ ref: Ref, text: text("The text to insert.") }),
  headed: false,
  observes: false,
  argv: (input) => ["type", ...values(input.ref, input.text)],
  target: onRef,
});

const setValue = tool({
  name: "set_value",
  description: "Set an element's value directly, replacing what it holds.",
  input: Schema.Struct({ ref: Ref, value: text("The new value.") }),
  headed: false,
  observes: false,
  argv: (input) => ["set-value", ...values(input.ref, input.value)],
  target: onRef,
});

const scroll = tool({
  name: "scroll",
  description: "Scroll an element.",
  input: Schema.Struct({
    ref: Ref,
    direction: optional(Direction),
    amount: optional(number("Scroll units (default 3).")),
  }),
  headed: false,
  observes: false,
  argv: (input) => [
    "scroll",
    ...flag("direction", input.direction),
    ...flag("amount", input.amount),
    ...values(input.ref),
  ],
  target: onRef,
});

const press = tool({
  name: "press",
  description:
    "Send a key combo (return, escape, cmd+s, shift+tab) to an app's process, without focusing it.",
  input: Schema.Struct({ combo: text("The key combo."), app: App }),
  headed: false,
  observes: false,
  argv: (input) => ["press", ...flag("app", input.app), ...values(input.combo)],
  target: onApp,
});

const screenshot = tool({
  name: "screenshot",
  description:
    "Take a screenshot of an app's window, or of a whole screen. For headed coordinate input, screenshot the screen: its result says how image pixels map to screen points.",
  input: Schema.Struct({
    ...Scope,
    screen: optional(number("A display index (0 is the primary); captures the whole screen.")),
  }),
  headed: false,
  observes: true,
  argv: (input) => [
    "screenshot",
    ...flag("app", input.app),
    ...flag("window-id", input.window_id),
    ...flag("screen", input.screen),
  ],
  target: onApp,
});

const listApps = tool({
  name: "list_apps",
  description: "List the running apps.",
  input: Schema.Struct({ app: optional(text("Only apps whose name matches this.")) }),
  headed: false,
  observes: true,
  argv: (input) => ["list-apps", ...flag("app", input.app)],
  target: () => none,
});

const listWindows = tool({
  name: "list_windows",
  description: "List visible windows with their ids and screen bounds in points.",
  input: Schema.Struct({ app: optional(App) }),
  headed: false,
  observes: true,
  argv: (input) => ["list-windows", ...flag("app", input.app)],
  target: onApp,
});

const launch = tool({
  name: "launch",
  description: `Open a native app by name or bundle id and wait for its window. ${WEB}`,
  input: Schema.Struct({ app: text("The app's name or bundle id.") }),
  headed: false,
  observes: false,
  argv: (input) => ["launch", "--activate", ...values(input.app)],
  target: onApp,
});

const focusWindow = tool({
  name: "focus_window",
  description: "Bring a window to the front.",
  input: Schema.Struct(Scope),
  headed: false,
  observes: false,
  argv: (input) => [
    "focus-window",
    ...flag("app", input.app),
    ...flag("window-id", input.window_id),
  ],
  target: onApp,
});

const HEADED =
  "Headed: moves the real pointer or keyboard. Only for an app with no accessibility tree; needs the user's approval. Coordinates never focus a window: focus_window it first.";

const mouseClick = tool({
  name: "mouse_click",
  description: `Click at screen coordinates. ${HEADED}`,
  input: Schema.Struct({
    x: X,
    y: Y,
    app: App,
    button: optional(Button),
    count: optional(number("Clicks (2 for a double click).")),
  }),
  headed: true,
  observes: false,
  argv: (input) => [
    "mouse-click",
    point("xy", input.x, input.y),
    ...flag("button", input.button),
    ...flag("count", input.count),
  ],
  target: onApp,
});

const mouseMove = tool({
  name: "mouse_move",
  description: `Move the pointer to screen coordinates. ${HEADED}`,
  input: Schema.Struct({ x: X, y: Y, app: App }),
  headed: true,
  observes: false,
  argv: (input) => ["mouse-move", point("xy", input.x, input.y)],
  target: onApp,
});

const hover = tool({
  name: "hover",
  description: `Hover the pointer over screen coordinates. ${HEADED}`,
  input: Schema.Struct({ x: X, y: Y, app: App }),
  headed: true,
  observes: false,
  argv: (input) => ["hover", point("xy", input.x, input.y)],
  target: onApp,
});

const drag = tool({
  name: "drag",
  description: `Drag from one screen point to another. ${HEADED}`,
  input: Schema.Struct({
    from_x: X,
    from_y: Y,
    to_x: X,
    to_y: Y,
    app: App,
  }),
  headed: true,
  observes: false,
  argv: (input) => [
    "drag",
    point("from-xy", input.from_x, input.from_y),
    point("to-xy", input.to_x, input.to_y),
  ],
  target: onApp,
});

const physicalClick = tool({
  name: "physical_click",
  description: `Click an element with the real pointer, for one that ignores an accessibility press. ${HEADED}`,
  input: Schema.Struct({ ref: Ref }),
  headed: true,
  observes: false,
  argv: (input) => ["click", ...values(input.ref)],
  target: onRef,
});

const physicalType = tool({
  name: "physical_type",
  description: `Type text with the real keyboard into an element, for a field that ignores accessibility input. ${HEADED}`,
  input: Schema.Struct({ ref: Ref, text: text("The text to type.") }),
  headed: true,
  observes: false,
  argv: (input) => ["type", ...values(input.ref, input.text)],
  target: onRef,
});

export const DESKTOP_TOOLS: ReadonlyArray<DesktopTool> = [
  snapshot,
  find,
  click,
  type,
  setValue,
  scroll,
  press,
  screenshot,
  listApps,
  listWindows,
  launch,
  focusWindow,
  mouseClick,
  mouseMove,
  hover,
  drag,
  physicalClick,
  physicalType,
];

/** The global flags every call takes: its agent-desktop session, and `--headed` for headed tools. */
export const argvFor = (
  definition: DesktopTool,
  call: ParsedCall,
  session: string | null
): ReadonlyArray<string> => [
  ...(session === null ? [] : ["--session", session]),
  ...(definition.headed ? ["--headed"] : []),
  ...call.argv,
];
