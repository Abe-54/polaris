import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

      const script =
        "$acl = Get-Acl -LiteralPath $env:POLARIS_DATA_ACL_TEST; $acl.AreAccessRulesProtected; $acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }";

      const lines = execFileSync(
        system32(join("WindowsPowerShell", "v1.0", "powershell.exe")),
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          env: { ...process.env, POLARIS_DATA_ACL_TEST: path },
          encoding: "utf8",
        }
      )
        .trim()
        .split(/\r?\n/);

      expect(lines).toEqual(["True", thisUserSid()]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
