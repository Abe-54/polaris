import { describe, expect, test } from "bun:test";
import { ApprovalDecision, type HostStreamItem, RequestId, SessionId } from "@polaris/protocol";
import { applyHostItem, emptyHostFeed } from "../home/feed/fold.ts";
import {
  commandApproval,
  DomainEvent,
  event,
  minutesAgo,
  session,
  snapshot,
  summary,
  synchronized,
  workspace,
} from "../home/fixtures.testing.ts";
import type { HomeHost } from "../home/model/home.ts";
import { inboxOf } from "./model.ts";

const host = (name: string, items: ReadonlyArray<HostStreamItem>): HomeHost => ({
  hostId: name,
  name,
  connection: "connected",
  followed: { state: items.reduce(applyHostItem, emptyHostFeed), seen: true, error: null },
});

const studio: ReadonlyArray<HostStreamItem> = [
  snapshot({
    workspaces: [workspace("w1", "polaris")],
    sessions: [
      summary(session({ id: "build", state: "needs-you" }), [
        commandApproval("build", "r1", "cargo build", minutesAgo(30)),
      ]),
      summary(session({ id: "push", state: "needs-you" }), [
        commandApproval("push", "r3", "git push", minutesAgo(2)),
      ]),
      summary(session({ id: "idle", state: "idle" })),
    ],
  }),
  synchronized(),
];

const vm: ReadonlyArray<HostStreamItem> = [
  snapshot({
    workspaces: [workspace("w1", "relay")],
    sessions: [
      summary(session({ id: "tests", state: "needs-you" }), [
        commandApproval("tests", "r2", "bun test", minutesAgo(10)),
      ]),
    ],
  }),
  synchronized(),
];

const ids = (hosts: ReadonlyArray<HomeHost>) =>
  inboxOf(hosts).items.map((row) => `${row.hostName}/${row.session.id}`);

const resolved = (sequence: number, sessionId: string, requestId: string) =>
  event(
    sequence,
    DomainEvent.cases.ApprovalResolved.make({
      sessionId: SessionId.make(sessionId),
      requestId: RequestId.make(requestId),
      decision: ApprovalDecision.cases.Allow.make({ remember: false }),
      resolvedBy: "iPhone",
    })
  );

const moved = (sequence: number, sessionId: string) =>
  event(
    sequence,
    DomainEvent.cases.SessionStateChanged.make({
      sessionId: SessionId.make(sessionId),
      state: "working",
      reason: null,
      resetsAt: null,
    })
  );

describe("the inbox", () => {
  test("interleaves every Host's requests oldest first, as Home ranks them", () => {
    expect(ids([host("Mac Studio", studio), host("Linux VM", vm)])).toEqual([
      "Mac Studio/build",
      "Linux VM/tests",
      "Mac Studio/push",
    ]);
  });

  test("a request answered anywhere leaves the inbox once its session moves on", () => {
    const answered = [...studio, resolved(2, "build", "r1"), moved(3, "build")];

    const inbox = inboxOf([host("Mac Studio", answered), host("Linux VM", vm)]);

    expect(inbox.items.map((row) => row.session.id)).toEqual([
      SessionId.make("tests"),
      SessionId.make("push"),
    ]);
    expect(inbox.count).toBe(2);
  });

  test("the last answer empties it", () => {
    const inbox = inboxOf([
      host("Linux VM", [...vm, resolved(2, "tests", "r2"), moved(3, "tests")]),
    ]);

    expect(inbox.items).toEqual([]);
    expect(inbox.count).toBe(0);
    expect(inbox.working).toBe("1 session working on 1 host");
  });

  test("the footer folds connected Hosts, names each away one, and says its answers wait", () => {
    const inbox = inboxOf([
      host("Mac Studio", studio),
      { ...host("lucas-rpi", vm), connection: "reconnecting" },
      { ...host("mac-mini.tail0d828.ts.net", []), connection: "offline" },
      host("192.168.1.20", []),
    ]);

    expect(inbox.hosts.map((footer) => footer.label)).toEqual([
      "2 connected",
      "lucas-rpi reconnecting",
      "mac-mini offline",
    ]);
    expect(inbox.away).toBe(true);
    expect(
      inboxOf([host("Mac Studio", studio), { ...host("lucas-rpi", []), connection: "offline" }])
        .away
    ).toBe(false);
    expect(inbox.items.find((row) => row.hostName === "lucas-rpi")?.stale).toBe(true);
  });

  test("a lone connected Host keeps its name, and with none connected nothing folds", () => {
    const labels = (hosts: ReadonlyArray<HomeHost>) =>
      inboxOf(hosts).hosts.map((footer) => footer.label);

    expect(labels([host("Mac Studio", studio)])).toEqual(["Mac Studio"]);
    expect(
      labels([host("Mac Studio", studio), { ...host("lucas-rpi", []), connection: "offline" }])
    ).toEqual(["1 connected", "lucas-rpi offline"]);
    expect(labels([{ ...host("lucas-rpi", []), connection: "offline" }])).toEqual([
      "lucas-rpi offline",
    ]);
  });
});
