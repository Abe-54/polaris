import { describe, expect, test } from "bun:test";
import { gitHome } from "./discovery.ts";

const PROFILE = { HOMEDRIVE: "H:", HOMEPATH: "\\share", USERPROFILE: "C:\\Users\\ada" };

describe("where git takes ~ from", () => {
  test("is HOME wherever it is set", () => {
    expect(gitHome({ ...PROFILE, HOME: "D:\\home" }, "win32", () => true)).toBe("D:\\home");
    expect(gitHome({ HOME: "/home/ada" }, "linux")).toBe("/home/ada");
  });

  test("without HOME on Windows, is the home share when it exists, else the profile", () => {
    expect(gitHome(PROFILE, "win32", (path) => path === "H:\\share")).toBe("H:\\share");
    expect(gitHome(PROFILE, "win32", () => false)).toBe("C:\\Users\\ada");
  });

  test("without HOME elsewhere, is unknown: an include under ~ can't be stamped", () => {
    expect(gitHome(PROFILE, "linux", () => true)).toBeUndefined();
  });
});
