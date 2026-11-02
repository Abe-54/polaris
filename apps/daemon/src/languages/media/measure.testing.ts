/** Isolated demand measurement; run only under the Lead-released m31-bench lease. */
import { writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { BlobId, LanguageCheckout, WorkspaceId } from "@polaris/protocol";
import { Effect, Match, Stream } from "effect";
import { BlobChannel } from "../../services.ts";
import { readRange, ReadContent } from "../../files/fs.ts";
import { createHostPreviewMedia, PreviewMediaAuthority } from "./index.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const root = newTempDir("m31-h1-measure-", { short: true });

const checkout = LanguageCheckout.cases.Workspace.make({
  workspaceId: WorkspaceId.make("fake-media-measure"),
  path: root,
});

const documentPath = join(root, "a.md");

const path = join(root, "a.png");

const signal = new AbortController().signal;

const authority = PreviewMediaAuthority.of({
  authorize: async () => ({ checkout, workspacePath: root }),
});

let offered = 0;

const blobs = BlobChannel.of({
  offer: (bytes) =>
    Effect.gen(function* () {
      const data =
        bytes instanceof Uint8Array
          ? bytes
          : Buffer.concat(yield* Stream.runCollect(bytes).pipe(Effect.orDie));

      offered += data.byteLength;

      return BlobId.make("fake-measure-blob");
    }),
  take: () => Effect.die("unused"),
  takeStream: () => Stream.die("unused"),
});

const service = createHostPreviewMedia();

const records: Array<{ size: number; controlMs: number[][]; mediaMs: number[][] }> = [];

const descriptorsBefore = readdirSync("/dev/fd").length;

const memoryBefore = process.memoryUsage();

async function control() {
  const result = await readRange(path, null, null);

  const bytes = await ReadContent.$match(result.content, {
    Inline: ({ text }) => Promise.resolve(new TextEncoder().encode(text)),
    Bytes: ({ bytes }) => Promise.resolve(bytes),
    Range: async ({ path, start, end }) =>
      new Uint8Array(await Bun.file(path).slice(start, end).arrayBuffer()),
  });

  offered += bytes.byteLength;
}

async function media(size: number) {
  await Effect.runPromise(
    service
      .read({ checkout, documentPath, relativePath: "a.png", maxBytes: size })
      .pipe(
        Effect.provideService(PreviewMediaAuthority, authority),
        Effect.provideService(BlobChannel, blobs)
      ),
    { signal }
  );
}

async function sample(run: () => Promise<void>) {
  const times: number[] = [];

  for (let index = 0; index < 15; index++) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }

  return times;
}

try {
  await writeFile(documentPath, "![fixture](a.png)");

  for (const size of [128, 1048576, 10485760]) {
    const bytes = Buffer.alloc(size);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(path, bytes);
    await control();
    await media(size);
    const controlMs: number[][] = [];
    const mediaMs: number[][] = [];

    for (let run = 0; run < 3; run++) {
      const order = run % 2 === 0 ? ["control", "media"] : ["media", "control"];

      for (const item of order) {
        await Match.value(item).pipe(
          Match.when("control", async () => {
            controlMs.push(await sample(control));
          }),
          Match.orElse(async () => {
            mediaMs.push(await sample(() => media(size)));
          })
        );
      }
    }

    records.push({ size, controlMs, mediaMs });
  }

  console.log(
    JSON.stringify({
      records,
      offered,
      descriptorsBefore,
      descriptorsAfter: readdirSync("/dev/fd").length,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      limitations:
        "Same-process warm generic readRange control and detached authenticated media demand; fake authority/Blob; no decoded raster, Wire retention, quiet-machine baseline or whole-App certification.",
    })
  );
} finally {
  await removeTempDirSettled(root);
}
