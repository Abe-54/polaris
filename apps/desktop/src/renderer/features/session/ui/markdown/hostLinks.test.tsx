import "../../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { Toaster } from "@polaris/ui";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionId, WorkspaceId } from "@polaris/protocol";
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
import { browserUi } from "../../../browser/index.ts";
import { EditorPlaceProvider } from "../../../editor-links/index.ts";
import { uiKey } from "../../state.ts";
import Streamed from "./Streamed.tsx";

const HOST = "ubuntu-box";

/** A Host with one Workspace, `/code/repo`, which the session works in. */
const Providers = ({
  children,
  windows = false,
}: {
  readonly children: ReactNode;
  readonly windows?: boolean;
}) => {
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
      <EditorPlaceProvider value={{ hostKey: HOST, root: "/code/repo", windows }}>
        {children}
      </EditorPlaceProvider>
    </AppProvider>
  );
};

const message = (text: string, windows = false) =>
  render(
    <Providers windows={windows}>
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

test.each([
  ["/home/ubuntu/shots/before.png", false, "/home/ubuntu/shots/before.png"],
  ["/c:/shots/before.png", false, "/c:/shots/before.png"],
  ["C:/Users/Developer/shots/before.png", true, "C:/Users/Developer/shots/before.png"],
  ["<C:\\Users\\Example User\\shots\\before.png>", true, "C:/Users/Example User/shots/before.png"],
  [
    "file:///C:/Users/Example%20User/shots/before.png",
    true,
    "C:/Users/Example User/shots/before.png",
  ],
])(
  "an image link %s (Windows Host: %p) opens in the viewer from %s",
  async (source, windows, path) => {
    const bridge = installFakeBridge();

    bridge.answerOk("files.read", {
      size: 100,
      mimeType: "image/png",
      content: { kind: "bytes", bytes: png(16, 16) },
    });
    const view = message(`Before: [before.png](${source})`, windows);

    fireEvent.click(view.getByRole("button", { name: "before.png" }));
    await act(async () => {
      await Bun.sleep(5);
    });

    expect(bridge.sent("files.read")).toMatchObject([{ hostKey: HOST, path }]);
    expect(
      page().getByTestId("image-viewer").querySelector("img")?.getAttribute("src")
    ).toStartWith("blob:");
  }
);

test("a link to a URL stays a link", () => {
  installFakeBridge();
  const view = message("Docs: [Effect](https://effect.website/docs)");

  expect(view.getByRole("link", { name: "Effect" }).getAttribute("href")).toBe(
    "https://effect.website/docs"
  );
});

describe("a localhost link in a session (ENG-761)", () => {
  const SESSION = SessionId.make("s1");
  const WORKSPACE = WorkspaceId.make("repo");

  const inSession = (text: string) =>
    render(
      <Providers>
        <EditorPlaceProvider
          value={{ hostKey: HOST, root: "/code/repo", workspaceId: WORKSPACE, sessionId: SESSION }}
        >
          <Streamed text={text} live={false} />
        </EditorPlaceProvider>
      </Providers>
    );

  test("opens a tab in the session's Browser and shows the Browser", async () => {
    const bridge = installFakeBridge();
    const view = inSession("Running at [the app](http://localhost:5173/settings).");

    await act(async () => {
      fireEvent.click(view.getByRole("link", { name: "the app" }));
      await Bun.sleep(5);
    });

    expect(bridge.sent("browser.openTab")).toEqual([
      {
        hostKey: HOST,
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        url: "http://localhost:5173/settings",
      },
    ]);
    expect(browserUi(uiKey(HOST, SESSION)).shown).toBe(true);
  });

  test("a tab the app can't open says so", async () => {
    const bridge = installFakeBridge();

    bridge.refuse("browser.openTab", { code: "Unsupported", message: "no browser" });
    const view = inSession("See http://127.0.0.1:8080/");

    await act(async () => {
      fireEvent.click(view.getByRole("link", { name: "http://127.0.0.1:8080/" }));
      await Bun.sleep(5);
    });

    expect(await page().findByText("Couldn't open the link in the browser")).not.toBeNull();
  });

  test("a public link still opens in the user's browser", () => {
    const bridge = installFakeBridge();
    const view = inSession("Docs: [Effect](https://effect.website/docs)");

    expect(view.getByRole("link", { name: "Effect" }).getAttribute("target")).toBe("_blank");
    expect(bridge.sent("browser.openTab")).toEqual([]);
  });
});
