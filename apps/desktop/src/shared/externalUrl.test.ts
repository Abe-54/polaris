import { expect, test } from "bun:test";
import { externalUrl } from "./externalUrl.ts";

test.each([
  [
    "http://localhost:3001/review?project=demo&view=review",
    "http://localhost:3001/review?project=demo&view=review",
  ],
  ["https://example.com", "https://example.com/"],
  [
    "http://localhost:3000/path?q=hello%20world#result",
    "http://localhost:3000/path?q=hello%20world#result",
  ],
  ["http://127.0.0.1:5173/", "http://127.0.0.1:5173/"],
  ["http://[::1]:3000/", "http://[::1]:3000/"],
  ["HTTP://EXAMPLE.COM/path", "http://example.com/path"],
])("normalizes an external web URL: %s", (input, expected) => {
  expect(externalUrl(input)).toBe(expected);
});

test.each([
  "",
  "localhost:3000",
  "//example.com",
  "https:example.com",
  "http://",
  "file:///C:/notes.html",
  "javascript:alert(1)",
  "data:text/html,test",
  "polaris://session/a/b",
  "about:blank",
  "mailto:user@example.com",
  "https://user:secret@example.com/",
  "http://user@localhost:3000/",
  "https://example.com/with space",
  "https://example.com\n/",
  "https://example.com\u0000/",
  "https://example.com\\path",
])("refuses a non-web, malformed, or credential-bearing URL: %s", (input) => {
  expect(externalUrl(input)).toBeNull();
});
