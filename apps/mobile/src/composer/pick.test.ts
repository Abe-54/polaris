import { test } from "bun:test";
import { nativeProbe } from "../app/nativeProbe.testing.ts";

test("Android multi-pick stages the converted photo when another conversion fails", () => {
  nativeProbe(`
const original = { uri: "file:///photo.webp", fileName: "photo.webp", mimeType: "image/webp", fileSize: 999, base64: "/9j/2Q==" };
mock.module("expo-document-picker", () => ({ getDocumentAsync: async () => ({ canceled: true }) }));
mock.module("./menus/choices.ts", () => ({ choose: () => {} }));
mock.module("expo-image-picker", () => ({
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" },
  launchImageLibraryAsync: async (options) => {
    assert.equal(options.base64, true);
    assert.ok(options.quality < 1);
    return { canceled: false, assets: [{ ...original, uri: "file:///broken.webp", base64: null }, original] };
  },
}));
const files = new Map([[original.uri, Buffer.from([1, 2, 3])]]);
mock.module("expo-file-system", () => ({ Paths: { cache: "file:///cache" }, File: class {
  constructor(...parts) { this.uri = parts.join("/"); }
  get size() { return files.get(this.uri)?.length ?? 0; }
  async write(bytes, options) { files.set(this.uri, Buffer.from(bytes, options.encoding)); }
} }));
const { pickPhotos } = await import("./composer/pick.ts");
const picks = await pickPhotos();
assert.equal(picks.length, 1);
const [picked] = picks;
assert.equal(picked.name, "photo.jpg");
assert.equal(picked.mimeType, "image/jpeg");
assert.equal(picked.size, 4);
assert.deepEqual([...files.get(picked.uri)], [255, 216, 255, 217]);
const { attachmentStore } = await import("./composer/attach.ts");
const store = attachmentStore(async (photo) => ({ id: "staged-photo", name: photo.name, size: photo.size }));
store.add(picks);
await Promise.resolve();
assert.deepEqual(store.chips().map(({ name, status }) => ({ name, status })), [{ name: "photo.jpg", status: "staged" }]);
`);
});

test("iOS keeps its compatible representation request and original metadata", () => {
  nativeProbe(
    `
mock.module("expo-document-picker", () => ({ getDocumentAsync: async () => ({ canceled: true }) }));
mock.module("expo-file-system", () => ({ File: class {}, Paths: {} }));
mock.module("./menus/choices.ts", () => ({ choose: () => {} }));
mock.module("expo-image-picker", () => ({
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" },
  launchImageLibraryAsync: async (options) => {
    assert.equal(options.preferredAssetRepresentationMode, "compatible");
    assert.equal(options.base64, undefined);
    assert.equal(options.quality, undefined);
    return { canceled: false, assets: [{ uri: "file:///photo.png", fileName: "photo.png", mimeType: "image/png", fileSize: 500 }] };
  },
}));
const { pickPhotos } = await import("./composer/pick.ts");
assert.deepEqual(await pickPhotos(), [{ uri: "file:///photo.png", name: "photo.png", mimeType: "image/png", size: 500, isImage: true }]);
`,
    "ios"
  );
});
