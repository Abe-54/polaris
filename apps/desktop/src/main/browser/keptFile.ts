/**
 * Browser tabs kept across restarts in `<userData>/browser/tabs.json`, written a moment after the
 * last change. Losing the file only loses the tabs. URLs can carry tokens, so only the user reads it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { KeptFile, type KeptSession } from "./tabs.ts";

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(KeptFile));

const encode = Schema.encodeSync(Schema.fromJsonString(KeptFile));

const SAVE_DELAY_MS = 500;

const DIR_MODE = 0o700;

const FILE_MODE = 0o600;

/** Tightens what an older build left readable by others; a missing path is fine. */
const repair = (path: string, mode: number) => {
  try {
    if (existsSync(path)) chmodSync(path, mode);
  } catch (cause) {
    console.warn("[browser] could not restrict", path, cause);
  }
};

export const openKeptTabs = (userData: string) => {
  const dir = join(userData, "browser");
  const path = join(dir, "tabs.json");
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: ReadonlyArray<KeptSession> | null = null;

  const write = () => {
    timer = null;

    if (pending === null) return;

    const sessions = pending;

    pending = null;

    try {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      writeFileSync(`${path}.part`, encode({ version: 1, sessions }), { mode: FILE_MODE });
      chmodSync(`${path}.part`, FILE_MODE);
      renameSync(`${path}.part`, path);
    } catch (error) {
      console.warn("[browser] could not keep tabs", error);
    }
  };

  /** The kept sessions; an unreadable file (or a folder in its place) starts with none. */
  const read = (): ReadonlyArray<KeptSession> => {
    repair(dir, DIR_MODE);
    repair(path, FILE_MODE);

    try {
      if (!existsSync(path)) return [];

      return Option.match(decode(readFileSync(path, "utf8")), {
        onNone: () => [],
        onSome: (file) => file.sessions,
      });
    } catch (cause) {
      console.warn("[browser] could not read kept tabs", cause);

      return [];
    }
  };

  return {
    read,
    save: (sessions: ReadonlyArray<KeptSession>) => {
      pending = sessions;
      timer ??= setTimeout(write, SAVE_DELAY_MS);
    },
    /** Writes what is pending now, on quit. */
    flush: () => {
      if (timer !== null) clearTimeout(timer);
      write();
    },
  };
};
