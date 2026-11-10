import "../../../test/dom.testing.ts";
import { afterEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { Steered } from "./outgoing.tsx";

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const HOST = "host-sent";

const mount = (text: string) => {
  const bridge = installFakeBridge();

  bridge.answerOk("harness.commands", {
    harness: "claude",
    cwd: "/repo",
    fetchedAt: "2026-11-10T00:00:00.000Z",
    commands: [
      {
        name: "simplify",
        sigil: "/",
        description: "Simplify it",
        argumentHint: null,
        kind: "skill",
        source: "user",
        plugin: null,
        run: "text",
        action: null,
        template: null,
      },
    ],
  });
  const view = hostView(HOST);

  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [{ ...view, status: { ...view.status, capabilities: ["harness.commands"] } }],
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });

  const screen = render(
    <AppProvider
      value={{ connection, navigation, commands: createCommandRegistry({ platform: "mac" }) }}
    >
      <Steered text={text} where={{ hostKey: HOST, harness: "claude", cwd: "/repo" }} />
    </AppProvider>
  );

  return { screen, bridge };
};

const chips = (screen: ReturnType<typeof render>) =>
  screen.queryAllByTestId("sent-chip").map((c) => [c.dataset["kind"], c.textContent]);

test("a sent message keeps its Skill and file chips, and copies as the text it sent", async () => {
  const { screen } = mount("/simplify @src/app.ts please");

  await waitFor(() =>
    expect(chips(screen)).toEqual([
      ["skill", "/simplify"],
      ["file", "@src/app.ts"],
    ])
  );
  expect(screen.getByTestId("steered").querySelector("p")?.textContent).toBe(
    "/simplify @src/app.ts please"
  );
});

test("a message that names no command never asks the Host for the list", () => {
  const { screen, bridge } = mount("look at @src/app.ts");

  expect(chips(screen)).toEqual([["file", "@src/app.ts"]]);
  expect(bridge.methods()).not.toContain("harness.commands");
});
