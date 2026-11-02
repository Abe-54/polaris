import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostId, LanguageProcessLimit } from "@polaris/protocol";
import { Schema } from "effect";
import { createProcessSettings } from "./processSettings.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const hostId = HostId.make("budget-host");

const resources = {
  cpuCount: 12,
  totalMemoryBytes: 32 * 1024 ** 3,
  availableMemoryBytes: 8 * 1024 ** 3,
};

test("Host override persists revision CAS, races one winner, and null restores automatic", async () => {
  const root = newTempDir("polaris-process-settings-", { short: true });

  try {
    const settings = await createProcessSettings(hostId, root, resources);
    expect(settings.snapshot().effectiveLimit).toBe(19);

    const outcomes = await Promise.allSettled([
      settings.set(0, 12, async () => {}),
      settings.set(0, 16, async () => {}),
    ]);

    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    const recovered = await createProcessSettings(hostId, root, resources);
    expect(recovered.snapshot()).toEqual(settings.snapshot());
    expect(recovered.snapshot().revision).toBe(1);
    expect((await recovered.set(1, null, async () => {})).effectiveLimit).toBe(19);
    expect(JSON.parse(await readFile(join(root, "process-budget.json"), "utf8"))).toEqual({
      revision: 2,
      maxProcesses: null,
    });
    expect(Schema.is(LanguageProcessLimit)(0)).toBe(false);
    expect(Schema.is(LanguageProcessLimit)(33)).toBe(false);
  } finally {
    await removeTempDirSettled(root);
  }
});

test("lost mutation authority leaves Host configuration unchanged; corrupt persisted limits fail closed", async () => {
  const root = newTempDir("polaris-process-settings-", { short: true });

  try {
    const settings = await createProcessSettings(hostId, root, resources);
    let checks = 0;

    const rejected = await settings
      .set(0, 8, async () => {
        if (++checks === 2) throw new Error("Disconnected");
      })
      .then(
        () => null,
        (cause: unknown) => cause
      );

    expect(rejected).toMatchObject({ message: "Disconnected" });
    expect(settings.snapshot().revision).toBe(0);
    await writeFile(join(root, "process-budget.json"), '{"revision":1,"maxProcesses":0}');
    expect(
      await createProcessSettings(hostId, root, resources).then(
        () => "accepted",
        () => "rejected"
      )
    ).toBe("rejected");
  } finally {
    await removeTempDirSettled(root);
  }
});

test("persisted revisions and applied capacity share one serialized lane", async () => {
  const root = newTempDir("polaris-process-settings-", { short: true });
  const gate = Promise.withResolvers<void>();

  try {
    const settings = await createProcessSettings(hostId, root, resources);
    const applied: number[] = [];

    const first = settings.set(
      0,
      12,
      async () => {},
      async (limit) => {
        await gate.promise;
        applied.push(limit);
      }
    );

    const second = settings.set(
      1,
      16,
      async () => {},
      async (limit) => {
        applied.push(limit);
      }
    );

    gate.resolve();
    await Promise.all([first, second]);
    expect(applied).toEqual([12, 16]);
    expect(settings.snapshot()).toMatchObject({ revision: 2, effectiveLimit: 16 });
  } finally {
    gate.resolve();
    await removeTempDirSettled(root);
  }
});
