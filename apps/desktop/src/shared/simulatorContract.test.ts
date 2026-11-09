import { expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { SimulatorSubscriptionInputs } from "./simulatorContract.ts";

const decode = Schema.decodeUnknownOption(SimulatorSubscriptionInputs["simulator.video"]);

const video = (token: string) =>
  decode({ hostKey: "local", port: 47811, token, id: "B84CD956", format: "avcc" });

test("a hub token is accepted as the hub mints it", () => {
  expect(Option.isSome(video("S3qU27TEIO69-x_y.z~+/=="))).toBe(true);
});

test.each(["abc\r\nX-Injected: 1", "abc def", ""])(
  "a token that would break the request head is refused (%j)",
  (token) => {
    expect(Option.isNone(video(token))).toBe(true);
  }
);
