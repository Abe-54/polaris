import { expect, test } from "bun:test";
import { commitMessageText } from "./commitMessage.ts";

test("the Commit box's text is the subject, a blank line, then the body", () => {
  expect(commitMessageText({ subject: "Fix", body: "" })).toBe("Fix");
  expect(commitMessageText({ subject: "Fix", body: "Why." })).toBe("Fix\n\nWhy.");
});
