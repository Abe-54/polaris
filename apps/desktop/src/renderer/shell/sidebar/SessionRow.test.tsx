import "../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../app/slots.tsx";
import { TooltipProvider } from "@polaris/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { FIXTURE_SESSIONS } from "../../features/data/preview/fixtures.ts";
import { DATA_AT, dataHost, dataHostModel } from "../../features/data/preview/scene.ts";
import { createCommandRegistry } from "../../routes/commands.ts";
import { createNavigation } from "../../routes/navigation.ts";
import { type AppState, initialState } from "../../store/store.ts";
import { AppProvider } from "../hooks.ts";
import { CompactSessionRow } from "./SessionRow.tsx";

afterEach(cleanup);

/** Backfill currency's compact row; returns the row, a button. */
const mount = () => {
  const model = dataHostModel();
  const entry = model.sessions.get(FIXTURE_SESSIONS.backfill.id);

  if (entry === undefined) throw new Error("No backfill session in the scene");

  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [dataHost()],
    hostModels: { [DATA_AT.hostKey]: model },
  }));

  render(
    <AppProvider
      value={{
        connection: {
          store,
          openSession: () => () => undefined,
          setDensity: () => undefined,
          setAppearance: () => undefined,
        },
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TooltipProvider>
        <CompactSessionRow hostKey={DATA_AT.hostKey} entry={entry} now={Date.now()} meta="2m" />
      </TooltipProvider>
    </AppProvider>
  );

  return { row: screen.getByText(entry.session.title).closest("[role=button],button"), entry };
};

test("F2 on a focused session row edits its title in place", () => {
  const { row, entry } = mount();

  if (!(row instanceof HTMLElement)) throw new Error("No session row");
  fireEvent.keyDown(row, { key: "F2" });

  const field = screen.getByRole("textbox", { name: "Session title" });

  expect(field).toHaveProperty("value", entry.session.title);
  expect(document.activeElement).toBe(field);
});

test("⌘F2 leaves the row as it is", () => {
  const { row } = mount();

  if (!(row instanceof HTMLElement)) throw new Error("No session row");
  fireEvent.keyDown(row, { key: "F2", metaKey: true });

  expect(screen.queryByRole("textbox", { name: "Session title" })).toBeNull();
});
