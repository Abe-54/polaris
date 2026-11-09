import { describe, expect, test } from "bun:test";
import { androidInput, iosInput, readIos, rotatedLeft } from "./protocol.ts";
import { hidUsage } from "./keys.ts";

const bytes = (tag: number, json?: string) =>
  Uint8Array.from([tag, ...(json === undefined ? [] : Buffer.from(json))]);

const decoded = (message: ReturnType<typeof iosInput.touch>) =>
  message.kind === "binary"
    ? [message.data[0], JSON.parse(Buffer.from(message.data.subarray(1)).toString())]
    : message.text;

describe("iOS input", () => {
  test("a touch is tag 0x03 with its phase and screen fractions", () => {
    expect(decoded(iosInput.touch("begin", 0.88, 0.395))).toEqual([
      0x03,
      { type: "begin", x: 0.88, y: 0.395 },
    ]);
  });

  test("home is tag 0x04 with the button the hub names", () => {
    expect(decoded(iosInput.button("home"))).toEqual([0x04, { button: "home" }]);
  });

  test("a barrier carries its request id", () => {
    expect(decoded(iosInput.barrier(7))).toEqual([0x11, { requestId: 7 }]);
  });
});

describe("readIos", () => {
  test("0x83 alone is admission", () => {
    expect(readIos(Uint8Array.of(0x83))).toEqual({ kind: "admitted" });
  });

  test("0x82 is the config the 17 Pro sent", () => {
    expect(
      readIos(
        bytes(
          0x82,
          '{"width":1206,"height":2622,"orientation":"portrait","inputUnavailable":false}'
        )
      )
    ).toEqual({
      kind: "config",
      config: { width: 1206, height: 2622, orientation: "portrait", inputUnavailable: false },
    });
  });

  test("an orientation the client doesn't know reads as none", () => {
    const event = readIos(bytes(0x82, '{"width":1,"height":2,"orientation":"sideways"}'));

    expect(event.kind === "config" && event.config.orientation).toBeNull();
  });

  test.each([
    [bytes(0x91, '{"requestId":7,"ok":true}'), { requestId: 7, ok: true }],
    [bytes(0x91, '{"requestId":3,"ok":false}'), { requestId: 3, ok: false }],
    [Uint8Array.of(0x91, 1), { requestId: null, ok: true }],
    [Uint8Array.of(0x91, 0), { requestId: null, ok: false }],
  ])("0x91 is a barrier answer (%#)", (data, answer) => {
    expect(readIos(data)).toEqual({ kind: "barrier", ...answer });
  });

  test("a config that isn't JSON is ignored", () => {
    expect(readIos(bytes(0x82, "{nope"))).toEqual({ kind: "other" });
  });
});

describe("Android input", () => {
  test("a touch is serve-emu's down/move/up gesture, without acks", () => {
    const message = androidInput.touch("end", 0.5, 0.25);

    expect(message.kind === "text" && JSON.parse(message.text)).toEqual({
      type: "touch",
      action: "up",
      x: 0.5,
      y: 0.25,
      ack: false,
    });
  });

  test("lock is the power key", () => {
    const message = androidInput.button("lock");

    expect(message.kind === "text" && JSON.parse(message.text)).toMatchObject({ type: "power" });
  });
});

describe("rotatedLeft", () => {
  test("four quarter turns come back to portrait", () => {
    const turns = [rotatedLeft(null)];

    for (let i = 0; i < 3; i++) turns.push(rotatedLeft(turns.at(-1)!));
    expect(turns).toEqual([
      "landscape_left",
      "portrait_upside_down",
      "landscape_right",
      "portrait",
    ]);
  });
});

describe("hidUsage", () => {
  test.each([
    ["KeyA", 4],
    ["KeyZ", 29],
    ["Digit1", 30],
    ["Digit9", 38],
    ["Digit0", 39],
    ["F1", 58],
    ["F12", 69],
    ["Enter", 40],
    ["Backspace", 42],
    ["ArrowUp", 82],
    ["ShiftLeft", 225],
  ])("%s is usage %i", (code, usage) => {
    expect(hidUsage(code)).toBe(usage);
  });

  test("a key with no HID usage here is not sent", () => {
    expect(hidUsage("MediaPlayPause")).toBeNull();
    expect(hidUsage("F13")).toBeNull();
  });
});
