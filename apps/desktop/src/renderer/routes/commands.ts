/**
 * The shell's command registry: every keyboard shortcut, menu item and
 * Command Palette row runs a command by id (`shared/keymap.ts`). The shell and
 * features register handlers; the latest registration of an id wins until it
 * is removed, so a view can take a command over while it is mounted. Features
 * also put facts in the command context (`provide`), which `when` conditions
 * read, and may contribute commands of their own (`contribute`).
 */
import {
  type Chord,
  currentKeyPlatform,
  formatChord,
  isBare,
  type KeyPlatform,
  matches,
  parseChord,
} from "../../shared/chord.ts";
import {
  type CommandContext,
  type CommandGroup,
  type CommandId,
  type Condition,
  type ContextKey,
  type ContextValue,
  fillTitle,
  holds,
  KEYMAP,
  keymapFor,
  type PaletteEntry,
  paletteEntry,
} from "../../shared/keymap.ts";
import { runAction } from "../features/selfTraces/actions.ts";

/** One answer to a command's follow-up ("Use the bundled TypeScript"). */
export interface FollowUpChoice {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  /** Shown but not choosable, with `detail` saying why. */
  readonly disabled?: boolean;
  readonly run: () => void;
}

/** The step a "…" command asks in the palette before it acts. */
export interface FollowUp {
  /** The field's placeholder: what is being asked. */
  readonly title: string;
  /** A line of context above the choices, such as what Trust would run. */
  readonly note?: string;
  readonly choices: ReadonlyArray<FollowUpChoice>;
  /** The real answer when the choices come from the Host; until then `choices` say it's looking. */
  readonly load?: () => Promise<FollowUp>;
}

interface Enabled {
  /** Whether it can run now (a session is selected, an approval is pending…); default yes. */
  readonly enabled?: () => boolean;
}

export type CommandHandler =
  | (Enabled & { readonly run: () => void })
  | (Enabled & { readonly followUp: () => FollowUp | null });

export type CommandHandlers = Partial<Record<CommandId, CommandHandler>>;

/** Part of the command context, from one feature. */
export interface ContextPart {
  readonly keys?: ReadonlyArray<ContextKey>;
  readonly values?: Readonly<Partial<Record<ContextValue, string>>>;
}

/** A command a feature adds at run time: no shortcut or menu, palette only. */
export interface ContributedCommand {
  /** Namespaced by the feature ("fun.stars"); never a keymap id. */
  readonly id: string;
  readonly title: string;
  readonly palette: PaletteEntry;
  readonly when?: Condition;
  readonly handler: CommandHandler;
}

/** A row the Command Palette can show, with its title filled in. */
export interface PaletteCommand {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly group: CommandGroup;
  readonly keywords: ReadonlyArray<string>;
  /** "⌥⌘R", or "" when it has none. */
  readonly shortcut: string;
  /** The same as `aria-keyshortcuts` reads it ("Meta+Alt+R"), or "". */
  readonly ariaKeys: string;
  readonly followUp: boolean;
  readonly searchOnly: boolean;
}

export interface CommandRegistry {
  /** Adds handlers; call the returned function to remove them. */
  readonly register: (handlers: CommandHandlers) => () => void;
  /** Adds facts to the command context while mounted; returns the remover. */
  readonly provide: (part: () => ContextPart) => () => void;
  readonly contribute: (commands: ReadonlyArray<ContributedCommand>) => () => void;
  readonly context: () => CommandContext;
  readonly enabled: (id: CommandId) => boolean;
  /** Runs the command if it has an enabled handler; true when it ran. */
  readonly run: (id: CommandId) => boolean;
  /** Runs a keymap or contributed command by id, as the palette does. */
  readonly runAny: (id: string) => boolean;
  /** What the palette can show now, in keymap order then contributions. */
  readonly palette: () => ReadonlyArray<PaletteCommand>;
  /** Where a "…" command's follow-up goes (the palette); returns the remover. */
  readonly onFollowUp: (listener: (followUp: FollowUp) => void) => () => void;
  /** Runs the shortcut a key event is bound to; true when it ran. */
  readonly handleKey: (event: KeyInput) => boolean;
}

export interface KeyInput {
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  /** The event's target is a text field, where bare keys are typing. */
  readonly typing: boolean;
}

interface Bound {
  readonly id: CommandId;
  readonly chord: Chord;
  readonly inFields: boolean;
}

/** A command that `shares` a chord is tried before the one it shares with, which is the fallback. */
const boundOn = (platform: KeyPlatform): ReadonlyArray<Bound> => {
  const keymap = keymapFor(platform);
  const ordered = [...keymap.filter((b) => b.shares), ...keymap.filter((b) => !b.shares)];

  return ordered.flatMap((b) =>
    b.keys.map((key) => ({ id: b.id, chord: parseChord(key), inFields: b.inFields ?? true }))
  );
};

const WHEN = new Map<string, Condition | undefined>(KEYMAP.map((b) => [b.id, b.when]));

/** A command's template title ("Restart {language} server"): a label with no user content. */
const TITLE = new Map<string, string>(KEYMAP.map((b) => [b.id, b.title]));

export interface RegistryInput {
  /** Whose keys it runs and shows (⌘ on macOS, Ctrl elsewhere); default: this Client's. */
  readonly platform?: KeyPlatform;
}

const mergeContext = (parts: ReadonlyArray<ContextPart>): CommandContext => {
  const keys = new Set<ContextKey>();
  const values: Partial<Record<ContextValue, string>> = {};

  for (const part of parts) {
    for (const key of part.keys ?? []) keys.add(key);
    Object.assign(values, part.values);
  }

  return { keys, values };
};

/** The chords a row shows: the first, plus any other with a modifier ("⌥⌘↓ / ⌃⇥"). */
const shownKeys = (keys: ReadonlyArray<string>) =>
  keys.filter((k, i) => i === 0 || !isBare(parseChord(k)));

const shortcutOf = (keys: ReadonlyArray<string>, platform: KeyPlatform) =>
  shownKeys(keys)
    .map((k) => formatChord(parseChord(k), platform))
    .join(" / ");

/** An accelerator as `aria-keyshortcuts` spells it: the mod key is Meta on macOS, Control elsewhere. */
export const ariaKeys = (
  accelerator: string | undefined,
  platform: KeyPlatform = currentKeyPlatform()
) =>
  accelerator === undefined
    ? ""
    : accelerator
        .replace("CmdOrCtrl", platform === "mac" ? "Meta" : "Control")
        .replace(/\bCtrl\b/, "Control");

const rowOf = (
  base: { readonly id: string; readonly title: string; readonly keys: ReadonlyArray<string> },
  entry: PaletteEntry,
  values: CommandContext["values"],
  platform: KeyPlatform
): PaletteCommand | null => {
  const title = fillTitle(entry.title ?? base.title, values);

  if (title === null) return null;

  return {
    id: base.id,
    title,
    detail: entry.detail === undefined ? "" : (fillTitle(entry.detail, values) ?? ""),
    group: entry.group,
    keywords: entry.keywords ?? [],
    shortcut: shortcutOf(base.keys, platform),
    ariaKeys: shownKeys(base.keys)
      .map((k) => ariaKeys(k, platform))
      .join(" "),
    followUp: entry.followUp ?? false,
    searchOnly: entry.searchOnly ?? false,
  };
};

const removeFrom =
  <A>(list: Array<A>, item: A) =>
  () => {
    const at = list.indexOf(item);

    if (at !== -1) list.splice(at, 1);
  };

export const createCommandRegistry = ({
  platform = currentKeyPlatform(),
}: RegistryInput = {}): CommandRegistry => {
  const keymap = keymapFor(platform);
  const bound = boundOn(platform);
  const layers: Array<CommandHandlers> = [];
  const providers: Array<() => ContextPart> = [];
  const contributed: Array<ReadonlyArray<ContributedCommand>> = [];
  const followUps: Array<(followUp: FollowUp) => void> = [];

  const handler = (id: CommandId) => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const found = layers[i]?.[id];

      if (found !== undefined) return found;
    }

    return undefined;
  };

  const context = () => mergeContext(providers.map((p) => p()));

  const usable = (found: CommandHandler | undefined, when: Condition | undefined) =>
    found !== undefined && (found.enabled?.() ?? true) && holds(when, context().keys);

  const enabled = (id: CommandId) => usable(handler(id), WHEN.get(id));

  const perform = (found: CommandHandler) => {
    if ("run" in found) {
      found.run();

      return;
    }

    const followUp = found.followUp();

    if (followUp !== null) for (const listener of followUps) listener(followUp);
  };

  // Each run is a user action: a root Span while Self-Traces are on.
  const execute = (id: string, title: string, found: CommandHandler) =>
    runAction(id, title, () => perform(found), "command");

  const run = (id: CommandId) => {
    const found = handler(id);

    if (found === undefined || !usable(found, WHEN.get(id))) return false;
    execute(id, TITLE.get(id) ?? id, found);

    return true;
  };

  const contribution = (id: string) => contributed.flat().find((c) => c.id === id);

  const isKeymapId = (id: string): id is CommandId => WHEN.has(id);

  return {
    register: (handlers) => {
      layers.push(handlers);

      return removeFrom(layers, handlers);
    },
    provide: (part) => {
      providers.push(part);

      return removeFrom(providers, part);
    },
    contribute: (commands) => {
      const own = commands.filter((c) => !isKeymapId(c.id));

      contributed.push(own);

      return removeFrom(contributed, own);
    },
    context,
    enabled,
    run,
    runAny: (id) => {
      if (isKeymapId(id)) return run(id);
      const found = contribution(id);

      if (found === undefined || !usable(found.handler, found.when)) return false;
      execute(id, found.title, found.handler);

      return true;
    },
    palette: () => {
      const { keys, values } = context();

      const fromKeymap = keymap.flatMap((b) => {
        const entry = paletteEntry(b);
        const found = handler(b.id);

        if (entry === null || found === undefined || !(found.enabled?.() ?? true)) return [];

        if (!holds(b.when, keys)) return [];
        const row = rowOf(b, entry, values, platform);

        return row === null ? [] : [row];
      });

      const fromFeatures = contributed.flat().flatMap((c) => {
        if (!(c.handler.enabled?.() ?? true) || !holds(c.when, keys)) return [];
        const row = rowOf({ ...c, keys: [] }, c.palette, values, platform);

        return row === null ? [] : [row];
      });

      return [...fromKeymap, ...fromFeatures];
    },
    onFollowUp: (listener) => {
      followUps.push(listener);

      return removeFrom(followUps, listener);
    },
    handleKey: (event) => {
      // A shared chord (`KeyBinding.shares`) runs the first of its commands that is enabled.
      return bound.some(
        (b) =>
          matches(b.chord, event, platform) &&
          !(event.typing && (isBare(b.chord) || !b.inFields)) &&
          run(b.id)
      );
    },
  };
};
