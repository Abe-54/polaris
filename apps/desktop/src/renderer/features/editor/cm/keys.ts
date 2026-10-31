/**
 * Polaris shortcuts keep working inside the editor (spec §4): any CodeMirror
 * binding on a chord the shell owns is dropped, so the key reaches the
 * window's keyboard handler. ⌘/ stays the editor's: it toggles a comment.
 */
import type { KeyBinding as CmBinding } from "@codemirror/view";
import {
  type Chord,
  chordKey,
  currentKeyPlatform,
  formatChord,
  isBare,
  type KeyPlatform,
  parseChord,
  platformChordKey,
} from "../../../../shared/chord.ts";
import { digitModifiersFor, keymapFor } from "../../../../shared/keymap.ts";

/** Chords the editor keeps although the shell binds them too. */
const EDITOR_OWNS = new Set([
  "Mod+Slash",
  "Alt+ArrowRight",
  "Mod+ArrowRight",
  // Outdent and indent while the editor has focus; Back and Forward elsewhere.
  "Mod+BracketLeft",
  "Mod+BracketRight",
]);

/** ⌘I, ⌘L, ⌘P belong to the inline chat, ⌘L's picker and the finder; ⌘S to saving. */
const RESERVED_ALWAYS = ["CmdOrCtrl+I", "CmdOrCtrl+L", "CmdOrCtrl+P", "CmdOrCtrl+S"];

const CM_KEYS = new Map<string, string>([
  ["/", "Slash"],
  [".", "Period"],
  [",", "Comma"],
  ["`", "Backquote"],
  ["[", "BracketLeft"],
  ["]", "BracketRight"],
  ["\\", "Backslash"],
  [";", "Semicolon"],
  ["'", "Quote"],
  ["=", "Equal"],
  ["-", "Minus"],
  [" ", "Space"],
  ["Space", "Space"],
]);

const codeOfCmKey = (key: string): string => {
  const named = CM_KEYS.get(key);

  if (named !== undefined) return named;

  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`;

  return /^\d$/.test(key) ? `Digit${key}` : key;
};

/** A CodeMirror key name ("Mod-Alt-ArrowUp") as a chord. */
const cmChordOf = (name: string, platform: KeyPlatform): Chord => {
  const mac = platform === "mac";
  // "Mod--" ends in the minus key itself.
  const parts = name.endsWith("--") ? [...name.slice(0, -2).split("-"), "-"] : name.split("-");
  const key = parts.pop() ?? "";
  const has = (...names: ReadonlyArray<string>) => parts.some((p) => names.includes(p));
  const mod = has("Mod") || (mac ? has("Cmd", "Meta") : has("Ctrl"));
  const ctrl = mac && has("Ctrl");

  return { mod, ctrl, alt: has("Alt"), shift: has("Shift"), code: codeOfCmKey(key) };
};

/** A CodeMirror key name as the shell's canonical chord. */
export const cmChord = (name: string, platform: KeyPlatform): string =>
  chordKey(cmChordOf(name, platform));

/** A CodeMirror key name as the app shows chords ("⌃Space", "Shift+F12"). */
export const cmShortcut = (name: string, platform: KeyPlatform = currentKeyPlatform()): string =>
  formatChord(cmChordOf(name, platform), platform);

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

/** Every chord the shell (or a sibling feature) owns, minus the editor's own. */
export const shellChords = (platform: KeyPlatform = currentKeyPlatform()): ReadonlySet<string> => {
  const digits = digitModifiersFor(platform).flatMap((m) => DIGITS.map((d) => `${m}+${d}`));

  // Data's own chords (⌘T, a new SQL tab) run only in Data, so the editor keeps them.
  const shell = keymapFor(platform).filter((b) => b.when !== "mode.data");
  const keys = [...shell.flatMap((b) => b.keys), ...RESERVED_ALWAYS, ...digits];

  const chords = keys.flatMap((key) => {
    const chord = parseChord(key);

    return isBare(chord) ? [] : [platformChordKey(chord, platform)];
  });

  return new Set(chords.filter((c) => !EDITOR_OWNS.has(c)));
};

const bindingKeys = (binding: CmBinding, platform: KeyPlatform) =>
  [platform === "mac" ? (binding.mac ?? binding.key) : binding.key].filter(
    (k): k is string => k !== undefined
  );

/** The bindings with every shell chord taken out. */
export const shellSafe = (
  bindings: ReadonlyArray<CmBinding>,
  platform: KeyPlatform,
  reserved: ReadonlySet<string> = shellChords(platform)
): ReadonlyArray<CmBinding> =>
  bindings.filter((b) => !bindingKeys(b, platform).some((k) => reserved.has(cmChord(k, platform))));

/** A key event as the shell's canonical chord. */
export const eventChord = (event: KeyboardEvent, platform: KeyPlatform): string =>
  chordKey({
    mod: platform === "mac" ? event.metaKey : event.ctrlKey,
    ctrl: platform === "mac" && event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    code: event.code,
  });

const pick = (e: KeyboardEvent): KeyboardEventInit => ({
  key: e.key,
  code: e.code,
  metaKey: e.metaKey,
  ctrlKey: e.ctrlKey,
  altKey: e.altKey,
  shiftKey: e.shiftKey,
  repeat: e.repeat,
});

/**
 * Vim swallows keys before CodeMirror's keymaps, so shell chords are caught on
 * the way down and sent to the window's keyboard handler instead.
 */
export const forwardShellChords = (
  root: HTMLElement,
  platform: KeyPlatform = currentKeyPlatform()
): (() => void) => {
  const reserved = shellChords(platform);

  const capture = (event: KeyboardEvent) => {
    if (event.isComposing || !reserved.has(eventChord(event, platform))) return;
    event.stopPropagation();

    const forwarded = new KeyboardEvent("keydown", {
      ...pick(event),
      bubbles: true,
      cancelable: true,
    });

    if (!window.dispatchEvent(forwarded)) event.preventDefault();
  };

  root.addEventListener("keydown", capture, { capture: true });

  return () => root.removeEventListener("keydown", capture, { capture: true });
};
