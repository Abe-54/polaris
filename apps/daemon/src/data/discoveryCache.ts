/** Event-driven discovery cache: file metadata invalidates candidates without polling or watchers. */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { discover } from "./discovery.ts";

export async function discoveryStamp(checkout: string) {
  const entries = await readdir(checkout, { withFileTypes: true }).catch(() => []);

  const names = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.staging",
    ".env.test",
    "compose.yaml",
    "compose.yml",
    "docker-compose.yml",
    "docker-compose.yaml",
    "schema.prisma",
    "prisma/schema.prisma",
    "drizzle.config.ts",
    "drizzle.config.js",
    "drizzle.config.mjs",
    "config/database.yml",
    "settings.py",
    ...entries
      .filter(
        (x) =>
          x.isDirectory() && !x.name.startsWith(".") && !["node_modules", "vendor"].includes(x.name)
      )
      .map((x) => `${x.name}/settings.py`),
  ];

  return JSON.stringify(
    await Promise.all(
      names.sort().map(async (name) => {
        const info = await stat(join(checkout, name)).catch(() => null);

        return [name, info?.ino, info?.size, info?.mtimeMs, info?.ctimeMs];
      })
    )
  );
}

export function cachedDiscovery(read: typeof discover) {
  const cache = new Map<string, { stamp: string; value: Awaited<ReturnType<typeof discover>> }>();

  return async (checkout: string, signal?: AbortSignal) => {
    const stamp = await discoveryStamp(checkout);
    const hit = cache.get(checkout);

    if (hit?.stamp === stamp) return hit.value;
    const value = await read(checkout, signal);

    // A file changed during discovery: don't cache a mixture of two configurations.
    if (stamp === (await discoveryStamp(checkout))) {
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(checkout, { stamp, value });
    }

    return value;
  };
}
