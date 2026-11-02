import "../../../test/dom.testing.ts";
import { act, cleanup, render } from "@testing-library/react";
import { TurnItem } from "@polaris/protocol";
import { afterEach, expect, test } from "bun:test";
import { png } from "../../../../shared/raster/fixtures.testing.ts";
import { installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { EditorPlaceProvider } from "../../editor-links/index.ts";
import { completedItemView } from "../model/items.ts";
import { Tool } from "./tool.tsx";

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const viewImage = (path: string) => {
  const view = completedItemView(
    TurnItem.cases.ToolCall.make({
      id: "exec-1d6d",
      name: "view_image",
      kind: "read",
      input: { path },
      output: null,
      status: "completed",
    })
  );

  if (view.kind !== "tool") throw new Error("not a tool row");

  return view;
};

// ENG-759: an agent's screenshots showed only as a path the user had to find and click.
test("an image the agent viewed shows under its row, read from the session's Host", async () => {
  const bridge = installFakeBridge();

  bridge.answerOk("files.read", {
    size: 100,
    mimeType: "image/png",
    content: { kind: "bytes", bytes: png(32, 32) },
  });

  const view = render(
    <EditorPlaceProvider value={{ hostKey: "ubuntu-box", root: "/home/ubuntu/code/app" }}>
      <Tool item={viewImage("shots/after.png")} hue="codex" />
    </EditorPlaceProvider>
  );

  await act(async () => {
    await Bun.sleep(5);
  });

  expect(bridge.sent("files.read")).toMatchObject([
    { hostKey: "ubuntu-box", path: "/home/ubuntu/code/app/shots/after.png" },
  ]);
  const image = view.getByTestId("tool-image").querySelector("img");

  expect(image?.getAttribute("src")).toStartWith("blob:");
});
