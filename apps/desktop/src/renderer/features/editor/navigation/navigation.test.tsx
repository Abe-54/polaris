import "../../../test/dom.testing.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { KEYMAP } from "../../../../shared/keymap.ts";
import type { LanguageQueries } from "../lsp/queries.ts";
import type { LanguageRow } from "../lsp/state.ts";
import { LANGUAGE_NAVIGATION, shortcutOf } from "./commands.ts";
import { navigationContributions } from "./contribute.ts";
import { RenameField } from "./RenameField.tsx";
import { runNavigation } from "./run.ts";
import { navigationStore, openRename, openSymbolSearch } from "./store.ts";
import { Command } from "@polaris/ui";
import { SymbolResults } from "./SymbolSearch.tsx";
import { setClientPlatform } from "../../../../shared/platform.ts";

// These tests read macOS labels ("⌘↵", "⌃Space").
beforeAll(() => setClientPlatform("darwin"));

afterAll(() => setClientPlatform(null));

// Another DOM test file may have unregistered happy-dom already.
beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
  navigationStore.setState({ rename: null, symbols: null });
});

const dom = () => within(document.body);

type Lookup = Pick<LanguageQueries, "lookup" | "navigate">;

const queries = (rows: readonly LanguageRow[], seen: string[] = []): Lookup => ({
  lookup: async (_key, command, query) => {
    seen.push(`${command}:${query}`);

    return [...rows];
  },
  navigate: async (_key, row) => void seen.push(`navigate:${row.label}`),
});

describe("language commands", () => {
  test("every feature the tools row had is a command, with VS Code's keys", () => {
    expect(LANGUAGE_NAVIGATION.map((c) => [c.title, shortcutOf(c)])).toEqual([
      ["Go to definition", "F12"],
      ["Go to declaration", ""],
      ["Go to type definition", ""],
      ["Go to implementation", ""],
      ["Find references", "⇧F12"],
      ["Show hover", ""],
      ["Go to symbol in file", "⇧⌘O"],
      ["Go to symbol in workspace…", "⌘T"],
      ["Rename symbol…", "F2"],
      ["Show problems", "⇧⌘M"],
      ["Show code actions", ""],
      ["Show completions", "⌃Space"],
      ["Show signature help", "⌃⇧Space"],
      ["Go to next problem", "F8"],
      ["Go to previous problem", "⇧F8"],
      ["Go back", "⌃-"],
      ["Go forward", "⌃⇧-"],
    ]);
  });

  test("no key clashes with the app's shortcuts", () => {
    // Shortcuts that live only in another mode (Data's ⌘T) don't reach the editor.
    const app = new Set(
      KEYMAP.filter((binding) => binding.when !== "mode.data").flatMap((binding) => binding.keys)
    );

    const accelerators = new Map([
      ["Mod-t", "CmdOrCtrl+T"],
      ["Mod-Shift-m", "CmdOrCtrl+Shift+M"],
      ["Mod-Shift-o", "CmdOrCtrl+Shift+O"],
      ["Ctrl--", "Ctrl+-"],
      ["F2", "F2"],
      ["Ctrl-Space", "Ctrl+Space"],
      ["Ctrl-Shift-Space", "Ctrl+Shift+Space"],
      ["F12", "F12"],
      ["Shift-F12", "Shift+F12"],
    ]);

    for (const command of LANGUAGE_NAVIGATION)
      if (command.key !== undefined)
        expect(app.has(accelerators.get(command.key) ?? "?")).toBe(false);
  });

  test("palette contributions: file group, shortcuts as detail, follow-ups marked", () => {
    const rows = navigationContributions();

    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.find((row) => row.id === "editor.language.rename")?.palette).toMatchObject({
      group: "file",
      detail: "F2",
      followUp: true,
    });
    expect(rows.every((row) => JSON.stringify(row.when).includes("editor.file"))).toBe(true);
  });

  test("the field commands open their UI; the rest go to the queries", () => {
    const ran: string[] = [];

    const fake: Pick<LanguageQueries, "run"> = {
      run: async (_key, command) => void ran.push(command),
    };

    runNavigation("file", "problems", fake);
    runNavigation("file", "symbol-search", fake);
    expect(ran).toEqual(["problems"]);
    expect(navigationStore.getState().symbols).toBe("file");
  });
});

describe("the rename field", () => {
  const field = { key: "file", initial: "answer", left: 10, top: 10, bottom: 30 };

  test("↵ with one answer goes straight to edit acceptance and closes", async () => {
    const seen: string[] = [];
    const accepted: string[] = [];
    openRename(field);
    render(
      <RenameField
        queries={queries(
          [{ label: "Rename to renamed", detail: "", run: () => accepted.push("yes") }],
          seen
        )}
      />
    );
    const input = dom().getByLabelText("New name");

    expect(dom().getByDisplayValue("answer")).toBe(input);
    // happy-dom lacks `oninput`, so React watches the focused field's value on key events.
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyUp(input, { key: "d" });
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));

    expect(seen).toEqual(["rename:renamed"]);
    expect(accepted).toEqual(["yes"]);
    expect(navigationStore.getState().rename).toBeNull();
  });

  test("no answer says so and stays open; esc closes", async () => {
    openRename(field);
    render(<RenameField queries={queries([])} />);
    const input = dom().getByLabelText("New name");
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "other" } });
    fireEvent.keyUp(input, { key: "r" });
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));

    expect(dom().getByRole("status").textContent).toBe(
      "Nothing to rename here. If the file just opened, try again in a moment."
    );
    fireEvent.keyDown(input, { key: "Escape" });
    expect(navigationStore.getState().rename).toBeNull();
  });
});

describe("the workspace symbol search", () => {
  test("asks as you type and opens the chosen symbol", async () => {
    const seen: string[] = [];
    openSymbolSearch("file");
    // The dialog's portal is the jump menu's; its results are what this file adds.
    render(
      <Command shouldFilter={false}>
        <SymbolResults
          fileKey="file"
          queries={queries(
            [
              {
                label: "LanguageQueries",
                detail: "TypeScript · bundled",
                uri: "file:///code/polaris/queries.ts",
                range: { start: { line: 63, character: 0 }, end: { line: 63, character: 5 } },
              },
            ],
            seen
          )}
        />
      </Command>
    );

    expect(await dom().findByText("Type a symbol's name")).toBeTruthy();
    const input = dom().getByPlaceholderText("Go to symbol in workspace");
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "Queries" } });
    fireEvent.keyUp(input, { key: "s" });
    const item = await dom().findByTestId("symbol-item", undefined, { timeout: 2000 });

    expect(item.textContent).toContain("queries.ts:64");
    fireEvent.click(item);
    await act(async () => undefined);
    expect(seen).toEqual(["workspaceSymbols:Queries", "navigate:LanguageQueries"]);
    expect(navigationStore.getState().symbols).toBeNull();
  });
});

describe("vim keys", () => {
  test("Back and Forward are unavailable with nowhere to go, so vim's own jumps run", () => {
    const byId = new Map(navigationContributions().map((c) => [c.id, c]));

    expect(byId.get("editor.language.back")?.handler.enabled?.()).toBe(false);
    expect(byId.get("editor.language.forward")?.handler.enabled?.()).toBe(false);
  });
});
