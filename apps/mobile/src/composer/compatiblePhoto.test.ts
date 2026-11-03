import { describe, expect, test } from "bun:test";
import { compatiblePhoto, type Picked } from "./attach.ts";

const photo = (name: string, mimeType: string): Picked => ({
  uri: "file:///original",
  name,
  mimeType,
  size: 900,
  isImage: true,
});

describe("compatible photos", () => {
  test.each(["heic", "heif", "avif", "webp"])(
    "replaces %s bytes and metadata together",
    async (extension) => {
      const converted = await compatiblePhoto(
        photo(`holiday.${extension}`, `image/${extension}`),
        async () => ({
          uri: "file:///converted.jpg",
          size: 321,
        })
      );

      expect(converted).toEqual({
        uri: "file:///converted.jpg",
        name: "holiday.jpg",
        mimeType: "image/jpeg",
        size: 321,
        isImage: true,
      });
    }
  );

  test.each(["image/jpeg", "image/png"])("keeps %s without asking for conversion", async (mime) => {
    const picked = photo("compatible", mime);
    expect(
      await compatiblePhoto(picked, async () => {
        throw new Error("must not convert");
      })
    ).toEqual(picked);
  });

  test("an incompatible filename overrides a picker's JPEG default", async () => {
    const converted = await compatiblePhoto(photo("holiday.HEIC", "image/jpeg"), async () => ({
      uri: "file:///new.jpg",
      size: 12,
    }));

    expect(converted.name).toBe("holiday.jpg");
    expect(converted.uri).toBe("file:///new.jpg");
  });

  test("a failed conversion cannot stage the incompatible original", async () => {
    await Promise.resolve(
      expect(
        compatiblePhoto(photo("broken.avif", "image/avif"), async () => {
          throw new Error("decode failed");
        })
      ).rejects.toThrow("decode failed")
    );
  });
});
