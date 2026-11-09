import { expect, test } from "bun:test";
import { commandLine, middleCut, withoutOwnCd } from "./command.ts";

const HOME = "/Users/aleksandra.wisniewska-kowalczyk/Developer/northwind";

test.each([
  ["unquoted", `cd ${HOME} && bun run backfill`],
  ["double-quoted", `cd "${HOME}" && bun run backfill`],
  ["single-quoted, trailing slash", `cd '${HOME}/' &&bun run backfill`],
])("a %s cd into the session's own directory goes", (_, command) => {
  expect(withoutOwnCd(command, [HOME])).toBe("bun run backfill");
});

test("a cd elsewhere, or one later in the command, stays", () => {
  expect(withoutOwnCd(`cd ${HOME}/web && bun dev`, [HOME])).toBe(`cd ${HOME}/web && bun dev`);
  expect(withoutOwnCd(`bun i && cd ${HOME} && bun dev`, [HOME])).toBe(
    `bun i && cd ${HOME} && bun dev`
  );
});

test("a cut keeps both ends within the budget", () => {
  const cut = middleCut("0123456789abcdefghij", 9);

  expect(cut).toBe("0123…ghij");
  expect(Array.from(cut)).toHaveLength(9);
});

test("the issue's command keeps what it runs", () => {
  const line = commandLine(`cd ${HOME} && bun run backfill --quarter 2026-Q3 --dry-run=false`, [
    HOME,
  ]);

  expect(line).toBe("bun run backfill --quarter 2026-Q3 --dry-run=false");
});
