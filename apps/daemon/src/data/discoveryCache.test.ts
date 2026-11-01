import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cachedDiscovery } from "./discoveryCache.ts";
import { parseConnection } from "./connection.ts";
import { discover } from "./discovery.ts";

test("unchanged checkouts reuse discovery, while env and compose changes invalidate it", async () => {
  const root = await mkdtemp("/tmp/polaris-discovery-cache-");
  let reads = 0;

  const cached = cachedDiscovery(async (checkout, signal) => {
    reads++;

    return discover(checkout, signal);
  });

  try {
    await writeFile(join(root, ".env"), "DATABASE_URL=postgres://u:p@localhost/one\n");
    expect(parseConnection((await cached(root))[0]!)?.connection.database).toBe("one");
    await cached(root);
    expect(reads).toBe(1);
    await writeFile(join(root, ".env"), "DATABASE_URL=postgres://u:p@localhost/two\n");
    const changed = await cached(root);
    expect(parseConnection(changed[0]!)?.connection.database).toBe("two");
    expect(reads).toBe(2);
    await writeFile(join(root, "compose.yaml"), "services:\n  db:\n    image: postgres:16\n");
    await cached(root);
    expect(reads).toBe(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
