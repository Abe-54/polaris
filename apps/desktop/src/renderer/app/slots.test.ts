import "../test/dom.testing.ts";
import { expect, test } from "bun:test";
// A feature first, as App.tsx loads them: it imports the slots back before it has finished loading.
import "../features/session/index.ts";
import { slots } from "./slots.tsx";

test("every slot is filled whichever feature loads first", () => {
  const empty = Object.entries(slots)
    .filter(([, filler]) => filler === undefined)
    .map(([name]) => name);

  expect(empty).toEqual([]);
});
