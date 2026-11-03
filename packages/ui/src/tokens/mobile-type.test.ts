import { expect, test } from "bun:test";
import { createMobileType, mobileFont, mobileType, resolveMobileFonts } from "./mobile-type.ts";

test("Android selects native families for every type role without changing its metrics", () => {
  const font = resolveMobileFonts("android");
  expect(font).toEqual({ sans: "sans-serif", mono: "monospace" });
  const android = createMobileType(font);

  for (const [role, style] of Object.entries(android)) {
    const original = Object.entries(mobileType).find(([name]) => name === role)?.[1];

    if (!original) throw new Error(`Unexpected type role: ${role}`);

    expect(style).toEqual({
      ...original,
      fontFamily: role === "command" || role === "index" ? "monospace" : "sans-serif",
    });
  }
});

test.each(["ios", "web"])("%s retains the existing system designs and scale", (platform) => {
  expect(resolveMobileFonts(platform)).toEqual({ sans: "system-ui", mono: "ui-monospace" });
  expect(createMobileType(resolveMobileFonts(platform))).toEqual(mobileType);
  expect(mobileFont).toEqual({ sans: "system-ui", mono: "ui-monospace" });
});
