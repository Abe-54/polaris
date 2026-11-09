import { expect, test } from "bun:test";
import { fromRegistry } from "./specifiers.ts";

test.each([
  ["^1.2.3", true],
  ["latest", true],
  ["workspace:*", true],
  ["catalog:", true],
  ["npm:other@^2", true],
  ["file:../x", false],
  ["link:../x", false],
  ["github:a/b", false],
  ["a/b", false],
  ["git+https://example.com/x.git", false],
  ["https://example.com/x.tgz", false],
  ["x.tgz", false],
  ["./x", false],
  ["workspace:../outside", false],
  ["workspace:^", true],
  ["catalog:react", true],
  ["catalog:../x", false],
  ["npm:a/b", false],
  ["npm:@scope/name@^1", true],
])("%s installs from the registry: %p", (spec, registry) => {
  expect(fromRegistry(spec)).toBe(registry);
});
