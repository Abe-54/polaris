import { describe, expect, test } from "bun:test";
import {
  acceleratorLabel,
  formatChord,
  type KeyPlatform,
  keyPlatformOf,
  matches,
  modifierLabel,
  modKey,
  parseChord,
  platformChordKey,
  shortcutLabel,
} from "./chord.ts";
import {
  chordOf,
  type CommandId,
  commandShortcut,
  digitChord,
  digitModifiersFor,
  keymapFor,
  reservedFor,
  TERMINAL_TOGGLE,
  PC_KEYS,
} from "./keymap.ts";
import { setClientPlatform } from "./platform.ts";

const PLATFORMS: ReadonlyArray<KeyPlatform> = ["mac", "windows", "linux"];

const key = (accelerator: string, platform: KeyPlatform) =>
  platformChordKey(parseChord(accelerator), platform);

const chordsOn = (platform: KeyPlatform) =>
  keymapFor(platform).flatMap((b) => b.keys.map((k) => ({ id: b.id, key: key(k, platform) })));

const press = (
  code: string,
  mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>>
) => ({
  code,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe("labels per platform", () => {
  test("Windows and Linux spell chords out; macOS keeps its glyphs", () => {
    const accelerators = ["CmdOrCtrl+Shift+P", "CmdOrCtrl+Alt+Down", "F12", "Shift+/", "Ctrl+`"];

    expect(accelerators.map((a) => acceleratorLabel(a, "mac"))).toEqual([
      "⇧⌘P",
      "⌥⌘↓",
      "F12",
      "?",
      "⌃`",
    ]);

    for (const platform of ["windows", "linux"] as const)
      expect(accelerators.map((a) => acceleratorLabel(a, platform))).toEqual([
        "Ctrl+Shift+P",
        "Ctrl+Alt+Down",
        "F12",
        "?",
        "Ctrl+`",
      ]);
  });

  test("named keys read as words off macOS", () => {
    expect(
      [
        "CmdOrCtrl+Enter",
        "Shift+Enter",
        "Esc",
        "Ctrl+Tab",
        "CmdOrCtrl+PageDown",
        "Shift+Alt+F",
      ].map((a) => formatChord(parseChord(a), "windows"))
    ).toEqual(["Ctrl+Enter", "Shift+Enter", "Esc", "Ctrl+Tab", "Ctrl+Page Down", "Alt+Shift+F"]);
  });

  test("held modifiers and the mod key", () => {
    expect(modifierLabel("Alt", "mac")).toBe("⌥");
    expect(modifierLabel("Alt", "windows")).toBe("Alt");
    expect(modifierLabel("CmdOrCtrl", "windows")).toBe("Ctrl");
    expect(modKey({ metaKey: true, ctrlKey: false }, "mac")).toBe(true);
    expect(modKey({ metaKey: true, ctrlKey: false }, "windows")).toBe(false);
    expect(modKey({ metaKey: false, ctrlKey: true }, "windows")).toBe(true);
  });

  test("the default platform comes from clientPlatform()", () => {
    setClientPlatform("win32");

    try {
      expect(commandShortcut("palette.open")).toBe("Ctrl+Shift+P");
      expect(commandShortcut("view.output")).toBe("Ctrl+Shift+B");
      expect(commandShortcut("view.edit")).toBe("Alt+3");
    } finally {
      setClientPlatform(null);
    }

    expect(keyPlatformOf("freebsd")).toBe("linux");
  });
});

const PCS = ["windows", "linux"] as const;

const keysOf = (id: CommandId, platform: KeyPlatform) =>
  (keymapFor(platform).find((b) => b.id === id)?.keys ?? []).map(
    (k) => acceleratorLabel(k, platform) ?? ""
  );

describe("Windows and Linux keys", () => {
  test("Control is the mod key, so Ctrl+Tab fires", () => {
    for (const platform of PCS) {
      expect(matches(parseChord("Ctrl+Tab"), press("Tab", { ctrl: true }), platform)).toBe(true);
      expect(matches(parseChord("CmdOrCtrl+S"), press("KeyS", { meta: true }), platform)).toBe(
        false
      );
    }
  });

  test("no binding uses Ctrl+Alt, which is AltGr on European layouts", () => {
    for (const platform of PCS)
      expect(chordsOn(platform).filter((c) => /Mod\+Alt\b/.test(c.key))).toEqual([]);
  });

  test("Alt+1–3 are the views and never fire with Ctrl held (AltGr+7 types {)", () => {
    const orchestrate = parseChord(chordOf("view.orchestrate", "windows") ?? "");

    expect(matches(orchestrate, press("Digit1", { alt: true }), "windows")).toBe(true);
    expect(matches(orchestrate, press("Digit1", { alt: true, ctrl: true }), "windows")).toBe(false);
  });

  test("the overrides are the approved table, the same on Windows and Linux", () => {
    // SAFETY: PC_KEYS is typed by CommandId, so its own keys are command ids.
    const ids = Object.keys(PC_KEYS) as Array<CommandId>;

    const table = (platform: KeyPlatform) =>
      Object.fromEntries(ids.map((id) => [id, keysOf(id, platform).join(" / ")]));

    expect(table("windows")).toEqual({
      "editor.prediction.acceptWord": "Ctrl+Right",
      "language.restart": "Ctrl+Shift+R",
      "view.orchestrate": "Alt+1",
      "view.review": "Alt+2",
      "view.edit": "Alt+3",
      "view.data": "Alt+4",
      "view.traces": "Alt+5",
      "view.output": "Ctrl+Shift+B",
      "session.next": "Ctrl+Page Down / Ctrl+Tab",
      "session.previous": "Ctrl+Page Up / Ctrl+Shift+Tab",
      "tab.closeOthers": "",
      "git.writeMessage": "Ctrl+Shift+G",
    });
    expect(table("linux")).toEqual(table("windows"));
  });

  test("macOS keeps its keys, plus Control+Tab for sessions", () => {
    expect(keysOf("view.output", "mac")).toEqual(["⌥⌘B"]);
    expect(keysOf("git.writeMessage", "mac")).toEqual(["⌥⌘G"]);
    expect(keysOf("view.orchestrate", "mac")).toEqual(["⌘1"]);
    expect(keysOf("session.next", "mac")).toEqual(["⌥⌘↓", "⌃⇥"]);
    expect(keysOf("session.previous", "mac")).toEqual(["⌥⌘↑", "⌃⇧⇥"]);
  });

  test("Workspace chips are Ctrl+1…0 only, as browser tabs", () => {
    for (const platform of PCS) {
      expect(digitModifiersFor(platform)).toEqual(["Ctrl"]);
      expect([0, 9, 10].map((i) => digitChord(i, platform))).toEqual([
        "Ctrl+1",
        "Ctrl+0",
        undefined,
      ]);
    }

    expect(digitModifiersFor("mac")).toEqual(["Ctrl", "Alt"]);
  });
});

describe("Control+Tab by mode", () => {
  test("in Edit the editor tabs take it; everywhere else the sessions do", () => {
    for (const platform of PLATFORMS) {
      const bindings = keymapFor(platform);
      const next = bindings.find((b) => b.id === "editor.nextTab");
      const previous = bindings.find((b) => b.id === "editor.previousTab");

      expect([next?.shares, next?.when]).toEqual(["session.next", "mode.edit"]);
      expect([previous?.shares, previous?.when]).toEqual(["session.previous", "mode.edit"]);
      expect(keysOf("session.next", platform)).toContain(shortcutLabel("Ctrl+Tab", platform));
    }
  });

  test("⌘Tab stays macOS's; Control+Tab is not reserved anywhere", () => {
    expect(key("Ctrl+Tab", "mac")).not.toBe(key("CmdOrCtrl+Tab", "mac"));

    for (const platform of PLATFORMS)
      expect(reservedFor(platform).map((r) => key(r, platform))).not.toContain(
        key("Ctrl+Tab", platform)
      );
  });
});

const noConflicts = (platform: KeyPlatform) => {
  const chords = chordsOn(platform);

  test("no two commands share a chord unless one declares it", () => {
    const seen = new Map<string, CommandId>();
    const bindings = keymapFor(platform);

    const shares = (id: CommandId) => bindings.find((x) => x.id === id)?.shares;

    // Siblings that both share one command (Data's and Traces' ⌘L) are declared too.
    const declared = (a: CommandId, b: CommandId) =>
      shares(a) === b || shares(b) === a || (shares(a) !== undefined && shares(a) === shares(b));

    for (const { id, key: k } of chords) {
      const other = seen.get(k);

      if (other !== undefined && other !== id)
        expect(`${id} ${other} ${declared(id, other)}`).toBe(`${id} ${other} true`);

      seen.set(k, id);
    }
  });

  test("nothing takes a reserved chord, the digit chips or the terminal toggle", () => {
    const reserved = reservedFor(platform).map((r) => key(r, platform));

    const digits = digitModifiersFor(platform).flatMap((m) =>
      Array.from({ length: 10 }, (_, d) => key(`${m}+${d}`, platform))
    );

    const taken = new Set([...reserved, ...digits, key(TERMINAL_TOGGLE, platform)]);

    expect(chords.filter((c) => taken.has(c.key))).toEqual([]);
  });

  test("the terminal toggle is not reserved", () => {
    const toggle = key(TERMINAL_TOGGLE, platform);

    expect(reservedFor(platform).map((r) => key(r, platform))).not.toContain(toggle);
  });
};

for (const platform of PLATFORMS)
  describe(`no conflicts on ${platform}`, () => noConflicts(platform));
