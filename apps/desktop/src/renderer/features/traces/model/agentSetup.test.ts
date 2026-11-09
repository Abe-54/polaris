import { ReviewCheckoutId } from "@polaris/protocol";
import { expect, test } from "bun:test";
import { Placement } from "../../../commands.ts";
import { placementOf } from "./agentSetup.ts";

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
