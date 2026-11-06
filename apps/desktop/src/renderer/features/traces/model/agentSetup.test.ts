import { ReviewCheckoutId } from "@polaris/protocol";
import { expect, test } from "bun:test";
import { Placement } from "../../../commands.ts";
import { installCommand, INSTALL_COMMAND, placementOf } from "./agentSetup.ts";

const REVIEW = { id: ReviewCheckoutId.make("rc1"), path: "/code/sightline.worktrees/.review/pr-7" };

test.each([
  ["the Workspace root", { cwd: "/code/sightline", worktreeId: null }, Placement.InPlace()],
  [
    "a Review Checkout",
    { cwd: REVIEW.path, worktreeId: null },
    Placement.ReviewCheckout({ checkoutId: REVIEW.id }),
  ],
])("a new session beside one in %s works in that same checkout", (_where, session, placed) => {
  expect(placementOf(session, [REVIEW])).toEqual(placed);
});

test("a Harness the skills CLI doesn't know gets the default install", () => {
  expect(installCommand("acme")).toBe(INSTALL_COMMAND);
  expect(installCommand(null)).toBe(INSTALL_COMMAND);
});
