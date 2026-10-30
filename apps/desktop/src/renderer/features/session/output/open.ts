/** The per-session open state of Output (`memory.ts`), in `localStorage`. */
import { Option, Schema } from "effect";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { CLOSED, editOpens, type Memories, toggled } from "./memory.ts";

const STORAGE_KEY = "polaris.output.open.v1";

const Persisted = Schema.Record(
  Schema.String,
  Schema.Struct({ open: Schema.Boolean, toggled: Schema.Boolean })
);

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Persisted));

const storage = (): Storage | null =>
  "localStorage" in globalThis ? globalThis.localStorage : null;

const load = (): Memories => {
  try {
    const raw = storage()?.getItem(STORAGE_KEY) ?? null;

    return raw === null ? {} : Option.getOrElse(decode(raw), () => ({}));
  } catch {
    return {};
  }
};

const store = createStore<Memories>(load);

let saveTimer: ReturnType<typeof setTimeout> | null = null;

store.subscribe((state) => {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      storage()?.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage unavailable: Output still opens and closes, it just won't be remembered.
    }
  }, 300);
});

const update = (next: (memories: Memories) => Memories) => {
  const current = store.getState();
  const after = next(current);

  if (after !== current) store.setState(after, true);
};

export const useOutputOpen = (key: string): boolean =>
  useStore(store, (s) => (s[key] ?? CLOSED).open);

export const isOutputOpen = (key: string): boolean => (store.getState()[key] ?? CLOSED).open;

/** The user closed Output for this session themselves: nothing but they reopen it. */
export const isOutputHeldClosed = (key: string): boolean => {
  const entry = store.getState()[key] ?? CLOSED;

  return entry.toggled && !entry.open;
};

/** The user opened or closed Output: remembered, and edits no longer open it. */
export const setOutputOpen = (key: string, open: boolean) =>
  update((memories) => toggled(memories, key, open));

/** A Turn's first edit opens Output, unless the user has chosen for this session. */
export const openForEdit = (key: string) => update((memories) => editOpens(memories, key));
