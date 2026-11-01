import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { polarisHome } from "../../paths.ts";
import { embeddedInstrumentation } from "./embedded.ts";

const prepared = new Map<string, Promise<string>>();

let bundled: Promise<Readonly<Record<string, string>>> | undefined;

/** Content-addressed, private files survive Daemon upgrades while Node apps still use their loader. */
export const materializeInstrumentation = async (
  assets: Readonly<Record<string, string>>,
  home: string
) => {
  const digest = createHash("sha256").update(JSON.stringify(assets)).digest("hex");
  const dir = join(home, "node-instrumentation", digest);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  for (const [name, source] of Object.entries(assets)) {
    const file = join(dir, name);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });

    try {
      await writeFile(file, source, { flag: "wx", mode: 0o600 });
    } catch (error) {
      const stat = await lstat(file).catch(() => null);

      if (!stat?.isFile() || stat.isSymbolicLink() || (await readFile(file, "utf8")) !== source)
        throw error;
    }
  }

  return join(dir, "register.mjs");
};

export const bundledRegisterPath = (home = polarisHome()) => {
  const existing = prepared.get(home);

  if (existing !== undefined) return existing;
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
