import { describe, expect, test } from "bun:test";
import { Attachment, AttachmentId } from "@polaris/protocol";
import { attachCaption, attachmentStore, type Picked, stagedIds } from "./attach.ts";

const picked = (name: string, isImage = false): Picked => ({
  uri: `file:///tmp/${name}`,
  name,
  mimeType: isImage ? "image/jpeg" : "text/plain",
  size: null,
  isImage,
});

const attachment = (name: string, size = 94) =>
  Attachment.make({
    id: AttachmentId.make(`att-${name}`),
    name,
    mimeType: "text/plain",
    size,
    hostPath: `/home/me/.polaris/staging/${name}`,
    width: null,
    height: null,
  });

/** A stage function whose answers the test hands out in any order. */
const deferredStage = () => {
  const waiting = new Map<string, PromiseWithResolvers<Attachment>>();

  return {
    stage: (pick: Picked) => {
      const deferred = Promise.withResolvers<Attachment>();
      waiting.set(pick.name, deferred);

      return deferred.promise;
    },
    resolve: (name: string) => waiting.get(name)?.resolve(attachment(name)),
    reject: (name: string, message: string) => waiting.get(name)?.reject(new Error(message)),
  };
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a composer's attachments", () => {
  test("Send carries them in the order attached, whichever finished staging first", async () => {
    const host = deferredStage();
    const store = attachmentStore(host.stage);

    store.add([picked("notes.txt"), picked("shot.jpg", true)]);
    expect(attachCaption(store.chips())).toBe("Attaching 2 files…");
    expect(store.chips()[1]?.thumbnailUri).toBe("file:///tmp/shot.jpg");
    host.resolve("shot.jpg");
    await settled();
    expect(attachCaption(store.chips())).toBe("Attaching 1 file…");
    expect(stagedIds(store.chips())).toEqual([AttachmentId.make("att-shot.jpg")]);

    host.resolve("notes.txt");
    await settled();
    expect(stagedIds(store.chips())).toEqual([
      AttachmentId.make("att-notes.txt"),
      AttachmentId.make("att-shot.jpg"),
    ]);
    expect(store.chips()[0]?.size).toBe(94);
    expect(attachCaption(store.chips())).toBeNull();
  });

  test("one removed or cleared while staging never comes back", async () => {
    const host = deferredStage();
    const store = attachmentStore(host.stage);

    store.add([picked("a.txt"), picked("b.txt")]);
    store.remove(store.chips()[0]?.key ?? "");
    store.clear();
    host.resolve("a.txt");
    host.resolve("b.txt");
    await settled();
    expect(store.chips()).toEqual([]);
  });

  test("a refusal says which file and why, and isn't sent", async () => {
    const host = deferredStage();
    const store = attachmentStore(host.stage);

    store.add([picked("big.bin")]);
    host.reject("big.bin", "the file is larger than 25 MB");
    await settled();
    expect(attachCaption(store.chips())).toBe(
      "Couldn't attach big.bin: the file is larger than 25 MB"
    );
    expect(stagedIds(store.chips())).toEqual([]);
  });

  test("a Send's acknowledgement removes its chips, not ones attached while it waited", async () => {
    const host = deferredStage();
    const store = attachmentStore(host.stage);

    store.add([picked("a.txt")]);
    host.resolve("a.txt");
    await settled();
    const sent = store.submission();
    store.add([picked("b.txt"), picked("c.txt")]);
    host.resolve("b.txt");
    await settled();

    sent.done();
    expect(sent.ids).toEqual([AttachmentId.make("att-a.txt")]);
    expect(store.chips().map((chip) => [chip.name, chip.status])).toEqual([
      ["b.txt", "staged"],
      ["c.txt", "staging"],
    ]);
  });

  test("a steer that didn't land puts its staged files back as chips, never twice", async () => {
    const host = deferredStage();
    const store = attachmentStore(host.stage);

    store.add([picked("notes.txt")]);
    host.resolve("notes.txt");
    await settled();
    store.restore([attachment("notes.txt"), attachment("shot.jpg")]);

    expect(stagedIds(store.chips())).toEqual([
      AttachmentId.make("att-notes.txt"),
      AttachmentId.make("att-shot.jpg"),
    ]);
    expect(attachCaption(store.chips())).toBeNull();
  });
});
