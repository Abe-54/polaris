import { expect, test } from "bun:test";
import { placeMenu } from "./menuPlacement.ts";

test("the menu opens above with room for all of it, capped at its own height", () => {
  expect(placeMenu(600, 900)).toEqual({ side: "above", room: 320 });
});

test("short of room above with more below (the new-session page), it opens below", () => {
  expect(placeMenu(190, 700)).toEqual({ side: "below", room: 320 });
});

test("short on both sides it takes the roomier one and shrinks to fit", () => {
  expect(placeMenu(240, 120)).toEqual({ side: "above", room: 232 });
  expect(placeMenu(100, 180)).toEqual({ side: "below", room: 172 });
});
