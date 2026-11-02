/** Event-driven discovery cache: file metadata invalidates candidates without polling or watchers. */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { discover, discoveryFiles } from "./discovery.ts";
import { findPackages } from "./packages.ts";

export async function discoveryStamp(checkout: string, packages: ReadonlyArray<string> = []) {
  const names = (
    await Promise.all(["", ...packages].map((dir) => discoveryFiles(checkout, dir)))
  ).flat();

  return JSON.stringify([
    packages,
    await Promise.all(
      names.sort().map(async (name) => {
        const info = await stat(join(checkout, name)).catch(() => null);

        return [name, info?.ino, info?.size, info?.mtimeMs, info?.ctimeMs];
      })
    ),
  ]);
}

export function cachedDiscovery(read: typeof discover, packages = findPackages) {
  const cache = new Map<string, { stamp: string; value: Awaited<ReturnType<typeof discover>> }>();

  return async (checkout: string, signal?: AbortSignal) => {
    const dirs = await packages(checkout, signal);
    const stamp = await discoveryStamp(checkout, dirs);
    const hit = cache.get(checkout);

    if (hit?.stamp === stamp) return hit.value;
    const value = await read(checkout, signal, dirs);

    // A file changed during discovery: don't cache a mixture of two configurations.
    if (stamp === (await discoveryStamp(checkout, dirs))) {
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(checkout, { stamp, value });
    }

    return value;
  };
}
