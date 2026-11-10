import "../../../../test/dom.testing.ts";
import { AppId, ComputerUseCall, SessionId, TurnItem } from "@polaris/protocol";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../../routes/commands.ts";
import { hostView } from "../../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../../routes/navigation.ts";
import { AppProvider } from "../../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../../store/store.ts";
import { PreviewFeedItem } from "../../../../../shared/computerUseContract.ts";
import { installFakeBridge } from "../../../../test/bridge.testing.ts";
import { standInBridge } from "../../../bridge.ts";
import { groupItems } from "../../model/runs.ts";
import { completedItemView } from "../../model/items.ts";
import { RunThumbnail } from "./DesktopRunRow.tsx";

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const target = { hostKey: "studio", sessionId: SessionId.make("s-1") };

const runningRun = () => {
  const [entry] = groupItems([
    completedItemView(
      TurnItem.cases.ToolCall.make({
        id: "call-1",
        name: "mcp__polaris_desktop__click",
        kind: "mcp",
        mcp: { server: "polaris_desktop", tool: "click" },
        computerUse: ComputerUseCall.make({
          app: { id: AppId.make("com.apple.iphonesimulator"), name: "Simulator" },
          window: null,
          headed: false,
        }),
        input: { ref: "@e4" },
        output: null,
        status: "running",
      })
    ),
  ]);

  if (entry?.kind !== "desktop") throw new Error("not a desktop run");

  return entry.run;
};

const mount = () => {
  const store = createStore<AppState>(() => ({ ...initialState, hosts: [hostView("studio")] }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });

  render(
    <AppProvider
      value={{ connection, navigation, commands: createCommandRegistry({ platform: "mac" }) }}
    >
      <RunThumbnail target={target} run={runningRun()} />
    </AppProvider>
  );
};

// The criterion: the Host captures only while the live view is open (D4 stops at the last unsubscribe).
test("hovering the thumbnail subscribes to the session's frames, and leaving unsubscribes", async () => {
  const bridge = installFakeBridge();

  mount();
  const thumbnail = within(document.body).getByTestId("desktop-thumbnail");

  expect([bridge.feeds("computerUse.preview.watch").length, bridge.methods()]).toEqual([0, []]);

  await act(async () => {
    fireEvent.click(thumbnail);
  });

  const [feed, ...more] = bridge.feeds("computerUse.preview.watch");

  expect([feed?.input, feed?.closed(), more.length]).toEqual([
    { hostKey: "studio", sessionId: SessionId.make("s-1"), maxEdgePx: 720 },
    false,
    0,
  ]);

  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  });

  expect(within(document.body).queryByTestId("live-view")).toBeNull();
  expect(feed?.closed()).toBe(true);
});

test("on a Host without live capture the view shows the session's last frame instead", async () => {
  const bridge = installFakeBridge();

  mount();

  await act(async () => {
    fireEvent.click(within(document.body).getByTestId("desktop-thumbnail"));
  });

  const [feed] = bridge.feeds("computerUse.preview.watch");

  await act(async () => {
    feed?.listener.items([PreviewFeedItem.NoLive()]);
  });

  // 720 for the view; 160 is the thumbnail's own still.
  expect([
    feed?.closed(),
    bridge
      .sent("computerUse.preview.latest")
      .map((input) => input.maxEdgePx ?? 0)
      .sort((a, b) => a - b),
    within(document.body).getByTestId("live-view-kicker").textContent,
  ]).toEqual([true, [160, 720], "LAST FRAME"]);
});
