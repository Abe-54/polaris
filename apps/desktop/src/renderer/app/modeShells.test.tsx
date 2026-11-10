/**
 * The lazy modes' first open (ENG-905): before the chunk arrives the mode draws its shell (the
 * Workspace bar and its frames, never an empty box); once warmed it draws the mode at once.
 * The real wrappers, over chunks whose imports the test controls.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { ComponentType, ReactNode } from "react";
import { closeReviewSubject } from "../routes/review.ts";
import { modeChunk } from "../shell/modeChunk.ts";
import { dataModeOver } from "../features/data/ui/LazyDataMode.tsx";
import { editModeOver } from "../features/editor/explorer/ui/LazyEditMode.tsx";
import { requestsModeOver } from "../features/requests/ui/LazyRequestsMode.tsx";
import { reviewViewOver } from "../features/review/ui/LazyReview.tsx";
import { tracesModeOver } from "../features/traces/ui/LazyTracesMode.tsx";
import { AT, providers } from "../features/traces/ui/mode.testing.tsx";

afterEach(cleanup);

const never = () => new Promise<never>(() => undefined);

const mount = (node: ReactNode) => {
  const { wrapper: Wrapper } = providers({
    watch: () => () => undefined,
    get: never,
    span: never,
    compare: never,
  });

  return render(<Wrapper>{node}</Wrapper>);
};

const Loaded = () => <div data-testid="mode-loaded" />;

const subject = { kind: "session", hostKey: AT.hostKey, sessionId: AT.sessionId } as const;

/** A chunk that never arrives, or one the warm-up has already loaded. */
const chunkOf = async <M,>(module: M, warm: boolean) => {
  const chunk = modeChunk(() => (warm ? Promise.resolve(module) : never()));

  if (warm) await chunk.load();

  return chunk;
};

const MODES: ReadonlyArray<{
  name: string;
  sidebar: string;
  panel: string;
  view: (warm: boolean) => Promise<ComponentType>;
}> = [
  {
    name: "Data",
    sidebar: "Data",
    panel: "Data panel",
    view: async (warm) =>
      dataModeOver(await chunkOf({ DataMode: Loaded, openEditsShelf: () => undefined }, warm)),
  },
  {
    name: "Traces",
    sidebar: "Traces",
    panel: "Traces panel",
    view: async (warm) => tracesModeOver(await chunkOf({ TracesMode: Loaded }, warm)),
  },
  {
    name: "Requests",
    sidebar: "Requests",
    panel: "Requests panel",
    view: async (warm) => requestsModeOver(await chunkOf({ RequestsMode: Loaded }, warm)),
  },
  {
    name: "Edit",
    sidebar: "Explorer",
    panel: "Editor",
    view: async (warm) => editModeOver(await chunkOf({ EditMode: Loaded }, warm)),
  },
];

const Review = async (warm: boolean) => {
  const View = reviewViewOver(await chunkOf({ ReviewView: Loaded }, warm));

  return () => <View subject={subject} onBack={closeReviewSubject} />;
};

for (const mode of MODES) {
  test(`${mode.name}: the Workspace bar, sidebar and panel show while its chunk loads`, async () => {
    const View = await mode.view(false);

    mount(<View />);

    const main = screen.getByRole("main");

    expect(main.getAttribute("aria-busy")).toBe("true");
    // The Workspace bar stays: the fixture's Workspace chip is on screen.
    expect(screen.getAllByText("ledger").length).toBeGreaterThan(0);
    expect(within(main).getByRole("complementary", { name: mode.sidebar })).not.toBeNull();
    expect(within(main).getByRole("region", { name: mode.panel })).not.toBeNull();
  });
}

test("Review: the queue, centre panel and risk column show while its chunk loads", async () => {
  const View = await Review(false);

  mount(<View />);

  expect(screen.getByRole("navigation", { name: "Review queue" }).textContent).toBe("Review");
  expect(screen.getByRole("region", { name: "Review panel" })).not.toBeNull();
  expect(screen.getByRole("complementary", { name: "Risk summary" })).not.toBeNull();
});

// React.lazy would suspend once even on a loaded chunk, and hold the shell for its reveal throttle.
for (const mode of [...MODES, { name: "Review", view: Review }]) {
  test(`${mode.name}: once warmed, the first open draws the mode, not its shell`, async () => {
    const View = await mode.view(true);

    mount(<View />);

    expect(screen.queryByTestId("mode-loaded")).not.toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
}
