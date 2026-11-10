import "../../../../test/dom.testing.ts";
import { SessionId, TurnItem } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../../routes/commands.ts";
import { createNavigation, type SessionTarget } from "../../../../routes/navigation.ts";
import { AppProvider } from "../../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../../store/store.ts";
import { polarisToolView } from "../../model/polarisTools/index.ts";
import { PolarisTool, SessionTargetContext } from "./index.tsx";

afterEach(cleanup);

const searched = TurnItem.cases.ToolCall.make({
  id: "h1",
  name: "mcp__polaris__search_history",
  input: { query: "flaky", scope: "host" },
  output: [
    '1 matches for "flaky" in 9 Turns of 2 sessions, newest first.',
    '- s-abc "Fix the flaky test" · Turn 4 · 2026-11-09T13:52:00Z · reply: it was a race',
    "Next: Continue.",
  ].join("\n"),
  status: "completed",
});

test("a session a history search names opens from the row, on the row's Host", () => {
  const store = createStore<AppState>(() => initialState);
  const navigation = createNavigation({ app: store, storage: null });
  const opened: Array<SessionTarget> = [];

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const view = polarisToolView(searched);

  if (view === null) throw new Error("search_history is a Polaris tool");

  const screen = render(
    <AppProvider
      value={{
        connection,
        navigation: {
          ...navigation,
          actions: { ...navigation.actions, selectSession: (t) => opened.push(t) },
        },
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TooltipProvider>
        <SessionTargetContext.Provider
          value={{ hostKey: "pi", sessionId: SessionId.make("s-lead") }}
        >
          <PolarisTool id="h1" view={view} hue="claude" />
        </SessionTargetContext.Provider>
      </TooltipProvider>
    </AppProvider>
  );

  fireEvent.click(screen.getByRole("button", { name: /Searched history for/ }));
  fireEvent.click(screen.getByRole("button", { name: "Fix the flaky test" }));

  expect(opened).toEqual([{ hostKey: "pi", sessionId: SessionId.make("s-abc") }]);
  expect(screen.getByText("it was a race")).not.toBeNull();
});
