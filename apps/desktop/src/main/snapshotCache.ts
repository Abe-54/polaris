/**
 * The renderer's last synchronized Host snapshots, kept in
 * `<userData>/cache/hosts.json` so the next launch paints at once and then
 * revalidates against the live feed (ENG-175). Losing it only costs that first paint.
 *
 * Writes are asynchronous, atomic (a temp file, then a rename) and serialized; each
 * Host's JSON is kept, so a put encodes only its own Host (ENG-904).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { CachedHost } from "../shared/contract.ts";

const RawFile = Schema.Struct({ version: Schema.Literal(1), hosts: Schema.Array(Schema.Unknown) });

const decodeRaw = Schema.decodeUnknownOption(Schema.fromJsonString(RawFile));

const decodeHost = Schema.decodeUnknownOption(CachedHost);

const defaultEncodeHost = Schema.encodeSync(Schema.fromJsonString(CachedHost));

/** The file system calls a write makes; tests replace them to stop a write part-way. */
export interface CacheFiles {
  readonly mkdir: (dir: string) => Promise<void>;
  /** Writes the whole text and syncs it to disk. */
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
}

const nodeFiles: CacheFiles = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeFile: async (path, text) => {
    const handle = await open(path, "w");

    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename,
};

export interface SnapshotCacheOptions {
  /** One Host's JSON; a seam so tests can count which Hosts a put encodes. */
  readonly encodeHost?: (host: CachedHost) => string;
  readonly files?: CacheFiles;
  readonly onError?: (cause: unknown) => void;
}

export interface SnapshotCache {
  readonly get: () => ReadonlyArray<CachedHost>;
  /** Replaces one Host and schedules a write; returns before the disk is touched. */
  readonly put: (host: CachedHost) => void;
  /** Resolves once every put so far is on disk (or its write failed). */
  readonly flush: () => Promise<void>;
  /** A renderer answered `cache-flush` number `id`: it has sent every pending put (`cache.flushed`). */
  readonly rendererFlushed: (id: number) => void;
  /**
   * Before quit: `ask` sends the renderers `cache-flush` with `id`; waits for that
   * answer or `timeoutMs`, then for the writes, also bounded by `timeoutMs`.
   */
  readonly flushForQuit: (ask: (id: number) => void, timeoutMs: number) => Promise<void>;
}

interface Entry {
  readonly host: CachedHost;
  readonly json: string;
}

/** The file as it was, each Host with its JSON as stored; empty when missing or unreadable. */
const readEntries = (path: string): ReadonlyArray<Entry> => {
  if (!existsSync(path)) return [];

  return Option.match(decodeRaw(readFileSync(path, "utf8")), {
    onNone: () => [],
    onSome: (file) => {
      const entries: Array<Entry> = [];

      for (const raw of file.hosts) {
        const host = decodeHost(raw);

        if (Option.isNone(host)) return [];
        entries.push({ host: host.value, json: JSON.stringify(raw) });
      }

      return entries;
    },
  });
};

/** Waits for `promise`, at most `ms`. */
const within = async (promise: Promise<void>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
};

export const openSnapshotCache = (
  userData: string,
  options: SnapshotCacheOptions = {}
): SnapshotCache => {
  const encodeHost = options.encodeHost ?? defaultEncodeHost;
  const files = options.files ?? nodeFiles;

  const onError =
    options.onError ??
    ((cause: unknown) => console.error("polaris: snapshot cache write failed", cause));

  const dir = join(userData, "cache");
  const path = join(dir, "hosts.json");
  const part = `${path}.part`;

  const entries = new Map(readEntries(path).map((entry) => [entry.host.hostKey, entry]));
  let hosts: ReadonlyArray<CachedHost> = [...entries.values()].map((e) => e.host);

  let dirty = false;
  let writing: Promise<void> | null = null;
  let quitFlush: { readonly id: number; readonly resolve: () => void } | null = null;
  let quitFlushes = 0;

  // The same bytes as `Schema.encode(Schema.fromJsonString(CacheFile))` of the whole file.
  const text = () =>
    `{"version":1,"hosts":[${[...entries.values()].map((e) => e.json).join(",")}]}`;

  const writeOnce = async () => {
    const content = text();

    await files.mkdir(dir);
    await files.writeFile(part, content);
    await files.rename(part, path);
  };

  // One writer at a time; puts during a write mark it dirty, so the newest state lands last.
  const drain = async () => {
    try {
      while (dirty) {
        dirty = false;
        await writeOnce().catch(onError);
      }
    } finally {
      writing = null;
    }
  };

  const flush = () => writing ?? Promise.resolve();

  return {
    get: () => hosts,
    put: (host) => {
      const json = encodeHost(host);

      entries.delete(host.hostKey);
      entries.set(host.hostKey, { host, json });
      hosts = [...entries.values()].map((e) => e.host);
      dirty = true;
      writing ??= drain();
    },
    flush,
    rendererFlushed: (id) => {
      if (quitFlush?.id !== id) return;
      quitFlush.resolve();
      quitFlush = null;
    },
    flushForQuit: async (ask, timeoutMs) => {
      const id = ++quitFlushes;

      const answered = new Promise<void>((resolve) => {
        quitFlush = { id, resolve };
      });

      ask(id);
      await within(answered, timeoutMs);
      quitFlush = null;
      await within(flush(), timeoutMs);
    },
  };
};
