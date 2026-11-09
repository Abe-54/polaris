import { describe, expect, test } from "bun:test";
import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { cmChord, cmShortcut, shellChords, shellSafe } from "./keys.ts";
import { LANGUAGE_NAVIGATION } from "../navigation/commands.ts";
import { minimalChange, reloadPlan } from "./reload.ts";
import { cursorOf } from "./cursor.ts";
import { lineEnding, lineEndingCompartment } from "../runtime/editorState.ts";
import { agentCleared, agentField, agentLines, agentWrote } from "./agent.ts";
import { crumbs } from "../model/paths.ts";
import { positionText } from "../ui/EditorStatus.tsx";

describe("shell chords stay the shell's", () => {
  test("CodeMirror key names map to the shell's chords", () => {
    expect(cmChord("Mod-i", "mac")).toBe("Mod+KeyI");
    expect(cmChord("Mod-Alt-ArrowUp", "mac")).toBe("Mod+Alt+ArrowUp");
    expect(cmChord("Ctrl-Space", "mac")).toBe("Ctrl+Space");
    expect(cmChord("Mod--", "mac")).toBe("Mod+Minus");
  });

  test("⌘I, ⌘L, ⌘P, ⌘S and ⌃1…9 are reserved; ⌘/ stays the editor's", () => {
    const reserved = shellChords("mac");

    for (const chord of [
      "Mod+KeyI",
      "Mod+KeyL",
      "Mod+KeyP",
      "Mod+KeyS",
      "Ctrl+Digit1",
      "Alt+Digit9",
      "Mod+KeyK",
    ]) {
      expect(reserved.has(chord)).toBe(true);
    }

    expect(reserved.has("Mod+Slash")).toBe(false);
  });

  test("the default keymap loses select-line (⌘L) and add-cursor-above (⌘⌥↑)", () => {
    const kept = shellSafe(defaultKeymap, "mac");
    const keys = kept.map((b) => b.mac ?? b.key);

    expect(keys).not.toContain("Mod-l");
    expect(keys).not.toContain("Mod-i");
    expect(keys).not.toContain("Mod-Alt-ArrowUp");
    expect(keys).toContain("Mod-/");
    // Outdent and indent stay the editor's while it has focus, over Back and Forward.
    expect(keys.filter((k) => k === "Mod-[" || k === "Mod-]")).toEqual(["Mod-[", "Mod-]"]);
    expect(kept.length).toBeGreaterThan(defaultKeymap.length - 8);
  });
});

describe.each(["mac", "windows", "linux"] as const)("editor keys on %s", (platform) => {
  test("no language command's key is a shell chord", () => {
    const shell = shellChords(platform);
    const keys = LANGUAGE_NAVIGATION.flatMap((c) => (c.key === undefined ? [] : [c.key]));

    expect(keys.filter((k) => shell.has(cmChord(k, platform)))).toEqual([]);
  });
});

describe("editor keys on Windows", () => {
  test("Ctrl is the mod key and labels read as words", () => {
    expect(cmChord("Ctrl-Space", "windows")).toBe("Mod+Space");
    expect(cmShortcut("Shift-F12", "windows")).toBe("Shift+F12");
    expect(cmShortcut("Ctrl--", "windows")).toBe("Ctrl+-");
  });

  test("the default keymap loses only Ctrl+I (select parent syntax) to the shell", () => {
    const kept = new Set(shellSafe(defaultKeymap, "windows"));

    expect(defaultKeymap.filter((b) => !kept.has(b)).map((b) => b.key)).toEqual(["Mod-i"]);
  });

  test("Requests' body editor gives Ctrl+Enter to Send; other editors keep it", () => {
    const requests = new Set(
      shellSafe(defaultKeymap, "windows", shellChords("windows", "mode.requests"))
    );

    expect(defaultKeymap.filter((b) => !requests.has(b)).map((b) => b.key)).toEqual([
      "Mod-Enter",
      "Mod-i",
    ]);
  });
});

describe("reloading in place", () => {
  test("the smallest single change", () => {
    expect(minimalChange("abcdef", "abXYef")).toEqual({ from: 2, to: 4, insert: "XY" });
    expect(minimalChange("aaa", "aaaa")).toEqual({ from: 3, to: 3, insert: "a" });
    expect(minimalChange("same", "same")).toBeNull();
  });

  test("the cursor maps through the reload and it isn't undoable", () => {
    const state = EditorState.create({ doc: "one\ntwo\nthree", selection: { anchor: 9 } });
    const plan = reloadPlan(state, "zero\none\ntwo\nthree");

    expect(plan).not.toBeNull();
    const next = state.update(plan?.spec ?? {}).state;

    expect(next.doc.toString()).toBe("zero\none\ntwo\nthree");
    expect(next.sliceDoc(next.selection.main.head, next.selection.main.head + 4)).toBe("hree");
  });
});

describe("reloading keeps the cursor (QCHECK)", () => {
  const doc = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`).join("\n");

  test("edits at both ends don't move a cursor in the middle", () => {
    const head = EditorState.create({ doc }).doc.line(20).from + 6;
    const state = EditorState.create({ doc, selection: { anchor: head } });
    const after = `// header\n${doc.replace("line39 = 39", "line39 = 40")}`;
    const next = state.update(reloadPlan(state, after)?.spec ?? {}).state;
    const line = next.doc.lineAt(next.selection.main.head);

    expect(line.number).toBe(21);
    expect(next.selection.main.head - line.from).toBe(6);
  });

  test("a whole-file rewrite puts the cursor back on its line and column", () => {
    const head = EditorState.create({ doc }).doc.line(20).from + 6;
    const state = EditorState.create({ doc, selection: { anchor: head } });
    const plan = reloadPlan(state, doc.replaceAll("const", "let  "));
    const next = state.update(plan?.spec ?? {}).state;
    const line = next.doc.lineAt(next.selection.main.head);

    expect(line.number).toBe(20);
    expect(next.selection.main.head - line.from).toBe(6);
  });

  test("CRLF files reload by their lines, not all at once", () => {
    const crlf = "a\r\nb\r\nc";

    const state = EditorState.create({
      doc: crlf,
      extensions: EditorState.lineSeparator.of("\r\n"),
    });

    const plan = reloadPlan(state, "a\r\nB\r\nc");

    expect(plan?.spans).toEqual([{ from: 2, to: 3 }]);
    expect(state.update(plan?.spec ?? {}).state.sliceDoc()).toBe("a\r\nB\r\nc");
  });
});

describe("line endings follow the disk (QCHECK)", () => {
  test("an LF buffer rewritten to CRLF on disk reloads without blank lines and saves CRLF", () => {
    let state = EditorState.create({
      doc: "one\ntwo\n",
      extensions: lineEndingCompartment.of(lineEnding("\n")),
    });

    const disk = "one\r\ntwo\r\n";

    state = state.update({ effects: lineEndingCompartment.reconfigure(lineEnding("\r\n")) }).state;
    const plan = reloadPlan(state, disk);

    state = plan === null ? state : state.update(plan.spec).state;
    expect(state.doc.lines).toBe(3);
    expect(state.sliceDoc()).toBe(disk);
  });
});

describe("an agent's marks (E3)", () => {
  const doc = "a\nb\nc\nd\ne";

  const write = (from: number, to: number, turnId = "t1") =>
    agentWrote.of({ turnId, harness: "claude", name: "Claude Code", from, to });

  test("its writes mark their lines, map through edits, and reset on a new turn", () => {
    let state = EditorState.create({ doc, extensions: agentField });

    state = state.update({ effects: write(2, 3) }).state;
    state = state.update({ effects: write(6, 7) }).state;
    expect([...agentLines(state)].sort((a, b) => a - b)).toEqual([2, 4]);

    state = state.update({ changes: { from: 0, insert: "x\n" } }).state;
    expect([...agentLines(state)].sort((a, b) => a - b)).toEqual([3, 5]);
    expect(state.field(agentField)?.caret).toBe(9);

    state = state.update({ effects: write(0, 1, "t2") }).state;
    expect([...agentLines(state)]).toEqual([1]);
    const cleared = state.update({ effects: agentCleared.of(null) }).state;

    expect(cleared.field(agentField)).toBeNull();
    expect([...agentLines(cleared)]).toEqual([]);
  });
});

describe("the chrome's words", () => {
  test("breadcrumbs from the root, or the whole path outside it", () => {
    expect(crumbs("/r/daemon/src/a.ts", "/r")).toEqual(["daemon", "src", "a.ts"]);
    expect(crumbs("/w/tree/a.ts", "/r/")).toEqual(["w", "tree", "a.ts"]);
  });

  test("the position, or the selection (Paper E2a)", () => {
    expect(positionText({ line: 28, column: 14, selected: 0, firstLine: 28, lastLine: 28 })).toBe(
      "Ln 28, Col 14"
    );
    expect(positionText({ line: 19, column: 3, selected: 240, firstLine: 10, lastLine: 19 })).toBe(
      "Ln 10–19 · 10 lines selected"
    );
  });

  test("a selection ending at column 1 stops on the line before (QDESIGN #5)", () => {
    const doc = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const base = EditorState.create({ doc });
    const from = base.doc.line(10).from;
    const to = base.doc.line(20).from;
    const state = EditorState.create({ doc, selection: { anchor: from, head: to } });

    expect(cursorOf(state)).toMatchObject({ firstLine: 10, lastLine: 19 });
    expect(positionText(cursorOf(state))).toBe("Ln 10–19 · 10 lines selected");
    expect(
      cursorOf(EditorState.create({ doc, selection: { anchor: from, head: to + 2 } }))
    ).toMatchObject({
      lastLine: 20,
    });
  });
});
