import "../../../test/dom.testing.ts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { pullSummary } from "../preview/fixtures.ts";
import { Conversation } from "./AskReviewer.tsx";

afterEach(cleanup);

const summary = pullSummary([]);

test("leaving the conversation doesn't crash where scrollIntoView returns a Promise", () => {
  // Chromium (Electron) answers scroll calls with a Promise, which the DOM types don't admit.
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => Promise.resolve(),
  });

  try {
    const view = render(<Conversation subjectKey="pull:1" hostKey="local" summary={summary} />);

    expect(() => view.unmount()).not.toThrow();
  } finally {
    if (original === undefined) Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    else Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
  }
});
