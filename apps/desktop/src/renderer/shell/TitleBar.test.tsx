import "../test/dom.testing.ts";
// The app loads its slots first; shell/commands.ts reaches them through a cycle.
import "../app/slots.tsx";
import { TooltipProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../routes/commands.ts";
import { hostModel, hostView, workspaces } from "../routes/fixtures.testing.ts";
import { createNavigation } from "../routes/navigation.ts";
import { type AppState, type Connection, initialState } from "../store/store.ts";
import { TitleBar } from "./TitleBar.tsx";
import { shellCommands } from "./commands.ts";
import { AppProvider } from "./hooks.ts";

afterEach(cleanup);

const page = () => within(document.body);

/** The real title bar, with the shell's commands behind ⌘1–5. */
const mount = (state: Partial<AppState> = {}) => {
  const store = createStore<AppState>(() => ({ ...initialState, ...state }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });
  const commands = createCommandRegistry({ platform: "mac" });

  commands.register(shellCommands({ connection, navigation, dark: () => false }));
  render(
    <AppProvider value={{ connection, navigation, commands }}>
      <TooltipProvider>
        <TitleBar />
      </TooltipProvider>
    </AppProvider>
  );

  return { navigation, commands };
};

const tabs = () => page().getAllByRole("radio");

const selected = () =>
  tabs()
    .filter((tab) => tab.getAttribute("aria-checked") === "true")
    .map((tab) => tab.textContent);

test("with Settings open no mode is selected, and every tab stays enabled", () => {
  const { navigation } = mount();

  act(() => navigation.actions.setMode("review"));
  act(() => navigation.actions.openSettings());

  expect(selected()).toEqual([]);
  expect(tabs().every((tab) => !tab.hasAttribute("disabled"))).toBe(true);
});

test("⌘2 from Settings closes it and selects Review", () => {
  const { navigation, commands } = mount();

  act(() => navigation.actions.openSettings());
  act(() => {
    commands.handleKey({
      code: "Digit2",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      typing: false,
    });
  });

  expect(navigation.store.getState().settings).toBeNull();
  expect(selected()).toEqual(["Review"]);
});

test("clicking the mode underneath Settings leaves Settings for it", () => {
  const { navigation } = mount();

  act(() => navigation.actions.openSettings());
  act(() => {
    fireEvent.click(page().getByRole("radio", { name: "Orchestrate" }));
  });

  expect(navigation.store.getState().settings).toBeNull();
  expect(selected()).toEqual(["Orchestrate"]);
});

const press = (commands: ReturnType<typeof mount>["commands"], code: string) =>
  act(() => {
    commands.handleKey({
      code,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      typing: false,
    });
  });

/** One connected Host whose Daemon says `capabilities`, with a Workspace selected on it. */
const onHost = (capabilities: ReadonlyArray<"traces">) => {
  const host = hostView("local");

  const mounted = mount({
    hosts: [{ ...host, label: "Mac Studio", status: { ...host.status, capabilities } }],
    hostModels: { local: hostModel(workspaces("local", 1)) },
  });

  act(() => mounted.navigation.actions.selectShortcut(1));

  return mounted;
};

const tracesTab = () => page().getByRole("radio", { name: "Traces" });

test("without the traces capability, Traces is disabled with its reason and ⌘5 stays put", () => {
  const { navigation, commands } = onHost([]);

  expect(tracesTab().hasAttribute("disabled")).toBe(true);
  expect(tracesTab().querySelector("[title]")?.getAttribute("title")).toBe(
    "Traces need a newer daemon on Mac Studio"
  );
  press(commands, "Digit5");
  expect(navigation.current().mode).toBe("orchestrate");
});

test("with the traces capability, ⌘5 opens Traces", () => {
  const { commands } = onHost(["traces"]);

  expect(tracesTab().hasAttribute("disabled")).toBe(false);
  press(commands, "Digit5");
  expect(selected()).toEqual(["Traces"]);
});
