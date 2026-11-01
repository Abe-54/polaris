import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, lstat, rename, rm, readdir, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { polarisHome } from "../../paths.ts";
import { embeddedInstrumentation } from "./embedded.ts";

const prepared = new Map<string, Promise<string>>();

let bundled: Promise<Readonly<Record<string, string>>> | undefined;

const writeAsset = async (file: string, source: string) => {
  const stat = await lstat(file).catch(() => null);

  if (
    stat?.isFile() &&
    !stat.isSymbolicLink() &&
    (await readFile(file, "utf8").catch(() => null)) === source
  )
    return;
  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
};

const prune = async (root: string, current: string) => {
  const entries = await readdir(root, { withFileTypes: true });

  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
      .map(async (entry) => ({
        path: join(root, entry.name),
        modified: (await lstat(join(root, entry.name))).mtimeMs,
      }))
  );

  const older = directories
    .filter((entry) => entry.path !== current)
    .sort((a, b) => b.modified - a.modified);

  await Promise.all(
    older.slice(2).map((entry) => rm(entry.path, { recursive: true, force: true }))
  );
};

/** Atomically repair partial assets; keep this digest and the two most recently used builds. */
export const materializeInstrumentation = async (
  assets: Readonly<Record<string, string>>,
  home: string
) => {
  const digest = createHash("sha256").update(JSON.stringify(assets)).digest("hex");
  const root = join(home, "node-instrumentation");
  const dir = join(root, digest);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  for (const [name, source] of Object.entries(assets)) {
    const file = join(dir, name);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeAsset(file, source);
  }

  const now = new Date();
  await utimes(dir, now, now);
  await prune(root, dir).catch(() => {});

  return join(dir, "register.mjs");
};

export const bundledRegisterPath = async (home = polarisHome()) => {
  const existing = prepared.get(home);

  if (existing !== undefined) {
    const path = await existing;

    if ((await lstat(path).catch(() => null))?.isFile()) return path;
    prepared.delete(home);
  }

  bundled ??= (async () =>
    embeddedInstrumentation ?? (await (await import("./build.ts")).buildInstrumentationAssets()))();

  const promise = bundled
    .then((assets) => materializeInstrumentation(assets, home))
    .catch((error) => {
      prepared.delete(home);
      throw error;
    });

  if (prepared.size >= 32) prepared.delete(prepared.keys().next().value!);
  prepared.set(home, promise);

  return promise;
};
