import "../../../test/dom.testing.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { Command } from "./command.tsx";

/** happy-dom lays nothing out: a line is 300px wide and each character 7px, as in mono. */
const LINE_PX = 300;

const CHAR_PX = 7;

const saved = {
  scroll: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth"),
  client: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
};

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return (this.textContent ?? "").length * CHAR_PX;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => LINE_PX,
  });
});

// happy-dom defines both on Element, so usually there is no own descriptor to put back: delete.
afterAll(() => {
  for (const [key, descriptor] of [
    ["scrollWidth", saved.scroll],
    ["clientWidth", saved.client],
  ] as const) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, key);
    else Object.defineProperty(HTMLElement.prototype, key, descriptor);
  }
});

afterEach(cleanup);

const finished = (id: string, command: string) => ({
  kind: "command" as const,
  id,
  live: false,
  command,
  output: "",
  exitCode: 0,
  status: "completed" as const,
});

const LONG =
  "bun run --cwd apps/desktop test --filter session --reporter dots && bun run quality --check --range origin/main..HEAD";

const MULTI = "cd apps\nbun test";

const pastOpenDelay = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 450)));

/** Focuses the command's row, as Tab does, and waits past the card's open delay. */
const focusRow = async (command: string) => {
  const view = render(<Command item={finished(command, command)} hue="claude" />);
  fireEvent.focus(view.getByRole("button", { name: /\$ / }));
  await pastOpenDelay();

  return view;
};

test.each([
  ["a long command", LONG],
  ["a multi-line command", MULTI],
])("%s opens whole in a hover card with a copy action", async (_, command) => {
  const view = await focusRow(command);
  const card = view.getByTestId("command-card");

  expect(within(card).getByTestId("command-card-text").textContent).toBe(command);
  expect(within(card).getByRole("button", { name: "Copy command" })).not.toBeNull();
});

test("a short command, shown whole on its line, offers no hover card", async () => {
  const view = await focusRow("git status");

  expect(view.queryByTestId("command-card")).toBeNull();
});

test("an open command wraps to its whole text, so it offers no hover card", async () => {
  const view = render(<Command item={finished("open", LONG)} hue="claude" />);
  const row = view.getByRole("button", { name: /\$ / });
  fireEvent.click(row);
  fireEvent.focus(row);
  await pastOpenDelay();

  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(view.queryByTestId("command-card")).toBeNull();
});
