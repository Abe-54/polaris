import "../../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { Toaster } from "@polaris/ui";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { createStore } from "zustand/vanilla";
import { png } from "../../../../../shared/raster/fixtures.testing.ts";
import { createCommandRegistry } from "../../../../routes/commands.ts";
import { editorRoute } from "../../../../routes/editor.ts";
import { hostModel } from "../../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../../routes/navigation.ts";
import { AppProvider } from "../../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../../store/store.ts";
import { installFakeBridge } from "../../../../test/bridge.testing.ts";
import { standInBridge } from "../../../bridge.ts";
import { EditorPlaceProvider } from "../../../editor-links/index.ts";
import Streamed from "./Streamed.tsx";

const HOST = "ubuntu-box";

/** A Host with one Workspace, `/code/repo`, which the session works in. */
const Providers = ({ children }: { readonly children: ReactNode }) => {
  const store = createStore<AppState>(() => ({
    ...initialState,
    hostModels: { [HOST]: hostModel([{ id: "repo" }]) },
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  return (
    <AppProvider
      value={{
        connection,
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <EditorPlaceProvider value={{ hostKey: HOST, root: "/code/repo" }}>
        {children}
      </EditorPlaceProvider>
    </AppProvider>
  );
};

const message = (text: string) =>
  render(
    <Providers>
      <Streamed text={text} live={false} />
    </Providers>
  );

const page = () => within(document.body);

beforeEach(() => {
  editorRoute.setState({ request: null });
  render(<Toaster />);
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

test.each([
  ["relative to the session's directory", "docs/notes.md", "/code/repo/docs/notes.md"],
  ["absolute", "/code/repo/src/app.ts", "/code/repo/src/app.ts"],
  ["a file URL", "file:///code/repo/review%20notes.md", "/code/repo/review notes.md"],
])("a link to a file %s opens it in the editor", (_, href, path) => {
  installFakeBridge();
  const view = message(`See [the notes](${href}).`);

  fireEvent.click(view.getByRole("button", { name: "the notes" }));

  expect(editorRoute.getState().request).toMatchObject({ hostKey: HOST, path });
});

test("a link to an HTML page outside every Workspace says so instead of doing nothing", async () => {
  installFakeBridge();
  const view = message("Open [the gallery](/home/ubuntu/code/review-20261030/index.html).");

  fireEvent.click(view.getByRole("button", { name: "the gallery" }));

  expect(editorRoute.getState().request).toBeNull();
  expect(await page().findByText("Not in a workspace on this host")).not.toBeNull();
});

test("a link to an image opens it in the viewer, read from the session's Host", async () => {
  const bridge = installFakeBridge();

  bridge.answerOk("files.read", {
    size: 100,
    mimeType: "image/png",
    content: { kind: "bytes", bytes: png(16, 16) },
  });
  const view = message("Before: [before.png](/home/ubuntu/shots/before.png)");

  fireEvent.click(view.getByRole("button", { name: "before.png" }));
  await act(async () => {
    await Bun.sleep(5);
  });

  expect(bridge.sent("files.read")).toMatchObject([
    { hostKey: HOST, path: "/home/ubuntu/shots/before.png" },
  ]);
  expect(page().getByTestId("image-viewer").querySelector("img")?.getAttribute("src")).toStartWith(
    "blob:"
  );
});

test("a link to a URL stays a link", () => {
  installFakeBridge();
  const view = message("Docs: [Effect](https://effect.website/docs)");

  expect(view.getByRole("link", { name: "Effect" }).getAttribute("href")).toBe(
    "https://effect.website/docs"
  );
});
