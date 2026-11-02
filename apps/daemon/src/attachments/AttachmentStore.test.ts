import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { AttachmentId, SessionId, WorkspaceId } from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { makeFakeBlobChannel } from "../files/testing.ts";
import { removeTempDir, tempDir } from "../git/testing.ts";
import { PNG_1200x800 } from "./imageSize.testing.ts";
import { AttachmentStore, ServiceError } from "../services.ts";
import { handleStageAttachment } from "./AttachmentRpcs.ts";
import {
  AttachmentMaintenance,
  AttachmentStoreLive,
  type AttachmentStoreOptions,
  MAX_ATTACHMENT_BYTES,
  PENDING_MAX_AGE_DAYS,
  safeFileName,
} from "./AttachmentStore.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const DAY = 24 * 60 * 60 * 1000;

const ws = WorkspaceId.make("ws1");

const other = WorkspaceId.make("ws2");

const s1 = SessionId.make("session-1");

const bytes = (text: string) => new TextEncoder().encode(text);

const setup = () => {
  const home = tempDir("polaris-home-");
  cleanup.push(home);
  const clock = { now: Date.now() };

  const options: AttachmentStoreOptions = {
    root: join(home, "staging"),
    settingsPath: join(home, "attachment-settings.json"),
    now: () => clock.now,
  };

  const run = <A, E>(effect: Effect.Effect<A, E, AttachmentStore | AttachmentMaintenance>) =>
    Effect.runPromise(Effect.scoped(Effect.provide(effect, AttachmentStoreLive(options))));

  return { home, clock, options, run, staging: options.root! };
};

const stage = (sessionId: SessionId | null, workspaceId: WorkspaceId, name: string, text = "x") =>
  Effect.gen(function* () {
    const store = yield* AttachmentStore;

    return yield* store.stage({
      sessionId,
      workspaceId,
      name,
      mimeType: "text/plain",
      bytes: bytes(text),
    });
  });

describe("AttachmentStore", () => {
  test("stages bytes under staging/<session>/ with a safe name and returns the Attachment", async () => {
    const { run, staging } = setup();
    const attachment = await run(stage(s1, ws, "../../etc/pass wd?.png", "png bytes"));
    expect(attachment.name).toBe("../../etc/pass wd?.png");
    expect(attachment.size).toBe(9);
    expect(attachment.hostPath.startsWith(join(staging, "session-1", attachment.id))).toBe(true);
    expect(attachment.hostPath.endsWith(`${sep}pass wd_.png`)).toBe(true);
    expect(readFileSync(attachment.hostPath, "utf8")).toBe("png bytes");

    // Windows keeps no POSIX mode; its ACL privacy is ENG-314.
    if (process.platform !== "win32")
      expect(statSync(attachment.hostPath).mode & 0o777).toBe(0o600);

    const got = await run(
      Effect.gen(function* () {
        const store = yield* AttachmentStore;

        return yield* store.get([attachment.id, AttachmentId.make("missing")]);
      })
    );

    expect(got).toEqual([attachment]);
  });

  test("an image records its pixel size, kept across a get; other files have none", async () => {
    const { run } = setup();

    const image = await run(
      Effect.gen(function* () {
        const store = yield* AttachmentStore;

        return yield* store.stage({
          sessionId: s1,
          workspaceId: ws,
          name: "shot.png",
          mimeType: "image/png",
          bytes: PNG_1200x800,
        });
      })
    );

    expect([image.width, image.height]).toEqual([1200, 800]);
    const text = await run(stage(s1, ws, "notes.txt"));

    expect([text.width, text.height]).toEqual([null, null]);

    const got = await run(
      Effect.gen(function* () {
        const store = yield* AttachmentStore;

        return yield* store.get([image.id]);
      })
    );

    expect(got).toEqual([image]);
  });

  test("unsessioned attachments go to _pending/<workspace>/", async () => {
    const { run, staging } = setup();
    const attachment = await run(stage(null, ws, "notes.txt"));
    expect(attachment.hostPath.startsWith(join(staging, "_pending", "ws1"))).toBe(true);
  });

  test("safe file names", () => {
    expect(safeFileName("a/b\\c.txt")).toBe("c.txt");
    expect(safeFileName("..hidden")).toBe("hidden");
    expect(safeFileName("")).toBe("attachment");
    expect(safeFileName("bad\u0000name:*.md")).toBe("bad_name__.md");
    const long = safeFileName(`${"x".repeat(300)}.jpeg`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".jpeg")).toBe(true);
  });

  test("on-archive (default): archiving a session deletes its attachments", async () => {
    const { run, staging } = setup();
    const a = await run(stage(s1, ws, "a.txt"));
    const other1 = await run(stage(SessionId.make("session-2"), ws, "b.txt"));
    await run(
      Effect.gen(function* () {
        yield* (yield* AttachmentStore).onSessionArchived(s1);
      })
    );
    expect(existsSync(a.hostPath)).toBe(false);
    expect(existsSync(join(staging, "session-1"))).toBe(false);
    expect(existsSync(other1.hostPath)).toBe(true);
  });

  test("per-Workspace override: never keeps attachments on archive and through sweeps", async () => {
    const { run, clock } = setup();
    await run(
      Effect.gen(function* () {
        const maintenance = yield* AttachmentMaintenance;
        yield* maintenance.setSettings({
          default: { kind: "on-archive" },
          workspaces: { ws1: { kind: "never" } },
        });
      })
    );
    const kept = await run(stage(s1, ws, "keep.txt"));
    await run(
      Effect.gen(function* () {
        yield* (yield* AttachmentStore).onSessionArchived(s1);
      })
    );
    clock.now += 365 * DAY;
    const removed = await run(sweepEffect());
    expect(removed).toBe(0);
    expect(existsSync(kept.hostPath)).toBe(true);
  });

  test("after-days: the sweeper deletes attachments older than N days", async () => {
    const { run, clock } = setup();
    await run(
      Effect.gen(function* () {
        yield* (yield* AttachmentMaintenance).setSettings({
          default: { kind: "after-days", days: 3 },
          workspaces: {},
        });
      })
    );
    const old = await run(stage(s1, ws, "old.txt"));
    clock.now += 2 * DAY;
    const fresh = await run(stage(s1, ws, "fresh.txt"));
    clock.now += 1.5 * DAY;
    expect(await run(sweepEffect())).toBe(1);
    expect(existsSync(old.hostPath)).toBe(false);
    expect(existsSync(fresh.hostPath)).toBe(true);
    // Archiving doesn't delete under after-days.
    await run(
      Effect.gen(function* () {
        yield* (yield* AttachmentStore).onSessionArchived(s1);
      })
    );
    expect(existsSync(fresh.hostPath)).toBe(true);
  });

  test("on-archive: pending attachments are swept after the pending max age", async () => {
    const { run, clock } = setup();
    const pending = await run(stage(null, ws, "p.txt"));
    const sessioned = await run(stage(s1, ws, "s.txt"));
    clock.now += (PENDING_MAX_AGE_DAYS + 1) * DAY;
    expect(await run(sweepEffect())).toBe(1);
    expect(existsSync(pending.hostPath)).toBe(false);
    expect(existsSync(sessioned.hostPath)).toBe(true);
  });

  test("settings persist across restarts", async () => {
    const { run } = setup();

    const next = {
      default: { kind: "never" as const },
      workspaces: { ws2: { kind: "after-days" as const, days: 9 } },
    };

    await run(
      Effect.gen(function* () {
        yield* (yield* AttachmentMaintenance).setSettings(next);
      })
    );

    const loaded = await run(
      Effect.gen(function* () {
        return yield* (yield* AttachmentMaintenance).settings;
      })
    );

    expect(loaded).toEqual(next);
  });

  test("usage and clearNow, for everything or one Workspace", async () => {
    const { run, staging } = setup();
    await run(stage(s1, ws, "a.txt", "12345"));
    await run(stage(null, other, "b.txt", "123"));
    await run(stage(SessionId.make("session-3"), other, "c.txt", "1"));

    const usage = await run(
      Effect.gen(function* () {
        return yield* (yield* AttachmentMaintenance).usage;
      })
    );

    expect(usage).toEqual({ bytes: 9, files: 3 });

    const cleared = await run(
      Effect.gen(function* () {
        return yield* (yield* AttachmentMaintenance).clearNow({ workspaceId: other });
      })
    );

    expect(cleared).toEqual({ bytes: 4, files: 2 });

    const all = await run(
      Effect.gen(function* () {
        const maintenance = yield* AttachmentMaintenance;
        const removed = yield* maintenance.clearNow();

        return { removed, after: yield* maintenance.usage };
      })
    );

    expect(all).toEqual({ removed: { bytes: 5, files: 1 }, after: { bytes: 0, files: 0 } });
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
  });

  test("a removed Workspace loses its staged files and its override; others keep theirs", async () => {
    const { run } = setup();
    await run(stage(s1, ws, "a.txt", "12345"));
    await run(stage(null, other, "b.txt", "123"));

    const after = await run(
      Effect.gen(function* () {
        const maintenance = yield* AttachmentMaintenance;
        const settings = yield* maintenance.settings;
        yield* maintenance.setSettings({
          ...settings,
          workspaces: { [ws]: { kind: "never" }, [other]: { kind: "never" } },
        });
        yield* (yield* AttachmentStore).onWorkspaceRemoved(other);

        return {
          usage: yield* maintenance.usageByWorkspace,
          overrides: Object.keys((yield* maintenance.settings).workspaces),
        };
      })
    );

    expect(Object.keys(after.usage)).toEqual([ws]);
    expect(after.overrides).toEqual([ws]);
  });

  test("attachments.stage takes the Client's blob and stages it", async () => {
    const { options } = setup();
    const blobs = makeFakeBlobChannel();
    const blobId = blobs.put(bytes("image data"));

    const attachment = await Effect.runPromise(
      Effect.scoped(
        handleStageAttachment({
          sessionId: s1,
          workspaceId: ws,
          name: "shot.png",
          mimeType: "image/png",
          blobId,
        }).pipe(Effect.provide(Layer.merge(blobs.layer, AttachmentStoreLive(options))))
      )
    );

    expect(attachment).toMatchObject({ name: "shot.png", mimeType: "image/png", size: 10 });
    expect(readFileSync(attachment.hostPath, "utf8")).toBe("image data");
  });

  test("stages a stream chunk by chunk, and drops the upload when it fails or is too large", async () => {
    const { run, staging } = setup();

    const upload = (
      bytes: Stream.Stream<Uint8Array, ServiceError>,
      maxBytes: number = MAX_ATTACHMENT_BYTES
    ) =>
      Effect.gen(function* () {
        const store = yield* AttachmentStore;

        return yield* store.stage({
          sessionId: s1,
          workspaceId: ws,
          name: "big.bin",
          mimeType: "application/octet-stream",
          bytes,
        });
      }).pipe(
        Effect.provide(
          AttachmentStoreLive({
            root: staging,
            settingsPath: join(staging, "s.json"),
            maxBytes,
          })
        )
      );

    const chunks = [bytes("hello "), bytes("streamed "), bytes("world")];
    const staged = await run(upload(Stream.fromIterable(chunks)));
    expect(staged.size).toBe(20);
    expect(readFileSync(staged.hostPath, "utf8")).toBe("hello streamed world");
    expect(readdirSync(join(staged.hostPath, "..")).sort()).toEqual([".meta.json", "big.bin"]);

    const failing = Stream.concat(
      Stream.fromIterable(chunks),
      Stream.fail(new ServiceError({ service: "test", message: "connection lost" }))
    );

    const failed = await run(Effect.flip(upload(failing)));
    expect(failed.message).toContain("connection lost");
    const tooLarge = await run(Effect.flip(upload(Stream.fromIterable(chunks), 10)));
    expect(tooLarge.message).toContain("larger than 10 bytes");
    // Only the first upload is left on disk.
    expect(readdirSync(join(staging, s1))).toEqual([staged.id]);
  });
});

const sweepEffect = () =>
  Effect.gen(function* () {
    return yield* (yield* AttachmentMaintenance).sweep;
  });
