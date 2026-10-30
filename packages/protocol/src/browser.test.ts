import { expect, test } from "bun:test";
import { Schema } from "effect";
import { NoDesktopApp } from "./browser.ts";
import { SessionId } from "./ids.ts";

test("a browser tool call without a Desktop App fails with the product copy, after the wire too", () => {
  const sent = new NoDesktopApp({ sessionId: SessionId.make("s1") });
  const wire = Schema.encodeSync(NoDesktopApp)(sent);
  const received = Schema.decodeUnknownSync(NoDesktopApp)(JSON.parse(JSON.stringify(wire)));

  expect(received.message).toBe("No Desktop App is connected to show this Browser.");
  expect(String(received)).toContain("No Desktop App is connected to show this Browser.");
});
