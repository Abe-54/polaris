import { expect, test } from "bun:test";
import { unlinkNote } from "./model.ts";
import { deviceCopyFor } from "../app/deviceCopy.ts";

test("Unlink names the hosts that still trust this iPhone, and says nothing when none do", () => {
  expect(unlinkNote([])).toBeNull();
  expect(unlinkNote(["Pi 4"])).toBe(
    "Still linked to Pi 4: it didn't answer. Unlink again when it's online, or unlink this iPhone on your Mac in Settings → Devices."
  );
});

test("Android unlink failures name this phone and the computer, including multiple hosts", () => {
  const copy = deviceCopyFor("android");

  expect(unlinkNote([], copy)).toBeNull();
  expect(unlinkNote(["Pi 4"], copy)).toBe(
    "Still linked to Pi 4: it didn't answer. Unlink again when it's online, or unlink this phone on your computer in Settings → Devices."
  );
  expect(unlinkNote(["Pi 4", "Linux VM"], copy)).toBe(
    "Still linked to Pi 4, Linux VM: they didn't answer. Unlink again when they're online, or unlink this phone on your computer in Settings → Devices."
  );
});
