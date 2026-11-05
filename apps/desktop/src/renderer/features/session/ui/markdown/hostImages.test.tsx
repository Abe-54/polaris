import "../../../../test/dom.testing.ts";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { IpcError } from "../../../../../shared/api.ts";
import { PREVIEW_IMAGE_MAX_BYTES } from "../../../../../shared/languages.ts";
import { png } from "../../../../../shared/raster/fixtures.testing.ts";
import { installFakeBridge } from "../../../../test/bridge.testing.ts";
import { standInBridge } from "../../../bridge.ts";
import { EditorPlaceProvider } from "../../../editor-links/index.ts";
import { HostImage } from "./HostImage.tsx";
import Streamed from "./Streamed.tsx";

afterEach(() => {
  cleanup();
  standInBridge(null);
});

let hosts = 0;

/** The transcript images are memoised per Host, so each test gets a fresh one. */
const freshHost = () => {
  hosts += 1;

  return `mac-studio-${hosts}`;
};

const message = (text: string, hostKey: string, root = "/work/repo") => (
  <EditorPlaceProvider value={{ hostKey, root }}>
    <Streamed text={text} live={false} />
  </EditorPlaceProvider>
);

const settle = () =>
  act(async () => {
    await Bun.sleep(5);
  });

const hostWith = (bytes: Uint8Array, size = bytes.length) => {
  const bridge = installFakeBridge();

  bridge.answerOk("files.read", { size, mimeType: "image/png", content: { kind: "bytes", bytes } });

  return bridge;
};

test("a local path loads from the session's Host and shows from a blob URL", async () => {
  const hostKey = freshHost();
  const bridge = hostWith(png(64, 64));
  const view = render(message("Here it is: ![Shell mode strip](/tmp/shell-strip.png)", hostKey));

  await settle();

  expect(bridge.sent("files.read")).toMatchObject([{ hostKey, path: "/tmp/shell-strip.png" }]);
  const image = view.getByRole("img", { name: "Shell mode strip" });

  expect(image.tagName).toBe("IMG");
  expect(image.getAttribute("src")).toStartWith("blob:");
});

test.each([
  ["relative to the session's directory", "shots/strip.png", "/work/repo/shots/strip.png"],
  ["dot-relative", "./strip.png", "/work/repo/strip.png"],
  ["under the Host's home", "~/Desktop/strip.png", "~/Desktop/strip.png"],
  ["a file URL", "file:///tmp/shell%20strip.png", "/tmp/shell strip.png"],
  ["absolute with a space", "</tmp/shell strip.png>", "/tmp/shell strip.png"],
])("a path %s resolves on the Host", async (_, source, path) => {
  const hostKey = freshHost();
  const bridge = hostWith(png(8, 8));

  render(message(`![strip](${source})`, hostKey));
  await settle();

  expect(bridge.sent("files.read").map((input) => input.path)).toEqual([path]);
});

test("a tool's native Windows image path is absolute and labels its filename", async () => {
  const bridge = hostWith(png(8, 8));
  const path = "C:\\Users\\Developer\\.codex\\generated_images\\strip.png";

  const view = render(
    <EditorPlaceProvider value={{ hostKey: freshHost(), root: "D:\\work\\repo" }}>
      <HostImage path={path} alt="" />
    </EditorPlaceProvider>
  );

  await settle();

  expect(bridge.sent("files.read").map((input) => input.path)).toEqual([
    "C:/Users/Developer/.codex/generated_images/strip.png",
  ]);
  expect(
    view.getByRole("button", { name: "View strip.png" }).querySelector("img")?.getAttribute("src")
  ).toStartWith("blob:");
});

test.each([
  ["drive-letter path", "C:/Users/Developer/shots/strip.png"],
  ["backslash path", "C:\\Users\\Developer\\shots\\strip.png"],
  ["file URL", "file:///C:/Users/Developer/shots/strip.png"],
])("a Windows %s displays the image from its absolute Host path", async (_, source) => {
  const bridge = hostWith(png(8, 8));
  const view = render(message(`![strip](${source})`, freshHost(), "D:\\work\\repo"));

  await settle();

  expect(bridge.sent("files.read").map((input) => input.path)).toEqual([
    "C:/Users/Developer/shots/strip.png",
  ]);
  expect(view.getByRole("img", { name: "strip" }).getAttribute("src")).toStartWith("blob:");
});

test.each([
  ["<C:\\Users\\Example User\\shots\\strip.png>", "C:/Users/Example User/shots/strip.png"],
  ["file:///C:/Users/Example%20User/shots/strip.png", "C:/Users/Example User/shots/strip.png"],
  [".\\shots\\strip.png", "D:/work/repo/shots/strip.png"],
])("Windows image path %s resolves spaces and separators", async (source, path) => {
  const bridge = hostWith(png(8, 8));

  render(message(`![strip](${source})`, freshHost(), "D:\\work\\repo\\"));
  await settle();

  expect(bridge.sent("files.read").map((input) => input.path)).toEqual([path]);
});

test.each(["file://server/share/strip.png", "javascript:alert(1)"])(
  "image source %s is never read from the Host",
  async (source) => {
    const bridge = installFakeBridge();

    render(message(`![strip](${source})`, freshHost()));
    await settle();

    expect(bridge.sent("files.read")).toEqual([]);
  }
);

const refusing = (error: IpcError) => () => {
  const bridge = installFakeBridge();

  bridge.refuse("files.read", error);
};

test.each([
  [
    "a missing file",
    refusing({ code: "FileError", message: "ENOENT: no such file or directory" }),
    "Not found on the host",
  ],
  ["an offline Host", refusing({ code: "NotConnected", message: "not connected" }), "Host offline"],
  [
    "a file over the cap",
    () => hostWith(png(8, 8), PREVIEW_IMAGE_MAX_BYTES + 1),
    "Too large to show",
  ],
  ["a file that isn't an image", () => hostWith(new Uint8Array([1, 2, 3, 4])), "Not an image"],
])("%s shows the alt text and the reason in place", async (_, host, reason) => {
  host();
  const view = render(message("![Shell mode strip](/tmp/shell-strip.png)", freshHost()));

  await settle();

  const status = view.getByRole("img", { name: `Shell mode strip · ${reason}` });

  expect(status.tagName).toBe("SPAN");
  expect(status.textContent).toBe(`Shell mode strip · ${reason}`);
});

test("an https image is Streamdown's own, never read from the Host", async () => {
  const bridge = installFakeBridge();
  const view = render(message("![badge](https://example.com/badge.png)", freshHost()));

  await settle();

  expect(bridge.sent("files.read")).toEqual([]);
  expect(view.getByRole("img", { name: "badge" }).getAttribute("src")).toBe(
    "https://example.com/badge.png"
  );
});

test("a streaming message and a remount read the image once", async () => {
  const hostKey = freshHost();
  const bridge = hostWith(png(8, 8));
  const text = "![strip](/tmp/strip.png)";
  const view = render(message(text, hostKey));

  await settle();
  view.rerender(message(`${text}\n\nAnd then`, hostKey));
  await settle();
  view.unmount();
  const again = render(message(text, hostKey));

  await settle();

  expect(bridge.sent("files.read")).toHaveLength(1);
  expect(again.getByRole("img", { name: "strip" }).getAttribute("src")).toStartWith("blob:");
});
