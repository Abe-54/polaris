import "../../test/dom.testing.ts";
import { CopyProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { useEffect, useRef, useState } from "react";
import type { RendererCrash } from "../../../shared/crash.ts";
import { PaneBoundary } from "./PaneBoundary.tsx";

let reports: Array<RendererCrash> = [];

let quiet: { mockRestore: () => void } | null = null;

// React logs every caught error; the reports array is what's under test.
beforeEach(() => {
  reports = [];
  quiet = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  quiet?.mockRestore();
});

const report = (crash: RendererCrash) => reports.push(crash);

/** ENG-756's shape: an effect returning scrollIntoView's value, which React calls as the cleanup. */
const PromiseCleanup = () => {
  const end = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    return end.current?.scrollIntoView();
  }, []);

  return <p ref={end}>conversation</p>;
};

/** Chromium (Electron) answers scroll calls with a Promise, which the DOM types don't admit. */
const promisingScroll = () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => Promise.resolve(),
  });

  return () => {
    if (original === undefined) Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    else Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
  };
};

test("a commit-phase error (an effect's Promise called as cleanup) shows the pane's error state", () => {
  const restore = promisingScroll();
  let hide = () => {};

  const Pane = () => {
    const [shown, setShown] = useState(true);

    hide = () => setShown(false);

    return shown ? <PromiseCleanup /> : <p>findings</p>;
  };

  render(
    <div>
      <nav>sidebar</nav>
      <PaneBoundary pane="review" report={report}>
        <Pane />
      </PaneBoundary>
    </div>
  );

  act(() => hide());
  restore();

  expect(screen.getByRole("alert").textContent).toContain("Review hit an error");
  expect(screen.getByText("sidebar")).toBeTruthy();
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ kind: "boundary", pane: "review" });
  expect(reports[0]?.message).toMatch(/not a function/);
});

test("a render error shows its message; Reload mounts the pane again", () => {
  let broken = true;

  const Flaky = () => {
    if (broken) throw new Error("row 3 has no id");

    return <p>pull requests</p>;
  };

  render(
    <PaneBoundary pane="session" report={report}>
      <Flaky />
    </PaneBoundary>
  );

  expect(screen.getByRole("alert").textContent).toContain("Couldn't show this agent session");
  expect(screen.getByText("row 3 has no id")).toBeTruthy();
  expect(reports[0]?.componentStack).toContain("PaneBoundary");

  broken = false;
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));

  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("pull requests")).toBeTruthy();
});

test("moving to another subject clears the error", () => {
  const Thrower = ({ id }: { readonly id: string }) => {
    if (id === "pull:905") throw new Error("bad pull");

    return <p>{id}</p>;
  };

  const view = render(
    <PaneBoundary pane="review" resetOn="pull:905" report={report}>
      <Thrower id="pull:905" />
    </PaneBoundary>
  );

  expect(screen.getByRole("alert")).toBeTruthy();

  view.rerender(
    <PaneBoundary pane="review" resetOn="pull:906" report={report}>
      <Thrower id="pull:906" />
    </PaneBoundary>
  );

  expect(screen.getByText("pull:906")).toBeTruthy();
});

test("Copy details copies the title, the message and the stack", async () => {
  const copied: Array<string> = [];

  const Broken = () => {
    throw new Error("cannot read properties of undefined");
  };

  render(
    <CopyProvider write={async (text) => copied.push(text) > 0}>
      <PaneBoundary pane="data" report={report}>
        <Broken />
      </PaneBoundary>
    </CopyProvider>
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
  });

  expect(copied).toHaveLength(1);
  expect(copied[0]).toStartWith(
    "Data hit an error\n\ncannot read properties of undefined\n\nError:"
  );
  expect(copied[0]).toContain("Components:");
});
