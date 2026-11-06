import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LanguageCheckout,
  LanguageError,
  WorkspaceId,
  WorktreeId,
  ReviewCheckoutId,
} from "@polaris/protocol";
import { Effect } from "effect";
import { BlobChannel } from "../../services.ts";
import { makeFakeBlobChannel } from "../../files/testing.ts";
import {
  createHostPreviewMedia,
  HostPreviewMedia,
  PreviewMediaAuthority,
  type MediaInput,
} from "./index.ts";
import type { MediaPhase } from "./files.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const posixMedia = posixTest(
  "Host media reads need descriptor-relative NOFOLLOW opens, /dev/fd and FIFOs (ENG-296)"
);

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64"
);

let root: string;

let checkout: LanguageCheckout;

let input: MediaInput;

let allowed: boolean;

let calls: number;

let blobs: ReturnType<typeof makeFakeBlobChannel>;

let authority: PreviewMediaAuthority["Service"];

beforeEach(async () => {
  root = newTempDir("m31-h1-", { short: true });
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs/a.md"), "![image](a.png)");
  await writeFile(join(root, "docs/a.png"), png);
  checkout = LanguageCheckout.cases.Workspace.make({
    workspaceId: WorkspaceId.make("fake-workspace"),
    path: root,
  });
  input = {
    checkout,
    documentPath: join(root, "docs/a.md"),
    relativePath: "a.png",
    maxBytes: 10485760,
  };
  allowed = true;
  calls = 0;
  blobs = makeFakeBlobChannel();
  authority = PreviewMediaAuthority.of({
    authorize: async (requested, signal) => {
      calls++;

      if (!allowed || signal.aborted || requested.workspaceId !== checkout.workspaceId)
        throw new LanguageError({
          reason: "not-owner",
          message: "Fixture principal has no membership",
          retryable: false,
        });

      return { checkout, workspacePath: root };
    },
  });
});

afterEach(async () => {
  await removeTempDirSettled(root);
});

function run(value = input, phase?: (phase: MediaPhase) => Promise<void>) {
  return request(createHostPreviewMedia(phase === undefined ? {} : { phase }), value);
}

function request(service: HostPreviewMedia["Service"], value = input) {
  return Effect.runPromise(
    service.read(value).pipe(
      Effect.provideService(PreviewMediaAuthority, authority),
      Effect.provide(blobs.layer),
      Effect.catchTag("LanguageError", (error) => Effect.succeed(error))
    )
  );
}

async function rejected(value: MediaInput, reason: LanguageError["reason"] = "invalid-input") {
  const count = blobs.blobs.size;
  expect(await run(value)).toMatchObject({ reason });
  expect(blobs.blobs.size).toBe(count);
}

posixMedia("actual raster bytes use the request BlobChannel without execution trust", async () => {
  const result = await run();

  if (result instanceof LanguageError) throw result;
  expect(result.mimeType).toBe("image/png");
  expect(result.bytes).toBe(png.length);
  expect(blobs.blobs.get(result.blobId)).toEqual(png);
  expect(calls).toBe(3);
});

test("unauthorized and foreign Workspace requests fail before any Blob offer", async () => {
  allowed = false;
  await rejected(input, "not-owner");
  allowed = true;

  const foreign = LanguageCheckout.cases.Workspace.make({
    workspaceId: WorkspaceId.make("foreign"),
    path: root,
  });

  await rejected({ ...input, checkout: foreign }, "not-owner");
});

test("registered checkout identity and path cannot be supplied by the requester", async () => {
  await rejected({ ...input, checkout: { ...checkout, path: join(root, "docs") } });

  const worktree = LanguageCheckout.cases.Worktree.make({
    workspaceId: checkout.workspaceId,
    worktreeId: WorktreeId.make("foreign-tree"),
    path: root,
  });

  await rejected({ ...input, checkout: worktree });
});

posixMedia(
  "registered Worktrees and Review Checkouts work with independent Workspace membership",
  async () => {
    for (const registered of [
      LanguageCheckout.cases.Worktree.make({
        workspaceId: checkout.workspaceId,
        worktreeId: WorktreeId.make("tree"),
        path: root,
      }),
      LanguageCheckout.cases.ReviewCheckout.make({
        workspaceId: checkout.workspaceId,
        reviewCheckoutId: ReviewCheckoutId.make("review"),
        path: root,
      }),
    ]) {
      checkout = registered;
      const result = await run({ ...input, checkout });
      expect(result).not.toBeInstanceOf(LanguageError);
    }
  }
);

test("lexical traversal, absolute paths, URLs and foreign documents are rejected", async () => {
  for (const relativePath of [
    "../../secret.png",
    "/etc/passwd",
    "file:/etc/passwd",
    "https://example.invalid/a.png",
    "C:\\a.png",
    "a\\b.png",
  ])
    await rejected({ ...input, relativePath });
  await rejected({ ...input, documentPath: "/etc/passwd" });
});

posixMedia("contained parent navigation and contained symlinks remain usable", async () => {
  await writeFile(join(root, "a.png"), png);
  await symlink(join(root, "a.png"), join(root, "docs/link.png"));

  for (const relativePath of ["../a.png", "link.png"]) {
    expect(await run({ ...input, relativePath })).not.toBeInstanceOf(LanguageError);
  }
});

test("canonical document and raster symlinks cannot leave checkout", async () => {
  await symlink("/etc/passwd", join(root, "docs/out.md"));
  await symlink("/etc/passwd", join(root, "docs/out.png"));
  await rejected({ ...input, documentPath: join(root, "docs/out.md") });
  await rejected({ ...input, relativePath: "out.png" });
});

posixMedia("active SVG/HTML and deceptive raster extensions never authorize content", async () => {
  for (const bytes of ["<svg onload='alert(1)'/>", "<html><script>1</script>", "not a png", ""]) {
    await writeFile(join(root, "docs/a.png"), bytes);
    await rejected(input);
  }
});

posixMedia("supported raster signatures and AVIF brands are bounded data", async () => {
  const avif = Buffer.alloc(24);
  avif.writeUInt32BE(24);
  avif.write("ftyp", 4);
  avif.write("avif", 8);

  const cases = [
    { bytes: Buffer.from([255, 216, 255, 0]), mime: "image/jpeg" },
    { bytes: Buffer.from("GIF89a"), mime: "image/gif" },
    { bytes: Buffer.from("RIFF0000WEBP"), mime: "image/webp" },
    { bytes: avif, mime: "image/avif" },
  ];

  for (const fixture of cases) {
    await writeFile(join(root, "docs/a.png"), fixture.bytes);
    expect(await run()).toMatchObject({ mimeType: fixture.mime });
  }

  avif.writeUInt32BE(0xffffffff);
  await writeFile(join(root, "docs/a.png"), avif);
  await rejected(input);
});

posixMedia("caller limits and protocol ceiling reject oversize before offer", async () => {
  await rejected({ ...input, maxBytes: png.length - 1 }, "too-large");
  await rejected({ ...input, maxBytes: 10485761 });
  await rejected({ ...input, maxBytes: 0 });
  await writeFile(join(root, "docs/a.png"), Buffer.alloc(10485761));
  await rejected(input, "too-large");
});

posixMedia("directory and missing media faults leave no Blob", async () => {
  await rejected({ ...input, relativePath: "." });
  await rejected({ ...input, relativePath: "missing.png" });
  await rejected({ ...input, documentPath: join(root, "docs") });
});

for (const phase of ["resolved", "opened", "read"] as const) {
  // Windows catches a replacement at resolved; the later phases need descriptor-relative reads.
  (phase === "resolved" ? test : posixMedia)(
    `replacement at ${phase} cannot deliver raced bytes`,
    async () => {
      const result = await run(input, async (current) => {
        if (current !== phase) return;
        await rename(join(root, "docs/a.png"), join(root, "docs/old.png"));
        await symlink("/etc/passwd", join(root, "docs/a.png"));
      });

      expect(result).toBeInstanceOf(LanguageError);
      expect(blobs.blobs.size).toBe(0);
      expect(await readFile(join(root, "docs/old.png"))).toEqual(png);
    }
  );
}

test("directory ancestor substitution is rejected by descriptor-relative NOFOLLOW", async () => {
  const result = await run(input, async (phase) => {
    if (phase !== "resolved") return;
    await rename(join(root, "docs"), join(root, "old-docs"));
    await symlink("/etc", join(root, "docs"));
  });

  expect(result).toBeInstanceOf(LanguageError);
  expect(blobs.blobs.size).toBe(0);
});

test("document replacement and media mutation after read invalidate delivery", async () => {
  for (const path of ["docs/a.md", "docs/a.png"]) {
    const result = await run(input, async (phase) => {
      if (phase === "read") await writeFile(join(root, path), "changed");
    });

    expect(result).toBeInstanceOf(LanguageError);
    expect(blobs.blobs.size).toBe(0);
    await writeFile(join(root, "docs/a.md"), "![image](a.png)");
    await writeFile(join(root, "docs/a.png"), png);
  }
});

posixMedia(
  "membership revocation after filesystem waits and immediately before offer fails closed",
  async () => {
    expect(
      await run(input, async (phase) => {
        if (phase === "read") allowed = false;
      })
    ).toMatchObject({ reason: "not-owner" });
    allowed = true;
    calls = 0;
    const original = authority.authorize;
    authority = PreviewMediaAuthority.of({
      authorize: async (checkout, signal) => {
        if (calls === 2) allowed = false;

        return original(checkout, signal);
      },
    });
    expect(await run()).toMatchObject({ reason: "not-owner" });
    expect(blobs.blobs.size).toBe(0);
  }
);

posixMedia("two authenticated request BlobChannels cannot exchange media tokens", async () => {
  const service = createHostPreviewMedia();
  const first = blobs;
  const result = await request(service);
  expect(result).not.toBeInstanceOf(LanguageError);
  blobs = makeFakeBlobChannel();
  allowed = false;
  expect(await request(service)).toMatchObject({ reason: "not-owner" });
  expect(first.blobs.size).toBe(1);
  expect(blobs.blobs.size).toBe(0);
});

posixMedia(
  "interruption retains admission until actual filesystem cleanup and never offers late",
  async () => {
    let enter!: () => void;
    let release!: () => void;

    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const service = createHostPreviewMedia({
      maxConcurrent: 1,
      phase: async (phase) => {
        if (phase === "opened") {
          enter();
          await held;
        }
      },
    });

    const controller = new AbortController();

    const operation = Effect.runPromiseExit(
      service
        .read(input)
        .pipe(Effect.provideService(PreviewMediaAuthority, authority), Effect.provide(blobs.layer)),
      { signal: controller.signal }
    );

    await entered;
    controller.abort();
    expect(await request(service)).toMatchObject({ reason: "queue-full" });
    release();
    await operation;
    expect(blobs.blobs.size).toBe(0);
    expect(await request(service)).not.toBeInstanceOf(LanguageError);
  }
);

posixMedia(
  "filesystem mutation during final authority wait is caught before Blob offer",
  async () => {
    const original = authority.authorize;
    authority = PreviewMediaAuthority.of({
      authorize: async (checkout, signal) => {
        const result = await original(checkout, signal);

        if (calls === 3) await writeFile(join(root, "docs/a.png"), "replaced during authorization");

        return result;
      },
    });
    expect(await run()).toMatchObject({ reason: "conflict" });
    expect(blobs.blobs.size).toBe(0);
  }
);

posixMedia(
  "actual descriptors close after successful delivery, faults and interrupted reads",
  async () => {
    const { readdirSync } = await import("node:fs");
    const count = () => readdirSync("/dev/fd").length;
    const before = count();

    for (let index = 0; index < 12; index++) {
      await run();
      await run(input, async (phase) => {
        if (phase === "opened") throw new Error("fixture read fault");
      });
    }

    // /dev/fd is the whole process: other tests' descriptors may close meanwhile, never open.
    expect(count()).toBeLessThanOrEqual(before);
  }
);

posixMedia("Blob offer defect releases admission and descriptors", async () => {
  const { readdirSync } = await import("node:fs");
  const before = readdirSync("/dev/fd").length;
  const service = createHostPreviewMedia({ maxConcurrent: 1 });

  const failed = BlobChannel.of({
    offer: () => Effect.die(new Error("fixture offer fault")),
    take: () => Effect.die("unused"),
    takeStream: () => {
      throw new Error("unused");
    },
  });

  const exit = await Effect.runPromiseExit(
    service
      .read(input)
      .pipe(
        Effect.provideService(PreviewMediaAuthority, authority),
        Effect.provideService(BlobChannel, failed)
      )
  );

  expect(exit._tag).toBe("Failure");
  expect(readdirSync("/dev/fd").length).toBe(before);
  expect(await request(service)).not.toBeInstanceOf(LanguageError);
});

posixMedia(
  "default admission accepts four requests and bounds the fifth until settlement",
  async () => {
    let release!: () => void;
    let entered!: () => void;
    let opened = 0;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const service = createHostPreviewMedia({
      phase: async (phase) => {
        if (phase !== "opened") return;

        if (++opened === 4) entered();
        await held;
      },
    });

    const operations = Array.from({ length: 4 }, () => request(service));
    await ready;
    expect(await request(service)).toMatchObject({ reason: "queue-full" });
    release();
    const results = await Promise.all(operations);
    expect(results.every((result) => !(result instanceof LanguageError))).toBe(true);
    expect(blobs.blobs.size).toBe(4);
  }
);

posixMedia("pre-cancelled request offers no Blob and leaves admission reusable", async () => {
  const controller = new AbortController();
  controller.abort();
  await Effect.runPromiseExit(
    createHostPreviewMedia()
      .read(input)
      .pipe(Effect.provideService(PreviewMediaAuthority, authority), Effect.provide(blobs.layer)),
    { signal: controller.signal }
  );
  expect(calls).toBeLessThanOrEqual(1);
  expect(blobs.blobs.size).toBe(0);
  expect(await run()).not.toBeInstanceOf(LanguageError);
});

posixMedia(
  "FIFO media is rejected without blocking and cleanup allows another request",
  async () => {
    const process = Bun.spawnSync(["mkfifo", join(root, "docs/fifo.png")], {
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(process.exitCode).toBe(0);
    const service = createHostPreviewMedia({ maxConcurrent: 1 });
    expect(await request(service, { ...input, relativePath: "fifo.png" })).toMatchObject({
      reason: "invalid-input",
    });
    expect(blobs.blobs.size).toBe(0);
    expect(await request(service)).not.toBeInstanceOf(LanguageError);
  }
);
