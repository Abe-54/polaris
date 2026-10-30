import { describe, expect, test } from "bun:test";
import {
  chipsOf,
  COPY_EXISTS,
  copyArgv,
  copyOutcome,
  dropMode,
  fileName,
  formatSize,
  joinPath,
  uploadLine,
} from "./model.ts";

describe("attachments", () => {
  test("⌥ copies only where copying is offered", () => {
    expect(dropMode(true, true)).toBe("copy");
    expect(dropMode(true, false)).toBe("attach");
    expect(dropMode(false, true)).toBe("attach");
  });

  test("pasted images get a name with their type", () => {
    expect(fileName("", "image/png", 0)).toBe("pasted-1.png");
    expect(fileName("", "image/jpeg", 1)).toBe("pasted-2.jpeg");
    expect(fileName("", "application/octet-stream", 0)).toBe("pasted-1");
    expect(fileName("shot.png", "image/png", 3)).toBe("shot.png");
  });

  test("sizes read in the largest whole unit", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(300 * 1024)).toBe("300 KB");
    expect(formatSize(12 * 1024 * 1024)).toBe("12 MB");
  });

  test("the upload line names one file, counts several", () => {
    const up = (name: string, copy = false) => ({ key: 0, name, size: 1, copy });

    expect(uploadLine([])).toBeNull();
    expect(uploadLine([up("a.png")])).toBe("Attaching a.png…");
    expect(uploadLine([up("a"), up("b")])).toBe("Attaching 2 files…");
    expect(uploadLine([up("a", true)])).toBe("Copying a…");
  });

  test("the copy passes paths as arguments, never inside the script", () => {
    const argv = copyArgv("/home/me/.polaris/staging/s/x", "/repo/it's here.txt");

    expect(argv[0]).toBe("/bin/sh");
    expect(argv[2]).not.toContain("it's");
    expect(argv.slice(4)).toEqual(["/home/me/.polaris/staging/s/x", "/repo/it's here.txt"]);
  });

  test("joined paths keep the name one segment", () => {
    expect(joinPath("/repo/", "a/b.txt")).toBe("/repo/a_b.txt");
  });

  test("copy outcomes say what happened", () => {
    expect(copyOutcome(0, "a.txt", "~/repo").ok).toBe(true);
    expect(copyOutcome(COPY_EXISTS, "a.txt", "~/repo").message).toBe("~/repo already has one");
    expect(copyOutcome(null, "a.txt", "~/repo").title).toBe("Couldn't copy a.txt");
  });
});

describe("composer chips", () => {
  const file = (id: string, mimeType: string) => ({ id, mimeType });

  const picked = (id: string, mimeType: string, key: string) => ({
    id,
    mimeType,
    pick: { key, selector: "#add", url: "http://localhost:3000/", html: "" },
  });

  test("a pick's screenshot and note are one chip, shown by the screenshot", () => {
    const chips = chipsOf([
      file("a", "text/plain"),
      picked("note", "text/markdown", "p1"),
      picked("shot", "image/png", "p1"),
      file("b", "image/png"),
    ]);

    expect(chips.map((c) => [c.key, c.files.map((f) => f.id), c.image?.id ?? null])).toEqual([
      ["a", ["a"], null],
      ["p1", ["note", "shot"], "shot"],
      ["b", ["b"], null],
    ]);
  });
});
