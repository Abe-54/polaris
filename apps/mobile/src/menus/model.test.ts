import { describe, expect, test } from "bun:test";
import {
  ApprovalDecision,
  type ApprovalRequest,
  Command,
  decideDeviceAccess,
  RequestId,
  SessionId,
} from "@polaris/protocol";
import type { ConstellationRow, SessionRow } from "../home/model/home.ts";
import {
  commandApproval,
  constellation,
  question,
  secretRequest,
  session,
} from "../home/fixtures.testing.ts";
import { DEVICE_COMMANDS } from "@polaris/protocol";
import {
  commandOf,
  constellationMenu,
  hostMenu,
  type Menu,
  sessionMenu,
  turnMenu,
} from "./model.ts";

const row = (
  input: Parameters<typeof session>[0],
  approval: ApprovalRequest | null = null,
  stale = false
): SessionRow => ({
  kind: "session",
  key: `mac/${input.id}`,
  hostId: "mac",
  hostName: "Mac Studio",
  workspaceName: "polaris",
  session: session(input),
  approval,
  replyPreview: null,
  since: 0,
  stale,
});

const constellationRow = (
  lead: ReturnType<typeof session> | null,
  state: ConstellationRow["constellation"]["state"] = "running"
): ConstellationRow => ({
  kind: "constellation",
  key: "mac/c1",
  hostId: "mac",
  hostName: "Mac Studio",
  constellation: constellation("c1", "lead", "w1", state),
  lead,
  since: 0,
  stale: false,
});

const titles = (menu: Menu) => menu.map((group) => group.map((item) => item.title));

const wantsBuild = commandApproval("s1", "r1", "cargo build --release");

describe("an agent session's menu", () => {
  test("a session with turns opens either way and copies its ID", () => {
    expect(titles(sessionMenu(row({ id: "s1", turnCount: 3 })))).toEqual([
      ["Open agent session", "Open review"],
      ["Pin to top", "Rename…", "Archive"],
      ["Copy agent session ID"],
    ]);
  });

  // ENG-491: the phone's Archive keeps the branch, so Unarchive undoes it.
  test("pins, unpins, archives without deleting the branch, and unarchives", () => {
    const commands = (input: Parameters<typeof session>[0]) =>
      sessionMenu(row(input))
        .flat()
        .flatMap((item) => {
          const command = commandOf(item.action);

          return command === null ? [] : [command];
        });

    expect(commands({ id: "s1" })).toEqual([
      Command.cases.PinSession.make({ sessionId: SessionId.make("s1"), pinned: true }),
      Command.cases.ArchiveSession.make({
        sessionId: SessionId.make("s1"),
        deleteMergedBranch: false,
      }),
    ]);
    expect(commands({ id: "s1", state: "archived", pinnedAt: "2026-10-28T00:00:00.000Z" })).toEqual(
      [
        Command.cases.PinSession.make({ sessionId: SessionId.make("s1"), pinned: false }),
        Command.cases.UnarchiveSession.make({ sessionId: SessionId.make("s1") }),
      ]
    );
  });

  test.each([
    ["no turns yet", { id: "s1", turnCount: 0 }],
    ["a reviewer's session", { id: "s1", title: "Reviewer · serve.ts" }],
  ])("%s has nothing to review", (_, input) => {
    expect(titles(sessionMenu(row(input)))[0]).toEqual(["Open agent session"]);
  });

  test("a permission request is answered from the menu, each with its own decision", () => {
    const menu = sessionMenu(row({ id: "s1", state: "needs-you" }, wantsBuild));
    const answers = menu[1] ?? [];

    const respond = (decision: ApprovalDecision) =>
      Command.cases.RespondToApproval.make({
        sessionId: SessionId.make("s1"),
        requestId: RequestId.make("r1"),
        decision,
      });

    expect(answers.map((item) => [item.title, commandOf(item.action)])).toEqual([
      ["Approve", respond(ApprovalDecision.cases.Allow.make({ remember: false }))],
      ["Always here", respond(ApprovalDecision.cases.Allow.make({ remember: true }))],
      ["Deny", respond(ApprovalDecision.cases.Deny.make({ reason: null }))],
    ]);
  });

  test("an offline host's answers are shown disabled, saying why", () => {
    const answers = sessionMenu(row({ id: "s1", state: "needs-you" }, wantsBuild, true))[1] ?? [];
    const offline = { disabled: true, subtitle: "Host offline" };

    expect(answers.map(({ disabled, subtitle }) => ({ disabled, subtitle }))).toEqual([
      offline,
      offline,
      offline,
    ]);
  });

  test.each([
    ["a question", question("s1", "r1", "Which branch?", ["main", "dev"])],
    ["a command too long to show", commandApproval("s1", "r1", "make\n".repeat(8))],
    ["a secret", secretRequest("s1", "r1", "Tailscale auth key", "To join the tailnet")],
  ])("%s is never answered from the menu", (_, approval) => {
    const offered = sessionMenu(row({ id: "s1", state: "needs-you" }, approval)).flat();

    expect(offered.filter((item) => item.action.kind === "reply")).toEqual([]);
  });
});

describe("a stopped turn's menu (ENG-494)", () => {
  const sent = (menu: Menu) =>
    menu
      .flat()
      .flatMap((item) =>
        item.action.kind === "send" && ["retry", "continue"].includes(item.id)
          ? [[item.title, item.disabled, item.subtitle, commandOf(item.action)]]
          : []
      );

  const sessionId = SessionId.make("s1");

  test.each([
    [
      "a failed turn retries",
      { id: "s1", state: "failed" as const },
      null,
      [["Retry", false, null, Command.cases.Retry.make({ sessionId })]],
    ],
    [
      "an interrupted turn continues",
      { id: "s1", state: "needs-you" as const },
      null,
      [["Continue", false, null, Command.cases.Continue.make({ sessionId })]],
    ],
    [
      "a pending approval is answered, not continued",
      { id: "s1", state: "needs-you" as const },
      wantsBuild,
      [],
    ],
    ["a working session offers neither", { id: "s1", state: "working" as const }, null, []],
  ])("%s", (_, input, approval, expected) => {
    expect(sent(sessionMenu(row(input, approval)))).toEqual(expected);
  });

  test("an offline host's retry is shown disabled, saying why", () => {
    expect(sent(sessionMenu(row({ id: "s1", state: "failed" }, null, true)))).toEqual([
      ["Retry", true, "Host offline", Command.cases.Retry.make({ sessionId })],
    ]);
  });
});

describe("a constellation's menu", () => {
  test("opens the constellation, reviews and copies its lead", () => {
    const menu = constellationMenu(constellationRow(session({ id: "lead", turnCount: 2 })));

    expect(titles(menu)).toEqual([
      ["Open constellation", "Open review"],
      ["Pause", "Complete"],
      ["Copy agent session ID"],
    ]);
    expect(menu[2]?.[0]?.action).toEqual({ kind: "copy", text: "lead" });
  });

  // The Daemon's lifecycle: archive only once completed, nothing once archived.
  test.each<[ConstellationRow["constellation"]["state"], ReadonlyArray<string>]>([
    ["planning", []],
    ["running", ["Pause", "Complete"]],
    ["paused", ["Resume", "Complete"]],
    ["completed", ["Archive"]],
    ["archived", []],
  ])("a %s constellation offers %p", (state, offered) => {
    const items = constellationMenu(constellationRow(null, state)).flat();

    expect(
      items.filter((item) => item.action.kind === "set-state").map((item) => item.title)
    ).toEqual([...offered]);
  });
});

describe("a host's menu", () => {
  // ENG-494: the sheet opens with this Host preselected.
  test("starts a new agent session on a connected host, and retries one that isn't", () => {
    const connected = hostMenu({ hostId: "mac", name: "Mac Studio", state: "connected" });

    expect(connected.flat().map(({ title, action }) => [title, action])).toEqual([
      ["New agent session on Mac Studio…", { kind: "new-session", hostId: "mac" }],
    ]);
    expect(titles(hostMenu({ hostId: "mac", name: "Mac Studio", state: "offline" }))).toEqual([
      ["Retry now"],
    ]);
  });
});

describe("every menu", () => {
  const menus: ReadonlyArray<Menu> = [
    sessionMenu(row({ id: "s1", state: "needs-you", turnCount: 2 }, wantsBuild)),
    constellationMenu(constellationRow(session({ id: "lead", turnCount: 2 }))),
    sessionMenu(row({ id: "s2", state: "failed" })),
    sessionMenu(row({ id: "s3", state: "needs-you" })),
    hostMenu({ hostId: "mac", name: "Mac Studio", state: "reconnecting" }),
    hostMenu({ hostId: "mac", name: "Mac Studio", state: "connected" }),
  ];

  test("names each item once, so the native menu's choice runs the right one", () => {
    for (const menu of menus) {
      const ids = menu.flat().map((item) => item.id);

      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("sends only commands a linked device is granted", () => {
    const refused = menus
      .flat(2)
      .flatMap((item) => {
        const command = commandOf(item.action);

        return command === null ? [] : [decideDeviceAccess("dispatch", command._tag, command)];
      })
      .filter((refusal) => refusal !== null);

    expect(refused).toEqual([]);
  });
});

describe("a turn's menu (MX-J)", () => {
  const where = { hostId: "mac", sessionId: "s1" };

  test("copies the turn's output; fork waits until a linked device may send ForkSession", () => {
    const [items = []] = turnMenu(where, { turnId: "t-3", output: "Split the page." });

    expect(DEVICE_COMMANDS.ForkSession).toBe("local");
    expect(items.map(({ title, disabled, action }) => [title, disabled, action])).toEqual([
      ["Copy", false, { kind: "copy", text: "Split the page." }],
      ["Fork from here", true, { kind: "fork", hostId: "mac", sessionId: "s1", turnId: "t-3" }],
    ]);
  });

  test("a turn with nothing said offers no copy", () => {
    expect(titles(turnMenu(where, { turnId: "t-3", output: "" }))).toEqual([["Fork from here"]]);
  });
});
