import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { BYTE_STREAM_MAX_WINDOW_BYTES, ByteStreamWindow } from "./byteStreams.ts";
import { isHostAddress, loopbackAddressesOf } from "./hostAddress.ts";

describe("loopbackAddressesOf", () => {
  const both = ["127.0.0.1", "::1"];

  test.each([
    ["localhost", both],
    ["LocalHost.", both],
    ["app.localhost", both],
    ["api.my-app.localhost", both],
    ["127.0.0.1", ["127.0.0.1"]],
    ["127.255.0.9", ["127.0.0.1"]],
    ["::1", ["::1"]],
    ["[::1]", ["::1"]],
    ["0:0:0:0:0:0:0:1", ["::1"]],
    ["::ffff:127.0.0.1", ["::1"]],
    ["::ffff:7f00:1", ["::1"]],
    ["[::FFFF:7F00:0001]", ["::1"]],
  ])("%s is a Host address on %j", (hostname, addresses) => {
    expect<readonly string[] | null>(loopbackAddressesOf(hostname)).toEqual(addresses);
    expect(isHostAddress(hostname)).toBe(true);
  });

  // Names that resolve to loopback or to the LAN are refused alike: resolution never happens.
  test.each([
    "evil.example",
    "polaris.test",
    "myhost.lan",
    "192.168.1.10",
    "10.0.0.1",
    "0.0.0.0",
    "127.0.0.256",
    "127.1",
    "localhost.evil.example",
    "127.0.0.1.evil.example",
    "::2",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "::ffff:7e00:1",
    "evil .localhost",
    "_x.localhost",
    ".localhost",
    "",
  ])("%s is not a Host address", (hostname) => {
    expect(loopbackAddressesOf(hostname)).toBeNull();
    expect(isHostAddress(hostname)).toBe(false);
  });
});

test("a window beyond the maximum is refused at the schema", () => {
  const decode = Schema.decodeUnknownOption(ByteStreamWindow);

  expect(decode(BYTE_STREAM_MAX_WINDOW_BYTES)._tag).toBe("Some");
  expect(decode(BYTE_STREAM_MAX_WINDOW_BYTES + 1)._tag).toBe("None");
  expect(decode(0)._tag).toBe("None");
});
