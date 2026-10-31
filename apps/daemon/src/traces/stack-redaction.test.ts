import { expect, test } from "bun:test";
import { attributeValue, redactText } from "./redact.ts";

// Captured from Node 24.22.1 CommonJS and Bun 1.4.4; only the checkout prefix is normalized.
const frames = [
  "    at login (/app/src/auth.cjs:1:26)\n    at Object.<anonymous> (/app/src/auth.cjs:2:7)",
  "    at login (/app/src/auth.ts:1:30)\n    at /app/src/auth.ts:2:7",
  "    at load (/app/src/session.ts:40:3)",
  "    at refresh (/app/src/tokens.ts:8:1)",
  "    at /app/src/session.js:40:3",
];

test.each(frames)("exception stack retains source locations: %s", (frame) => {
  const stack = `Error: denied\n${frame}`;
  expect(attributeValue({ stringValue: stack })).toBe(stack);
  expect(redactText(stack)).toBe(stack);
});

test.each([
  "auth.ts:123:456",
  "session.ts: secret",
  "    at login (/app/src/auth.ts:secret)",
  "    at login (/app/src/auth.ts:12:9?token=secret)",
  "Error: password=secret\n    at login (/app/src/auth.ts:12:9)",
])("stack recognition still redacts credentials: %s", (value) => {
  expect(attributeValue({ stringValue: value })).toBe("[redacted]");
});
