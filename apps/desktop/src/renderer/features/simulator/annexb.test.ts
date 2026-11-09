import { describe, expect, test } from "bun:test";
import { codecOfAnnexB, nalUnits, readAccessUnit } from "./annexb.ts";

const sps = [0x67, 0x42, 0xc0, 0x1f, 0xaa];

const pps = [0x68, 0xce, 0x3c, 0x80];

const idr = [0x65, 0x88, 0x84, 0x00, 0x00, 0x03, 0x01];

const keyframe = Uint8Array.from([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 1, ...idr]);

const message = (flags: number, unit: Uint8Array, magic = "SEMU") => {
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);

  header.set(Buffer.from(magic), 0);
  header[4] = 1;
  header[5] = flags;
  view.setBigUint64(8, 1_234_567n);

  return Uint8Array.from([...header, ...unit]);
};

describe("readAccessUnit", () => {
  test("reads serve-emu's v1 header: keyframe flag, pts and the unit after it", () => {
    const unit = readAccessUnit(message(1, keyframe));

    expect(unit?.keyframe).toBe(true);
    expect(unit?.timestampUs).toBe(1_234_567);
    expect([...(unit?.data ?? [])]).toEqual([...keyframe]);
  });

  test("a message without the SEMU magic is not a frame", () => {
    expect(readAccessUnit(message(0, keyframe, "XXXX"))).toBeNull();
    expect(readAccessUnit(new Uint8Array(16))).toBeNull();
  });
});

describe("nalUnits", () => {
  test("splits on 3- and 4-byte start codes, keeping emulation-prevented zeros", () => {
    expect(nalUnits(keyframe).map((nal) => [...nal])).toEqual([sps, pps, idr]);
  });
});

describe("codecOfAnnexB", () => {
  test("names the SPS's profile, constraints and level (Constrained Baseline 3.1)", () => {
    expect(codecOfAnnexB(keyframe)).toBe("avc1.42c01f");
  });

  test("a delta unit has no SPS", () => {
    expect(codecOfAnnexB(Uint8Array.from([0, 0, 0, 1, 0x41, 0x9a]))).toBeNull();
  });
});
