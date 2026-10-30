import "../../../test/dom.testing.ts";
import { type Capability, SessionId } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { Commands } from "../../../commands.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostModel, hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { Command } from "./command.tsx";
import { SessionTargetContext } from "./polarisTool/target.ts";

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const sessionId = SessionId.make("s1");

const running = {
  kind: "command" as const,
  id: "tu1",
  live: true,
  command: "bun dev",
  output: "",
  exitCode: null,
  status: "running" as const,
};

let hosts = 0;

/** A running command in a Claude session on a fresh Host (the Models listing is cached per Host). */
const mount = async (capabilities: ReadonlyArray<Capability>, backgroundsCommands: boolean) => {
  hosts += 1;
  const hostKey = `host-${hosts}`;
  const bridge = installFakeBridge();

  bridge.answerOk("harness.models", {
    harness: "claude",
    models: [],
    switchesModel: true,
    backgroundsCommands,
    runsShellCommands: false,
    steersAttachments: false,
    fetchedAt: "2026-10-20T00:00:00.000Z",
  });

  const view = hostView(hostKey);

  const state: AppState = {
    ...initialState,
    hosts: [{ ...view, status: { ...view.status, capabilities: [...capabilities] } }],
    hostModels: {
      [hostKey]: hostModel([{ id: "w1", sessions: [{ id: "s1", state: "working" }] }]),
    },
  };

  const store = createStore<AppState>(() => state);

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });
  const commands = createCommandRegistry({ platform: "mac" });

  const screen = render(
    <AppProvider value={{ connection, navigation, commands }}>
      <TooltipProvider>
        <SessionTargetContext.Provider value={{ hostKey, sessionId }}>
          <Command item={running} hue="claude" />
        </SessionTargetContext.Provider>
      </TooltipProvider>
    </AppProvider>
  );

  // Let the Models listing answer.
  await act(async () => {
    await Bun.sleep(5);
  });

  return { bridge, screen, hostKey };
};

test("a running command offers to run in the background where the Host and Harness can", async () => {
  const { bridge, screen, hostKey } = await mount(["session.background-command"], true);

  fireEvent.click(screen.getByRole("button", { name: "Run in background" }));

  expect(bridge.sent("dispatch")).toMatchObject([
    { hostKey, command: Commands.BackgroundCommand({ sessionId, itemId: "tu1" }) },
  ]);
});

test.each([
  ["a Harness that can't", ["session.background-command"] as const, false],
  ["a Host without the capability", [] as const, true],
])("%s offers nothing", async (_, capabilities, backgroundsCommands) => {
  const { screen } = await mount(capabilities, backgroundsCommands);

  expect(screen.getByText("running")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Run in background" })).toBeNull();
});

test("a command moved to the background reads so, not as finished", () => {
  const screen = render(
    <Command
      item={{ ...running, live: false, status: "completed", inBackground: true }}
      hue="claude"
    />
  );

  expect(screen.getByText("in the background")).not.toBeNull();
});
