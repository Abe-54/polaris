/**
 * Keys while the Simulator has focus. iOS takes USB HID usages (Keyboard page 0x07) by physical
 * key, so the Simulator's own layout applies; Android takes text and a few Android keycodes.
 */

const named = new Map(
  Object.entries({
    Enter: 40,
    NumpadEnter: 88,
    Escape: 41,
    Backspace: 42,
    Tab: 43,
    Space: 44,
    Minus: 45,
    Equal: 46,
    BracketLeft: 47,
    BracketRight: 48,
    Backslash: 49,
    Semicolon: 51,
    Quote: 52,
    Backquote: 53,
    Comma: 54,
    Period: 55,
    Slash: 56,
    CapsLock: 57,
    Delete: 76,
    Home: 74,
    PageUp: 75,
    End: 77,
    PageDown: 78,
    ArrowRight: 79,
    ArrowLeft: 80,
    ArrowDown: 81,
    ArrowUp: 82,
    IntlBackslash: 100,
    ControlLeft: 224,
    ShiftLeft: 225,
    AltLeft: 226,
    MetaLeft: 227,
    ControlRight: 228,
    ShiftRight: 229,
    AltRight: 230,
    MetaRight: 231,
  })
);

/** The HID usage of a `KeyboardEvent.code`, or null for a key the Simulator doesn't get. */
export const hidUsage = (code: string): number | null => {
  const letter = /^Key([A-Z])$/.exec(code);

  if (letter !== null) return 4 + letter[1]!.charCodeAt(0) - 65;
  const digit = /^Digit([0-9])$/.exec(code);

  if (digit !== null) return digit[1] === "0" ? 39 : 29 + Number(digit[1]);
  const fn = /^F([1-9]|1[0-2])$/.exec(code);

  if (fn !== null) return 57 + Number(fn[1]);

  return named.get(code) ?? null;
};

/** Android keycodes for the keys that aren't text. */
const ANDROID_KEYCODES = new Map(
  Object.entries({
    Enter: 66,
    NumpadEnter: 66,
    Backspace: 67,
    Tab: 61,
    Escape: 111,
    Delete: 112,
    ArrowUp: 19,
    ArrowDown: 20,
    ArrowLeft: 21,
    ArrowRight: 22,
    Home: 122,
    End: 123,
    PageUp: 92,
    PageDown: 93,
  })
);

export const androidKeycode = (code: string): number | null => ANDROID_KEYCODES.get(code) ?? null;

/**
 * Whether a key belongs to the app rather than the Simulator: ⌘ shortcuts (and ⌃Tab) keep
 * working while the Simulator has focus.
 */
export const appShortcut = (event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly code: string;
}) => event.metaKey || (event.ctrlKey && (event.code === "Tab" || event.code === "Backquote"));
