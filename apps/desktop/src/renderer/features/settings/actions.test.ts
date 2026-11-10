import { expect, test } from "bun:test";
import { Predicate } from "effect";
import type { CommandId } from "../../../shared/keymap.ts";
import { paletteEntry } from "../../../shared/keymap.ts";
import { SETTINGS_BINDINGS } from "../../../shared/keymapSettings.ts";
import type { ShellActions } from "../../routes/navigation.ts";
import { settingsCommands } from "./actions.ts";

const opened: Array<string | undefined> = [];

const shell: Pick<ShellActions, "openSettings"> = {
  openSettings: (section) => void opened.push(section),
};

// SAFETY: Settings' commands call only `openSettings` (and the updates store) on the shell.
const handlers = settingsCommands(shell as ShellActions);

const run = (id: CommandId) => {
  const handler = handlers[id];

  if (handler !== undefined && Predicate.hasProperty(handler, "run")) handler.run();
};

const sectionCommands = SETTINGS_BINDINGS.flatMap((binding) => {
  const section = /^settings\.(\w+)$/.exec(binding.id)?.[1];

  return section === undefined || section === "open" ? [] : [[binding.id, section] as const];
});

test.each(sectionCommands)("%s opens Settings at %s", (id, section) => {
  opened.length = 0;
  run(id);

  expect(opened).toEqual([section]);
});

test("the K menu lists Settings: Voice and Settings: Attachments", () => {
  const titles: Array<string> = SETTINGS_BINDINGS.filter(
    (binding) => paletteEntry(binding) !== null
  ).map((binding) => binding.title);

  expect(titles).toContain("Settings: Voice");
  expect(titles).toContain("Settings: Attachments");
});
