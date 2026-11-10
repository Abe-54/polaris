import { expect, test } from "bun:test";
import { decideUserAccess } from "./userAccess.ts";

test("an RPC or Command the table doesn't know needs user access", () => {
  expect(decideUserAccess("files.purge", null, false)?.what).toBe("files.purge");
  expect(decideUserAccess("dispatch", "ApproveEverything", false)?.what).toBe(
    "dispatch:ApproveEverything"
  );
  expect(decideUserAccess("dispatch", null, false)?.what).toBe("dispatch:");
});

test("a Daemon's own CLIs keep their RPCs without a key", () => {
  for (const rpc of ["host.resources.acquire", "constellation.stats", "extensions.list"])
    expect(decideUserAccess(rpc, null, false)).toBeNull();
});
