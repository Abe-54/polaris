import { expect, test } from "bun:test";
import { forgetCopy, unlinkNote } from "./model.ts";

test("Unlink names the hosts that still trust this iPhone, and says nothing when none do", () => {
  expect(unlinkNote([])).toBeNull();
  expect(unlinkNote(["Pi 4"])).toBe(
    "Still linked to Pi 4: it didn't answer. Unlink again when it's online, or unlink this iPhone on your Mac in Settings → Devices."
  );
});

test("forgetting a host that didn't answer says it still trusts this iPhone until the Mac unlinks it", () => {
  const one = forgetCopy(["Pi 4"]);

  expect(one.title).toBe("Forget Pi 4 on this iPhone?");
  expect(one.message).toBe(
    "Its agent sessions leave this list, and you can link it again. Pi 4 still trusts this iPhone. To end that, unlink it on your Mac in Settings → Devices."
  );
  expect(one.done).toBe(
    "Forgot Pi 4 on this iPhone. Pi 4 still trusts this iPhone. To end that, unlink it on your Mac in Settings → Devices."
  );
  expect(forgetCopy(["Pi 4", "Linux VM"]).message).toBe(
    "Their agent sessions leave this list, and you can link them again. Pi 4, Linux VM still trust this iPhone. To end that, unlink it on your Mac in Settings → Devices."
  );
});
