import "../../test/dom.testing.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { overlayOpen } from "./placement.ts";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ENG-612: a session with a few Turns has the Turns rail, which kept every page hidden.
test("a listbox inside the app, like the Turns rail, doesn't cover the page", () => {
  document.body.innerHTML = '<div id="root"><div role="listbox" aria-label="Turns"></div></div>';

  expect(overlayOpen(document.body)).toBe(false);
});

test.each([
  ["a dialog", '<div role="dialog"></div>'],
  [
    "a menu in a popper wrapper",
    '<div data-radix-popper-content-wrapper><div role="menu"></div></div>',
  ],
  ["a listbox in a portal", '<div><div role="listbox"></div></div>'],
])("%s in a portal covers the page", (_name, portal) => {
  document.body.innerHTML = `<div id="root"></div>${portal}`;

  expect(overlayOpen(document.body)).toBe(true);
});
