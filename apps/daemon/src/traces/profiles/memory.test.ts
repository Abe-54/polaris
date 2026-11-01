import { shortTemp } from "../../platform/testing.ts";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { Profile, ProfileId, Timestamp } from "@polaris/protocol";
import { profileDirectory } from "./workerClient.ts";

const Measurement = Schema.Struct({
  elapsedMs: Schema.Number,
  peakRssMiB: Schema.Number,
  status: Schema.String,
});

test("P4-6: largest in-bounds artifact stays below 700 MiB peak RSS in the real profile worker", async () => {
  const root = await mkdtemp(shortTemp("profile-memory-"));
  const id = ProfileId.make(crypto.randomUUID());

  try {
    const directory = await profileDirectory(root, "/checkout", id);
    await mkdir(directory, { recursive: true });

    const profile = Profile.make({
      id,
      command: "node memory",
      runtime: "node",
      pid: 123,
      turn: null,
      startedAt: Timestamp.make(new Date(Date.now() - 60_000).toISOString()),
      durationMs: 0,
      path: null,
      status: "recording",
    });

    await writeFile(join(directory, "profile.json"), JSON.stringify(profile));

    const nodes = Array.from({ length: 200_000 }, (_, i) => ({
      id: i,
      callFrame: { functionName: `f${i}`, url: "", lineNumber: 0 },
      children:
        i < 254 ? [i + 1] : i === 254 ? Array.from({ length: 199_745 }, (_, j) => j + 255) : [],
    }));

    const raw = JSON.stringify({
      startTime: 0,
      endTime: 2_000_000,
      nodes,
      samples: Array(2_000_000).fill(199_999),
      timeDeltas: Array(2_000_000).fill(1),
    });

    const bytes = 64 * 1024 * 1024;
    await writeFile(
      join(directory, "cpu.cpuprofile"),
      raw + " ".repeat(bytes - Buffer.byteLength(raw))
    );

    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "memory.probe.ts"), root, id],
      { stdout: "pipe", stderr: "pipe" }
    );

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    const measurement = Schema.decodeUnknownSync(Schema.fromJsonString(Measurement))(stdout);
    console.log(
      JSON.stringify({
        artifactBytes: bytes,
        cpuNodes: nodes.length,
        samples: 2_000_000,
        depth: 256,
        ...measurement,
      })
    );
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(measurement.status).toBe("completed");
    expect(measurement.peakRssMiB).toBeLessThan(700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
