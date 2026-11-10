import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { DESKTOP_TOOLS, type Json } from "./catalog.ts";

const HOSTILE = "--headed";

/** Every input a tool takes, each text set to something agent-desktop could read as a flag. */
const HOSTILE_INPUTS = {
  snapshot: { app: HOSTILE, window_id: HOSTILE, root: HOSTILE },
  find: { app: HOSTILE, role: HOSTILE, name: HOSTILE, value: HOSTILE, text: HOSTILE },
  type: { ref: "@s1:e1", text: HOSTILE },
  set_value: { ref: "@s1:e1", value: HOSTILE },
  press: { combo: HOSTILE, app: HOSTILE },
  screenshot: { app: HOSTILE, window_id: HOSTILE },
  list_apps: { app: HOSTILE },
  list_windows: { app: HOSTILE },
  launch: { app: HOSTILE },
  focus_window: { app: HOSTILE, window_id: HOSTILE },
  physical_type: { ref: "@s1:e1", text: HOSTILE },
} satisfies Readonly<Record<string, Json>>;

const BARE_FLAGS = new Set(["-i", "--compact", "--activate"]);

const parse = (name: string, input: Json) =>
  Option.getOrNull(DESKTOP_TOOLS.find((tool) => tool.name === name)?.parse(input) ?? Option.none());

describe("a tool's argv", () => {
  test.each(Object.entries(HOSTILE_INPUTS))(
    "%s keeps input that looks like a flag a value",
    (name, input) => {
      const argv = parse(name, input)?.argv ?? [];
      const end = argv.includes("--") ? argv.indexOf("--") : argv.length;
      const loose = argv.slice(1, end).filter((arg) => !BARE_FLAGS.has(arg) && !arg.includes("="));

      expect(argv.length).toBeGreaterThan(0);
      expect(loose).toEqual([]);
    }
  );

  test.each([["--headed"], ["-x"], ["@s1:e1 --headed"], ["s1:e1"]])(
    "a ref of %s is refused",
    (ref) => {
      expect(parse("click", { ref })).toBeNull();
    }
  );
});
