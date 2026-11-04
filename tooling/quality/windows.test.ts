import { expect, test } from "bun:test";
import { join } from "node:path";
import { planWindowsTests, windowsLists } from "./windows.ts";

const { posixOnly, windowsFiles } = windowsLists(join(import.meta.dir, "..", ".."));

test("on Windows a push tests the changed packages but the POSIX-only ones, whose listed files run", () => {
  const plan = planWindowsTests(
    [
      { task: "test", name: "@polaris/mobile", directory: "apps/mobile" },
      { task: "test", name: "@polaris/protocol", directory: "packages/protocol" },
      { task: "test", name: "@polaris/client", directory: "packages/client" },
      { task: "test", name: "@polaris/desktop", directory: "apps/desktop" },
      // An unchanged package whose build a test needs, and a package listed once per task.
      { task: "build", name: "@polaris/sdk", directory: "packages/sdk" },
      { task: "test", name: "@polaris/client", directory: "packages/client" },
      { task: "test", name: "@polaris/mobile", directory: "apps/mobile" },
    ],
    posixOnly,
    windowsFiles
  );

  expect(plan.packages).toEqual(["@polaris/mobile", "@polaris/protocol"]);
  expect(plan.skipped).toEqual(["@polaris/client", "@polaris/desktop"]);
  expect(plan.files).toContain("packages/client/src/connection.test.ts");
  expect(plan.files).toContain("apps/desktop/src/shared");
  // A listed file of a package tested whole isn't run twice.
  expect(plan.files.some((file) => file.startsWith("packages/protocol"))).toBe(false);
});

test("a changed package that only shares a prefix with a POSIX-only one is tested", () => {
  const plan = planWindowsTests(
    [{ task: "test", name: "@polaris/client-extra", directory: "packages/client-extra" }],
    posixOnly,
    windowsFiles
  );

  expect(plan).toEqual({ packages: ["@polaris/client-extra"], skipped: [], files: [] });
});
