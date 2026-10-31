import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { polarisHome } from "../../paths.ts";
import { embeddedInstrumentation } from "./embedded.ts";

let prepared: Promise<string> | undefined;

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

export const bundledRegisterPath = () => {
  prepared ??= (async () => {
    const assets =
      embeddedInstrumentation ?? (await (await import("./build.ts")).buildInstrumentationAssets());

    return materializeInstrumentation(assets, polarisHome());
  })().catch((error) => {
    prepared = undefined;
    throw error;
  });

  return prepared;
};
