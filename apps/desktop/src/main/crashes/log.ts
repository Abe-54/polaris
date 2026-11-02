/**
 * The crash log: one JSON line per renderer crash or window signal, in the app's logs
 * directory. Bounded: past `maxBytes` the file rolls over to `crashes.1.log`, replacing it.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { clip, CRASH_MESSAGE_MAX, CRASH_STACK_MAX } from "../../shared/crash.ts";

export const CRASH_LOG = "crashes.log";

export const CRASH_LOG_PREVIOUS = "crashes.1.log";

const DEFAULT_MAX_BYTES = 512 * 1024;

export interface CrashEntry {
  readonly process: "renderer" | "main";
  /** A renderer report's kind, or the window signal ("render-process-gone", "unresponsive"…). */
  readonly kind: string;
  readonly message: string;
  readonly pane?: string;
  readonly stack?: string;
  readonly componentStack?: string;
  readonly detail?: Readonly<Record<string, string | number>>;
}

export interface CrashLogOptions {
  readonly dir: string;
  readonly version: string;
  readonly maxBytes?: number;
  readonly now?: () => Date;
}

export interface CrashLog {
  readonly path: string;
  /** Appends one entry; never throws (a full disk loses the entry, not the app). */
  readonly write: (entry: CrashEntry) => void;
}

const sizeOf = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/** An entry while its fields are cut to size. */
type EntryDraft = { -readonly [K in keyof CrashEntry]: CrashEntry[K] };

const capEntry = (entry: CrashEntry): CrashEntry => {
  const capped: EntryDraft = {
    ...entry,
    message: clip(entry.message, CRASH_MESSAGE_MAX),
  };

  if (entry.stack !== undefined) capped.stack = clip(entry.stack, CRASH_STACK_MAX);

  if (entry.componentStack !== undefined) {
    capped.componentStack = clip(entry.componentStack, CRASH_STACK_MAX);
  }

  return capped;
};

export const createCrashLog = ({
  dir,
  version,
  maxBytes = DEFAULT_MAX_BYTES,
  now = () => new Date(),
}: CrashLogOptions): CrashLog => {
  const path = join(dir, CRASH_LOG);

  const write = (entry: CrashEntry) => {
    const line = `${JSON.stringify({ at: now().toISOString(), version, platform: process.platform, ...capEntry(entry) })}\n`;

    try {
      mkdirSync(dir, { recursive: true });

      const size = sizeOf(path);

      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
        renameSync(path, join(dir, CRASH_LOG_PREVIOUS));
      }

      appendFileSync(path, line);
    } catch (cause) {
      console.warn("polaris: couldn't write the crash log", cause);
    }
  };

  return { path, write };
};
