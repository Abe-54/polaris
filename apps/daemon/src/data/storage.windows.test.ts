import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { shortTemp } from "../platform/testing.ts";
import { join } from "node:path";
import { Effect } from "effect";
import { openStorage } from "./storage.ts";
import { system32 } from "../platform/processes.ts";
import { thisUserSid } from "../platform/windowsNative.ts";

// A protected Windows DACL replaces POSIX modes on this Host.
test.skipIf(process.platform !== "win32")(
  "Data source storage grants access only to the current Windows user",
  async () => {
    const root = mkdtempSync(shortTemp("data-acl-"));
    const path = join(root, "sources.sqlite");

    try {
      await Effect.runPromise(Effect.scoped(openStorage(path)));

      const acl = join(root, "sources.acl");
      execFileSync(system32("icacls.exe"), [path, "/save", acl, "/q"]);
      const rules = readFileSync(acl, "utf16le").trim().split(/\r?\n/).slice(1);

      expect(rules).toEqual([`D:P(A;;FA;;;${thisUserSid()})`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
