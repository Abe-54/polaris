import { expect } from "bun:test";
import { fixture } from "./fixture.testing.ts";
import { posixTest } from "../../platform/testing.ts";

const test = posixTest(
  "language storage is checked private by POSIX owner and mode bits; Windows needs ACL checks (ENG-314)"
);

const gate = () => {
  let open = () => {};

  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { open, opened };
};

test("a job launched while a recovery scan runs is not reported as debris", async () => {
  const scanPaused = gate();
  const scanResume = gate();
  const downloading = gate();
  const downloadResume = gate();
  let scans = 0;

  const f = await fixture({
    async beforeRecoveryScan() {
      if (++scans > 1) return;
      scanPaused.open();
      await scanResume.opened;
    },
    async *download() {
      downloading.open();
      await downloadResume.opened;
      yield f.source.bytes;
    },
  });

  try {
    const scan = f.installer.recoveryFacts("fake-tool");
    await scanPaused.opened;
    const handle = f.installer.install(f.request);
    await downloading.opened;
    expect((await f.debris()).some((file) => file.endsWith("/install.lock"))).toBe(true);
    scanResume.open();
    expect(await scan).toEqual([]);
    downloadResume.open();
    await handle.result;
    expect(await f.installer.recoveryFacts("fake-tool")).toEqual([]);
  } finally {
    scanResume.open();
    downloadResume.open();
    await f.close();
  }
});
