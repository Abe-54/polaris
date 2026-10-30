import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { DEFAULT_SESSION_PREFS } from "../../../../shared/sessionPrefs.ts";
import { installFakeBridge, type FakeBridge } from "../../../test/bridge.testing.ts";
import { polaris } from "../../bridge.ts";
import { connectSettings, settingsStore } from "../store.ts";
import { TurnNotifications } from "./TurnNotifications.tsx";

let fake: FakeBridge;

let disconnect: () => void;

beforeEach(() => {
  fake = installFakeBridge();
  fake.refuse("settings.get", { code: "Unsupported", message: "not in this test" });
  disconnect = connectSettings(polaris());
  settingsStore.setState({ sessions: DEFAULT_SESSION_PREFS });
});

afterEach(() => {
  cleanup();
  disconnect();
});

const input = (element: HTMLElement) => {
  if (!(element instanceof HTMLInputElement)) throw new Error("not an input");

  return element;
};

const page = () => {
  const view = within(render(<TurnNotifications />).container);

  return {
    main: view.getByRole("switch", { name: "When a turn finishes" }),
    longOnly: () =>
      input(view.getByRole("checkbox", { name: /^Only turns longer than \d+ minutes$/ })),
    minutes: () => view.getByRole("group", { name: "Minutes" }),
    more: () => view.getByRole("button", { name: "Increase Minutes" }),
    fewer: () => view.getByRole("button", { name: "Decrease Minutes" }),
  };
};

test("the long-turns option is off until turn notifications are on", () => {
  const { main, longOnly, more } = page();

  expect([longOnly().disabled, more().hasAttribute("disabled")]).toEqual([true, true]);

  fireEvent.click(main);

  expect([longOnly().disabled, more().hasAttribute("disabled")]).toEqual([false, false]);
  expect(longOnly().getAttribute("aria-label")).toBe("Only turns longer than 5 minutes");
});

test("checking it and stepping the minutes saves both", () => {
  act(() =>
    settingsStore.setState({ sessions: { ...DEFAULT_SESSION_PREFS, notifyTurnEnded: true } })
  );
  const { longOnly, minutes, more } = page();

  fireEvent.click(longOnly());
  fireEvent.click(more());

  expect(fake.sent("settings.setSessions")).toEqual([
    { patch: { notifyLongTurnsOnly: true } },
    { patch: { longTurnMinutes: 10 } },
  ]);
  expect(minutes().textContent).toContain("10 min");
});

test("the minutes stop at one", () => {
  act(() =>
    settingsStore.setState({
      sessions: { ...DEFAULT_SESSION_PREFS, notifyTurnEnded: true, longTurnMinutes: 5 },
    })
  );
  const { fewer } = page();

  fireEvent.click(fewer());

  expect(fake.sent("settings.setSessions")).toEqual([{ patch: { longTurnMinutes: 1 } }]);
  expect(fewer().hasAttribute("disabled")).toBe(true);
});
