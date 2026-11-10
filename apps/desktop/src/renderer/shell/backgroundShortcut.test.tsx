import "../test/dom.testing.ts";
// The app loads its slots first; shell/commands.ts reaches them through a cycle.
import "../app/slots.tsx";
import { type Capability, TurnId, TurnItem } from "@polaris/protocol";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { Commands } from "../commands.ts";
import { standInBridge } from "../features/bridge.ts";
import { useHarnessModels } from "../features/harness/index.ts";
import { createCommandRegistry } from "../routes/commands.ts";
import { hostModel, hostView } from "../routes/fixtures.testing.ts";
import { createNavigation } from "../routes/navigation.ts";
import { turnWith } from "../store/fixtures.testing.ts";
import { emptySessionModel, type LiveItem } from "../store/sessionModel.ts";
import { type AppState, type Connection, initialState, sessionKey } from "../store/store.ts";
import { installFakeBridge } from "../test/bridge.testing.ts";
import { shellCommands } from "./commands.ts";

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const command = (status: "running" | "completed"): LiveItem => ({
  item: TurnItem.cases.CommandExecution.make({
    id: "tu1",
    command: "bun dev",
    cwd: "/repo",
    output: "",
    exitCode: null,
    status,
  }),
  text: "",
  output: "",
});

const LoadModels = ({ hostKey }: { readonly hostKey: string }) => {
  useHarnessModels(hostKey, "claude");

  return null;
};

let hosts = 0;

interface Case {
  readonly capabilities: ReadonlyArray<Capability>;
  readonly backgroundsCommands: boolean;
  readonly live: ReadonlyArray<LiveItem>;
}

/** The shell's commands, a working Claude session selected on a fresh Host (Models cached per Host). */
const mount = async ({ capabilities, backgroundsCommands, live }: Case) => {
  hosts += 1;
  const hostKey = `ctrl-b-${hosts}`;
  const bridge = installFakeBridge();

  bridge.answerOk("harness.models", {
    harness: "claude",
    models: [],
    switchesModel: true,
    backgroundsCommands,
    runsShellCommands: false,
    steersAttachments: false,
    fetchedAt: "2026-11-09T00:00:00.000Z",
  });

  const view = hostView(hostKey);
  const model = hostModel([{ id: "w1", sessions: [{ id: "s1", state: "working" }] }]);
  const session = model.sessions.get("s1")!.session;

  const turn = {
    turn: turnWith({
      id: TurnId.make("t1"),
      index: 1,
      prompt: "start the dev server",
      status: "working",
    }),
    items: [],
    live: new Map(live.map((item, i) => [`i${i}`, item])),
    subagents: [],
  };

  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [{ ...view, status: { ...view.status, capabilities: [...capabilities] } }],
    hostModels: { [hostKey]: model },
    sessions: {
      [sessionKey(hostKey, session.id)]: { ...emptySessionModel, session, turns: [turn] },
    },
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });
  const commands = createCommandRegistry({ platform: "mac" });

  commands.register(shellCommands({ connection, navigation, dark: () => false }));
  act(() => navigation.actions.selectSession({ hostKey, sessionId: session.id }));
  render(<LoadModels hostKey={hostKey} />);
  await act(async () => {
    await Bun.sleep(5);
  });

  return { bridge, commands, hostKey, sessionId: session.id };
};

const capable: Case = {
  capabilities: ["session.background-command"],
  backgroundsCommands: true,
  live: [command("running")],
};

test("⌃B moves every command the selected session's Turn is running", async () => {
  const { bridge, commands, hostKey, sessionId } = await mount(capable);

  expect(commands.run("session.background")).toBe(true);
  expect(bridge.sent("dispatch")).toMatchObject([
    { hostKey, command: Commands.BackgroundCommand({ sessionId, itemId: null }) },
  ]);
});

test.each<[string, Case]>([
  ["a Host without the capability", { ...capable, capabilities: [] }],
  ["a Harness that can't", { ...capable, backgroundsCommands: false }],
  ["a Turn running no command", { ...capable, live: [command("completed")] }],
])("⌃B is off for %s", async (_, input) => {
  const { commands } = await mount(input);

  expect(commands.enabled("session.background")).toBe(false);
});
