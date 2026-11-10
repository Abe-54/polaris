import { describe, expect, test } from "bun:test";
import type { CommandOption } from "./commands.ts";
import { sentPieces } from "./sent.ts";

const option = (name: string, extra: Partial<CommandOption> = {}): CommandOption => ({
  name,
  sigil: "/",
  description: `${name} it`,
  argumentHint: null,
  kind: "skill",
  source: "user",
  plugin: null,
  run: "text",
  action: null,
  template: null,
  ...extra,
});

const OPTIONS = [
  option("simplify"),
  option("compact", { kind: "command", source: "built-in", run: "harness" }),
  option("model", { kind: "command", source: "built-in", run: "polaris", action: "model" }),
  option("tdd", { sigil: "$" }),
];

/** Each piece as the message reads: chips as `[kind sigil name]`. */
const read = (text: string, options: ReadonlyArray<CommandOption> = OPTIONS) =>
  sentPieces(text, options)
    .map((p) => (p.kind === "text" ? p.text : `[${p.chip} ${p.sigil}${p.name}]`))
    .join("|");

describe("a sent message read back into chips", () => {
  test("listed Skills and commands become chips of their kind; the rest stays text", () => {
    expect(read("/simplify the parser")).toBe("[skill /simplify]| the parser");
    expect(read("/compact")).toBe("[command /compact]");
    expect(read("use $tdd then /simplify")).toBe("use |[skill $tdd]| then |[skill /simplify]");
    expect(read("/unknown thing")).toBe("/unknown thing");
  });

  test("a command chips only where the composer would: at the head, once", () => {
    expect(read("please /compact")).toBe("please /compact");
    expect(read("/compact /compact")).toBe("[command /compact]| /compact");
    expect(read("$tdd /compact")).toBe("[skill $tdd]| |[command /compact]");
  });

  test("before the Harness's commands are known, commands stay text and mentions still chip", () => {
    expect(read("/simplify @src/app.ts", [])).toBe("/simplify |[file @src/app.ts]");
  });

  test("mentions chip as files or folders, quoted paths included", () => {
    expect(read("look at @src/app.ts and @docs/")).toBe(
      "look at |[file @src/app.ts]| and |[folder @docs/]"
    );
    expect(read('read @"docs/my notes.md" now')).toBe("read |[file @docs/my notes.md]| now");
  });

  test("words that aren't tokens stay text: handles, emails, paths, code spans", () => {
    expect(read("ask @claude or mail a@b.com about /usr/bin and `/simplify`")).toBe(
      "ask @claude or mail a@b.com about /usr/bin and `/simplify`"
    );
    expect(read("see src/a/simplify")).toBe("see src/a/simplify");
  });
});
