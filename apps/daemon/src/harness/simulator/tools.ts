/**
 * The `polaris_simulator` tools: their names, descriptions and inputs, each calling one method
 * of the Agent Session's `SimulatorSession`.
 */
import { Option, Schema } from "effect";
import { Platform } from "./platforms.ts";
import { failure, type SimulatorSession, type ToolResult } from "./session.ts";

const WATCH =
  "Prefer the simulator_* tools over xcrun simctl, adb or agent-device for UI work on an iOS Simulator or Android Emulator, so the user can watch it in the session's Simulator tab; builds and installs may still use the CLIs.";

const Point = Schema.Tuple([Schema.Number, Schema.Number]);

export interface SimulatorTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ReturnType<typeof Schema.toJsonSchemaDocument>["schema"];
  readonly readOnly: boolean;
  readonly call: (
    session: SimulatorSession,
    input: typeof Schema.Json.Type | undefined
  ) => Promise<ToolResult>;
}

/** An input without fields is `{}`: Effect writes such a struct as "not null", which Zod refuses. */
const jsonSchema = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema);

  return document.schema.type === undefined
    ? { type: "object" as const, properties: {} }
    : { ...document.schema, $defs: document.definitions };
};

const define = <S extends Schema.Decoder<unknown>>(
  name: string,
  description: string,
  schema: S,
  call: (session: SimulatorSession, input: S["Type"]) => Promise<ToolResult>,
  readOnly = false
): SimulatorTool => {
  const decode = Schema.decodeUnknownOption(schema);

  return {
    name,
    description,
    inputSchema: jsonSchema(schema),
    readOnly,
    call: async (session, input) => {
      const decoded = decode(input ?? {});

      return Option.isSome(decoded)
        ? call(session, decoded.value)
        : failure(`Invalid input for ${name}: use the fields in its input schema.`);
    },
  };
};

const Empty = Schema.Struct({});

const KEYS = ["home", "back", "return", "dismiss_keyboard"] as const;

export const simulatorTools: ReadonlyArray<SimulatorTool> = [
  define(
    "simulator_list",
    `Lists this Host's iOS Simulators and Android Emulators: their ids, names, OS versions and whether they are running, or what the Host needs before a platform can run them. ${WATCH}`,
    Empty,
    (session) => session.list(),
    true
  ),
  define(
    "simulator_open",
    `Opens an iOS Simulator or Android Emulator for this session, booting it if needed, and shows it to the user in the session's Simulator tab; optionally opens an app (bundle id, package name or app name) in it. Other simulator_* tools then act on it. The first iOS open on a Host builds a test runner, and booting an emulator takes a minute or two. ${WATCH}`,
    Schema.Struct({
      id: Schema.String.annotate({
        description: "The id from simulator_list: a Simulator's UDID, or an emulator's serial",
      }),
      platform: Schema.optionalKey(
        Platform.annotate({ description: "ios or android; inferred from the id when omitted" })
      ),
      app: Schema.optionalKey(
        Schema.String.annotate({ description: "A bundle id, package name or app name to open" })
      ),
    }),
    (session, { id, platform, app }) => session.open(id, app, platform)
  ),
  define(
    "simulator_snapshot",
    `The accessibility tree of the open device's screen, with refs (@e12) for simulator_tap and simulator_type. Snapshot before acting, and again after the screen changes: refs go stale. ${WATCH}`,
    Empty,
    (session) => session.snapshot(),
    true
  ),
  define(
    "simulator_tap",
    `Taps an element by ref (@e12, copied exactly from a snapshot), a selector (label="Settings"), or coordinates in points when nothing else names it. Waits for the screen to settle and answers with what changed. ${WATCH}`,
    Schema.Struct({
      target: Schema.optionalKey(
        Schema.String.annotate({ description: 'A ref such as @e12, or a selector like label="OK"' })
      ),
      x: Schema.optionalKey(Schema.Number),
      y: Schema.optionalKey(Schema.Number),
    }),
    (session, { target, x, y }) => {
      if (target !== undefined) return session.tap([target]);

      if (x !== undefined && y !== undefined) return session.tap([String(x), String(y)]);

      return Promise.resolve(failure("Give simulator_tap a target (ref or selector) or x and y."));
    }
  ),
  define(
    "simulator_press",
    `Presses a device key on the open device: home, back, the keyboard's return key, or dismiss_keyboard. ${WATCH}`,
    Schema.Struct({ key: Schema.Literals(KEYS) }),
    (session, { key }) => session.press(key)
  ),
  define(
    "simulator_type",
    `Types text: with \`into\` (a ref or selector), replaces that field's value; without it, appends to the focused field. ${WATCH}`,
    Schema.Struct({
      text: Schema.String,
      into: Schema.optionalKey(
        Schema.String.annotate({ description: "The field's ref or selector, to replace its value" })
      ),
    }),
    (session, { text, into }) => session.type(text, into)
  ),
  define(
    "simulator_swipe",
    `A quick swipe between two points, in points ([x, y]). For scrolling content prefer simulator_scroll. ${WATCH}`,
    Schema.Struct({ from: Point, to: Point }),
    (session, { from, to }) => session.swipe(from, to)
  ),
  define(
    "simulator_scroll",
    `Scrolls the content on screen: up, down, left, right, top or bottom; \`amount\` is the fraction of the screen (up to 0.8). ${WATCH}`,
    Schema.Struct({
      direction: Schema.Literals(["up", "down", "left", "right", "top", "bottom"]),
      amount: Schema.optionalKey(Schema.Number),
    }),
    (session, { direction, amount }) => session.scroll(direction, amount)
  ),
  define(
    "simulator_screenshot",
    `A screenshot of the open device, as an image. A snapshot is cheaper for finding what to tap. ${WATCH}`,
    Empty,
    (session) => session.screenshot(),
    true
  ),
  define(
    "simulator_launch",
    `Launches an installed app (bundle id or name) on the open device and brings it to the front. ${WATCH}`,
    Schema.Struct({ app: Schema.String }),
    (session, { app }) => session.launch(app)
  ),
  define(
    "simulator_openurl",
    `Opens a URL or deep link on the open device. ${WATCH}`,
    Schema.Struct({ url: Schema.String }),
    (session, { url }) => session.openUrl(url)
  ),
  define(
    "simulator_close",
    `Ends this session's control of the device and closes its app; the device keeps running. ${WATCH}`,
    Empty,
    (session) => session.close()
  ),
];
