import "../../../test/dom.testing.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { bindRefactors, RefactorController } from "../refactors/controller.ts";
import { RefactorCoordinator } from "../refactors/coordinator.ts";
import type { DraftGroup } from "../refactors/group.ts";
import { memoryGroups } from "../refactors/storage.ts";
import { doc, fixture, proposal } from "../refactors/testing.ts";
import { RefactorRecovery } from "./RefactorRecovery.tsx";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(cleanup);

const touched = ["/checkout/src/backoff.ts", "/checkout/src/delay.ts", "/checkout/src/retry.ts"];

const group = (state: DraftGroup["state"], paths = touched): DraftGroup => ({
  format: 2,
  id: "group",
  operationId: "operation",
  hostKey: "local",
  revision: 0,
  updatedAt: Date.now(),
  fingerprint: "f".repeat(64),
  proposal: { ...proposal(), label: "Rename BASE_DELAY_MS to RETRY_DELAY_MS" },
  originals: paths.map((path) => doc(path, "before", false)),
  documents: paths.map((path) => doc(path, "after", false)),
  touched: paths,
  state,
  outcome: null,
  message: "",
});

const mounted = (state: Partial<ReturnType<RefactorController["state"]["getState"]>>) => {
  const controller = new RefactorController(
    "local",
    new RefactorCoordinator(memoryGroups(), fixture().port, "utf-16")
  );

  controller.state.setState(state);
  const unbind = bindRefactors(controller, "/checkout");
  const view = render(<RefactorRecovery hostKey="local" root="/checkout" />);

  return { controller, view, unbind };
};

test("a partial multi-file outcome is one sentence with Check again and Undo", () => {
  const { unbind } = mounted({ group: group("partial") });
  const strip = within(document.body).getByTestId("refactor-recovery");

  expect(strip.textContent).toContain(
    "Rename BASE_DELAY_MS to RETRY_DELAY_MS stopped partway through backoff.ts, delay.ts and 1 more."
  );
  expect(
    within(strip)
      .getAllByRole("button")
      .map((b) => b.textContent)
  ).toEqual(["Check again", "Undo"]);
  unbind();
});

test.each([
  ["conflict", touched],
  ["applied", touched],
  ["unknown", ["/checkout/src/main.ts"]],
] as const)("%s across %p shows nothing", (state, paths) => {
  const { unbind } = mounted({ group: group(state, [...paths]) });

  expect(within(document.body).queryByTestId("refactor-recovery")).toBeNull();
  unbind();
});

test("a failure outside the preview says so once and dismisses", () => {
  const { controller, unbind } = mounted({ error: "Error: The file isn't open." });
  const strip = within(document.body).getByTestId("refactor-recovery");

  expect(strip.textContent).toContain("Couldn't finish the refactor. The file isn't open.");
  act(() => {
    fireEvent.click(within(strip).getByRole("button", { name: "Dismiss" }));
  });
  expect(controller.state.getState().error).toBeNull();
  expect(within(document.body).queryByTestId("refactor-recovery")).toBeNull();
  unbind();
});
