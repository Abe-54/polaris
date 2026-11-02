import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { openStorage } from "./storage.ts";
import { system32 } from "../platform/processes.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

// A protected Windows DACL replaces POSIX modes on this Host.
test.skipIf(process.platform !== "win32")(
  "Data source storage grants access only to the current Windows user",
  async () => {
    const root = newTempDir("data-acl-", { short: true });
    const path = join(root, "sources.sqlite");

    try {
      await Effect.runPromise(Effect.scoped(openStorage(path)));

      const acl = join(root, "sources.acl");
      execFileSync(system32("icacls.exe"), [path, "/save", acl, "/q"]);
      const rules = readFileSync(acl, "utf16le").trim().split(/\r?\n/).slice(1);

      // SDDL writes the built-in Administrator as LA, even when its account was renamed.
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatch(/^D:P\(A;;FA;;;[^)]+\)$/);

      const account = execFileSync(system32("whoami.exe"), [], { encoding: "utf8" })
        .trim()
        .toLowerCase();

      const entries = execFileSync(system32("icacls.exe"), [path], { encoding: "utf8" })
        .slice(path.length)
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line.includes(":("));

      expect(entries).toEqual([`${account}:(f)`]);
    } finally {
      removeTempDir(root);
    }
  }
);
