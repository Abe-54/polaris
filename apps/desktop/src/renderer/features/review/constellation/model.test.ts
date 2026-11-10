import { describe, expect, test } from "bun:test";
import { asPlain } from "../../../store/plain.ts";
import { C1, C2, HOSTS, MODELS } from "../../sessions/preview/fixtures.ts";
import { queueGroups, type SessionInfo } from "../model/queue.ts";
import { workerQueue } from "./claims.ts";
import { sendBackReason, workerActionKind, workerCaption } from "./model.ts";

const found = C1.constellation.attempts.find((a) => a.taskId === "B1");

if (found === undefined) throw new Error("B1 has an Attempt");

const b1 = asPlain(found);

describe("worker header", () => {
  test("says whose worker it is and where its Claim stands", () => {
    expect(workerCaption(b1, "Constellations v1 lead")).toBe(
      "worker of Constellations v1 lead · claim in review at 3f9c2e1"
    );
    expect(workerCaption({ ...b1, state: "accepted", mergedHead: "8e41d07aa" }, "L")).toBe(
      "worker of L · accepted at 8e41d07"
    );
  });

  test("says when the user approved it, or the Lead handed it up", () => {
    expect(workerCaption({ ...b1, handedUpAt: "2026-10-01T10:00:00.000Z" }, "L")).toBe(
      "worker of L · claim at 3f9c2e1 handed to you"
    );
    expect(
      workerCaption(
        {
          ...b1,
          handedUpAt: "2026-10-01T10:00:00.000Z",
          approvedByUserAt: "2026-10-01T10:05:00.000Z",
        },
        "L"
      )
    ).toBe("worker of L · claim at 3f9c2e1 approved by you · the lead merges");
  });

  test("an amended Claim says which head it replaced", () => {
    expect(workerCaption({ ...b1, previousClaimHead: "a83489c0ff" }, "L")).toBe(
      "worker of L · claim in review at 3f9c2e1 · amended from a83489c"
    );
  });

  test("a working worker waiting for a slot says on which Host", () => {
    expect(workerCaption({ ...b1, state: "working" }, "L", "devbox")).toBe(
      "worker of L · waiting for a slot on devbox"
    );
    expect(workerCaption({ ...b1, state: "working" }, "L")).toBe(
      "worker of L · working on its task"
    );
  });

  test("only a Claim in review gets Approve", () => {
    expect(workerActionKind(b1)).toBe("review");
    expect(workerActionKind({ ...b1, state: "working" })).toBe("working");
    expect(workerActionKind({ ...b1, state: "lost" })).toBe("settled");
  });
});

test("the feedback batch becomes one send-back reason", () => {
  expect(sendBackReason({ message: " ", comments: [] })).toBeNull();
  expect(
    sendBackReason({
      message: "Count promotions per Gate.",
      comments: [
        {
          id: "c",
          path: "packages/spec/polaris.qnt",
          lines: { start: 212, end: 212, side: "new" },
          code: "val gatePromotedOnce = promotions.size() <= gates.size()",
          note: "A Gate promoted twice slips through.",
          findingId: null,
        },
      ],
    })
  ).toBe(
    "Count promotions per Gate.\n\npolaris.qnt:212: A Gate promoted twice slips through.\n    val gatePromotedOnce = promotions.size() <= gates.size()"
  );
});

test("Review's queue lists workers' Claims, and no worker as a plain session", () => {
  const workers = workerQueue({ local: [C1, C2] }, HOSTS, MODELS);

  const sessions: ReadonlyArray<SessionInfo> = ["b1", "b2", "glossary"].map((id) => ({
    hostKey: "local",
    // SAFETY: test ids.
    id: id as SessionInfo["id"],
    title: id,
    harness: "codex",
    state: "idle",
    turnCount: 3,
    acceptedThroughIndex: null,
    userTurns: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    workspaceName: "polaris",
  }));

  const groups = queueGroups(null, sessions, workers);

  expect(groups.map((g) => [g.id, g.rows.map((r) => r.title)])).toEqual([
    ["claims", ["B1 · Quint properties", "B4 · Streamable-HTTP endpoint"]],
    ["sessions", ["glossary"]],
  ]);
});
