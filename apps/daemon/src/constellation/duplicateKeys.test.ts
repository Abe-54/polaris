import { expect, test } from "bun:test";
import { hasDuplicateKeys } from "./duplicateKeys.ts";

test.each([
  ['{"dependencies":{"a":"1"},"dependencies":{"b":"file:x"}}', true],
  ['{"a":{"x":"1","x":"2"}}', true],
  ['{"a\\u0062":"1","ab":"2"}', true],
  ['{"a":{"x":"1"},"b":{"x":"2"}}', false],
  ['{"a":["x","x"],"b":"{\\"a\\":1,\\"a\\":2}"}', false],
])("%s repeats a key: %p", (text, repeated) => {
  expect(hasDuplicateKeys(text)).toBe(repeated);
});
