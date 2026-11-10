import { AppId, AppRef, BlobId, PreviewFrame, Unsupported } from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { lastFrame } from "./lastFrame.ts";

const frame = new PreviewFrame({
  blobId: BlobId.make("b1"),
  bytes: 3,
  width: 640,
  height: 400,
  capturedAt: "2026-11-10T12:00:01.000Z",
  app: new AppRef({ id: AppId.make("com.apple.iphonesimulator"), name: "Simulator" }),
  window: null,
});

const host = (latest: Effect.Effect<PreviewFrame | null, Unsupported>) => {
  const asked: Array<string> = [];

  return {
    asked,
    live: {
      latest: (sessionId: string) => {
        asked.push(sessionId);

        return latest;
      },
      take: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    },
  };
};

describe("the last frame beside a computer use approval", () => {
  test("keeps the session's latest frame and answers its file and size", async () => {
    const kept: Array<[string, ReadonlyArray<number>]> = [];
    const { live, asked } = host(Effect.succeed(frame));

    const shown = await lastFrame(live, "s1", async (name, bytes) => {
      kept.push([name, [...bytes]]);

      return `file:///cache/${name}`;
    });

    expect(asked).toEqual(["s1"]);
    expect(kept).toEqual([["s1-20261110120001000.jpg", [1, 2, 3]]]);
    expect(shown).toEqual({
      uri: "file:///cache/s1-20261110120001000.jpg",
      width: 640,
      height: 400,
    });
  });

  test.each([
    ["no frame yet", Effect.succeed(null)],
    ["a Host without capture", Effect.fail(new Unsupported({ capability: "computer-use" }))],
  ] as const)("shows none for %s, and keeps nothing", async (_, latest) => {
    const kept: Array<string> = [];

    const shown = await lastFrame(host(latest).live, "s1", async (name) => {
      kept.push(name);

      return name;
    });

    expect(shown).toBeNull();
    expect(kept).toEqual([]);
  });
});
