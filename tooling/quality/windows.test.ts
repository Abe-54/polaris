import { expect, test } from "bun:test";
import { join } from "node:path";
import { planWindowsTests, windowsLists } from "./windows.ts";

const { posixOnly, windowsFiles } = windowsLists(join(import.meta.dir, "..", ".."));

test("on Windows a push tests the changed packages but the POSIX-only ones, whose listed files run", () => {
  const plan = planWindowsTests(
    [
      { name: "@polaris/mobile", directory: "apps/mobile" },
      { name: "@polaris/client", directory: "packages/client" },
      { name: "@polaris/desktop", directory: "apps/desktop" },
    ],
    posixOnly,
    windowsFiles
  );

  expect(plan.packages).toEqual(["@polaris/mobile"]);
  expect(plan.skipped).toEqual(["@polaris/client", "@polaris/desktop"]);
  expect(plan.files).toContain("packages/client/src/connection.test.ts");
  expect(plan.files).toContain("apps/desktop/src/shared");
  // A listed file of a package tested whole isn't run twice.
  expect(plan.files.some((file) => file.startsWith("packages/protocol"))).toBe(false);
});

test("a changed package that only shares a prefix with a POSIX-only one is tested", () => {
  const plan = planWindowsTests(
    [{ name: "@polaris/client-extra", directory: "packages/client-extra" }],
    posixOnly,
    windowsFiles
  );

  expect(plan).toEqual({ packages: ["@polaris/client-extra"], skipped: [], files: [] });
});
