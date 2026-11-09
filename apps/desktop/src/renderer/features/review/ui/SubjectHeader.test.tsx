import "../../../test/dom.testing.ts";
import { TooltipProvider } from "@polaris/ui";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import type { ReviewersView } from "../../../../shared/githubActions.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { pullDetail } from "../../../test/github.testing.ts";
import { stackedDetail } from "../../pulls/preview/stack.ts";
import { Reviewers } from "../merge/ui/Reviewers.tsx";
import { PullHeader } from "./SubjectHeader.tsx";

// happy-dom has no layout: the toolbar's width and its items' widths are faked by test id.
const WIDTHS = new Map([
  ["pull-status", 64],
  ["stack-chip", 58],
  ["reviewers-open", 132],
]);

let toolbarWidth = 0;

const restores: Array<() => void> = [];

const fake = (key: "offsetWidth" | "clientWidth", get: (el: HTMLElement) => number) => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);

  Object.defineProperty(HTMLElement.prototype, key, {
    configurable: true,
    get(this: HTMLElement) {
      return get(this);
    },
  });
  restores.push(() => {
    if (original === undefined) Reflect.deleteProperty(HTMLElement.prototype, key);
    else Object.defineProperty(HTMLElement.prototype, key, original);
  });
};

beforeEach(() => {
  fake("offsetWidth", (el) => WIDTHS.get(el.dataset.testid ?? "") ?? 0);
  fake("clientWidth", (el) => (el.dataset.testid === "pull-review-toolbar" ? toolbarWidth : 0));
});

afterEach(() => {
  cleanup();

  for (const restore of restores.splice(0)) restore();
});

const NOBODY: ReviewersView = {
  requested: [],
  reviewed: [],
  suggested: [],
  canRequest: true,
  author: "lpark",
};

const mount = (width: number) => {
  toolbarWidth = width;
  const store = createStore<AppState>(() => initialState);

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const detail = stackedDetail(pullDetail({ isDraft: true }));

  return render(
    <AppProvider
      value={{
        connection,
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TooltipProvider>
        <PullHeader
          name="acme/atlas"
          number={detail.number}
          detail={detail}
          url={detail.url}
          actions={
            <Reviewers
              pull={{ repo: { owner: "acme", name: "atlas" }, number: detail.number }}
              view={NOBODY}
              viewer="you"
            />
          }
        />
      </TooltipProvider>
    </AppProvider>
  );
};

test("a stacked draft's stack chip sits beside Draft in the flow, apart from Request reviewers", () => {
  const view = mount(1200);
  const toolbar = view.getByTestId("pull-review-toolbar");
  const status = view.getByTestId("pull-review-status");
  const actions = view.getByTestId("pull-review-actions");

  expect([...toolbar.children]).toEqual([status, actions]);
  expect([...status.children]).toEqual([
    view.getByTestId("pull-status"),
    view.getByTestId("stack-chip"),
  ]);
  expect(view.getByTestId("pull-status").textContent).toBe("Draft");
  expect(view.getByTestId("stack-chip").textContent).toBe("2/4");
  expect(actions.contains(view.getByTestId("reviewers-open"))).toBe(true);
  expect(view.getByTestId("reviewers-open").textContent).toBe("Request reviewers");
});

test("in a narrow toolbar Request reviewers collapses to its icon, named for assistive tech", () => {
  const view = mount(240);
  const reviewers = view.getByRole("button", { name: "Request reviewers" });

  expect(reviewers.dataset.testid).toBe("reviewers-open");
  expect(reviewers.textContent).toBe("");
  expect(reviewers.querySelector("svg")).not.toBeNull();
  expect(view.getByTestId("stack-chip").textContent).toBe("2/4");
});
