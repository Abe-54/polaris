import { expect, test } from "bun:test";
import { darwinArgs, inspectTarget } from "./target.ts";

test("empty Node arguments do not consume its inspector opt-out environment", () => {
  const count = Buffer.alloc(4);
  count.writeInt32LE(4);

  const bytes = Buffer.concat([
    count,
    Buffer.from(
      "/usr/bin/node\0\0node\0server.cjs\0\0\0NODE_OPTIONS=--disable-sigusr1\0PATH=/bin\0"
    ),
  ]);

  const parsed = darwinArgs(bytes);
  expect(parsed.argv).toEqual(["node", "server.cjs", "", ""]);
  expect(parsed.env).toEqual(["NODE_OPTIONS=--disable-sigusr1", "PATH=/bin"]);
});

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "a PID cannot wrap to another process at the native inspection boundary",
  () => {
    expect(() => inspectTarget(2 ** 32 + process.pid, "not-a-capability")).toThrow(
      "Select another live Node process."
    );
  }
);
