import { expect, test } from "bun:test";
import { externalWindowOpenHandler } from "./externalLinks.ts";

test.each([
  "http://localhost:3001/review?project=demo&view=review",
  "https://example.com/docs",
  "http://example.com/docs",
  "http://localhost:3000/",
  "http://127.0.0.1:5173/",
  "http://[::1]:3000/",
])("opens a popup in the user's browser without creating an app window: %s", (url) => {
  const opened: Array<string> = [];

  const handler = externalWindowOpenHandler(async (target) => {
    opened.push(target);
  });

  expect(handler({ url })).toEqual({ action: "deny" });
  expect(opened).toEqual([url]);
});

test.each([
  "file:///C:/notes.html",
  "javascript:alert(1)",
  "data:text/html,test",
  "polaris://session/a/b",
  "about:blank",
  "https://user:secret@example.com/",
  "http://",
  "localhost:3000",
])("does not hand a refused popup to the operating system: %s", (url) => {
  const opened: Array<string> = [];

  const handler = externalWindowOpenHandler(async (target) => {
    opened.push(target);
  });

  expect(handler({ url })).toEqual({ action: "deny" });
  expect(opened).toEqual([]);
});
