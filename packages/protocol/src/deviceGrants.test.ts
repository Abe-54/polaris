import { expect, test } from "bun:test";
import { Command, SessionPlacement } from "./commands.ts";
import { SetConstellationStateAction } from "./constellation/commands.ts";
import { decideDeviceAccess } from "./deviceGrants.ts";
import { ReviewCheckoutId, SessionId, WorkspaceId } from "./ids.ts";

const outcome = (rpc: string, tag: string | null, command: Command | null = null) =>
  decideDeviceAccess(rpc, tag, command)?.what ?? "allowed";

test("a Linked Device may send the Mobile App's Commands", () => {
  expect(outcome("dispatch", "SendTurn")).toBe("allowed");
  expect(outcome("dispatch", "RespondToApproval")).toBe("allowed");
});

// ENG-627: the model sheet changes an existing session's mode or Model, as StartSession may set them.
test.each(["SetPermissionMode", "SetModel"])("a Linked Device may send %s", (tag) => {
  expect(outcome("dispatch", tag)).toBe("allowed");
});

// ENG-559: Ask the reviewer (MX-S) runs on the phone; the walkthrough still runs from the Mac.
test("a Linked Device may ask the reviewer, but not start a walkthrough", () => {
  expect(outcome("review.askFinding", null)).toBe("allowed");
  expect(outcome("review.runWalkthrough", null)).toBe("review.runWalkthrough");
});

// RX2-1: `dispatch` is decided by its Command, and anything unnamed is refused.
test.each([
  ["dispatch", "RunShellCommand", "dispatch:RunShellCommand"],
  ["dispatch", "FutureCommand", "dispatch:FutureCommand"],
  ["dispatch", "constructor", "dispatch:constructor"],
  ["dispatch", null, "dispatch:"],
  ["voice.setKey", null, "voice.setKey"],
  ["future.newRpc", null, "future.newRpc"],
])("a Linked Device is refused %s %s", (rpc, command, refused) => {
  expect(outcome(rpc, command)).toBe(refused);
});

type StartSession = typeof Command.cases.StartSession.Type;

/** StartSession as the Mobile App builds it (`apps/mobile/src/newSession/model.ts`). */
const start = (fields: Partial<StartSession> = {}) =>
  outcome(
    "dispatch",
    "StartSession",
    Command.cases.StartSession.make({
      sessionId: SessionId.make("s1"),
      workspaceId: WorkspaceId.make("w1"),
      harness: "claude",
      placement: SessionPlacement.cases.InPlace.make({}),
      permissionMode: "plan",
      model: null,
      effort: null,
      prompt: "hi",
      attachments: [],
      ...fields,
    })
  );

const newWorktree = SessionPlacement.cases.NewWorktree.make({
  branch: "polaris/hi-s1",
  baseRef: null,
});

// RX3-1, ENG-458: a phone starts a session in any mode the Mobile App offers.
test.each<[string, Partial<StartSession>]>([
  ["plan, in place", {}],
  ["supervised, in a new worktree", { permissionMode: "supervised", placement: newWorktree }],
  ["auto-edits", { permissionMode: "auto-edits" }],
  ["auto", { permissionMode: "auto" }],
  ["full-access", { permissionMode: "full-access" }],
  ["a null tier and origin", { serviceTier: null, origin: null }],
  ["an effort", { effort: "high" }],
  ["fast mode", { serviceTier: "priority" }],
])("a Linked Device may start a session: %s", (_, fields) => {
  expect(start(fields)).toBe("allowed");
});

test.each<[string, Partial<StartSession>]>([
  ["a reviewer origin", { origin: "reviewer" }],
  ["a walkthrough origin", { origin: "walkthrough" }],
  [
    "a base ref",
    {
      placement: SessionPlacement.cases.NewWorktree.make({ ...newWorktree, baseRef: "main" }),
    },
  ],
  [
    "an existing worktree",
    { placement: SessionPlacement.cases.ExistingWorktree.make({ path: "/etc" }) },
  ],
  [
    "a review checkout",
    {
      placement: SessionPlacement.cases.ReviewCheckout.make({
        checkoutId: ReviewCheckoutId.make("c1"),
      }),
    },
  ],
])("a Linked Device is refused a session with %s", (_, fields) => {
  expect(start(fields)).toBe("dispatch:StartSession");
});

test("a StartSession the gate couldn't decode is refused", () => {
  expect(outcome("dispatch", "StartSession", null)).toBe("dispatch:StartSession");
});

// ENG-491: a phone manages agent sessions and constellations, but never deletes a branch.
test.each([
  ["dispatch", "RenameSession"],
  ["dispatch", "PinSession"],
  ["dispatch", "UnarchiveSession"],
])("a Linked Device may send %s %s", (rpc, tag) => {
  expect(outcome(rpc, tag)).toBe("allowed");
});

test.each([
  [false, "allowed"],
  [true, "dispatch:ArchiveSession"],
])("a Linked Device archiving with deleteMergedBranch %p is %s", (deleteMergedBranch, expected) => {
  const archive = Command.cases.ArchiveSession.make({
    sessionId: SessionId.make("s1"),
    deleteMergedBranch,
  });

  expect(outcome("dispatch", "ArchiveSession", archive)).toBe(expected);
});

const setState = (action: SetConstellationStateAction | null) =>
  decideDeviceAccess("constellation.set_state", null, null, action)?.what ?? "allowed";

const A = SetConstellationStateAction.cases;

test.each([A.Pause.make({}), A.Resume.make({}), A.Complete.make({}), A.Archive.make({})])(
  "a Linked Device may change a constellation's state: %p",
  (action) => {
    expect(setState(action)).toBe("allowed");
  }
);

// A phone never hands a constellation's lead to another Harness or model.
test.each([
  ["a HandOver", A.HandOver.make({ summary: "s", interrupt: false, selection: null })],
  ["an action it couldn't read", null],
])("a Linked Device is refused %s", (_, action) => {
  expect(setState(action)).toBe("constellation.set_state");
});

// ENG-559: the Mobile App's stats sheet and completion card read `constellation.stats`.
test("a Linked Device may read a constellation's stats", () => {
  expect(outcome("constellation.stats", null)).toBe("allowed");
});
