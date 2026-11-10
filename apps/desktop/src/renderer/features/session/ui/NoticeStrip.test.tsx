import "../../../test/dom.testing.ts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ApprovalRequest, SubagentId } from "@polaris/protocol";
import { subagentMoon } from "@polaris/ui";
import { afterEach, describe, expect, test } from "bun:test";
import { approval } from "../../../store/fixtures.testing.ts";
import { type NoticeInput, notices } from "../model/notices.ts";
import type { TodoList } from "../model/todoList.ts";
import { NoticeStrip } from "./NoticeStrip.tsx";

afterEach(() => cleanup());

const todo: TodoList = {
  steps: [
    { text: "Read the notice strip", status: "completed", detail: null },
    { text: "Write the tests", status: "in-progress", detail: "Writing the tests" },
    { text: "Run the checks", status: "pending", detail: null },
  ],
  current: 1,
  label: "Writing the tests",
  done: 1,
};

const quiet: NoticeInput = {
  approvals: [],
  working: false,
  todo: null,
  outbox: [],
  contextShare: null,
  contextDismissedAt: null,
  limited: false,
  resetsAt: null,
};

const show = (patch: Partial<NoticeInput>) =>
  render(
    <NoticeStrip
      harness="claude"
      notices={notices({ ...quiet, ...patch })}
      working={patch.working === true ? { elapsed: "1m 12s", onStop: () => undefined } : undefined}
      onUnqueue={() => undefined}
      onCompact={null}
      onDismissContext={() => undefined}
      onSwitchModel={() => undefined}
    />
  );

describe("the todo list in the notice strip", () => {
  test("sits under Working with the item in progress and its count, and opens to the checklist", () => {
    show({ working: true, todo });

    const row = screen.getByTestId("notice-todo");

    expect(row.textContent).toContain("Writing the tests");
    expect(row.textContent).toContain("2 of 3");
    expect(screen.queryByTestId("notice-more")).toBeNull();
    expect(screen.queryByTestId("todo-list")).toBeNull();

    fireEvent.click(within(row).getByTestId("todo-toggle"));

    const list = screen.getByTestId("todo-list");

    expect(list.textContent).toContain("Read the notice strip");
    expect(list.textContent).toContain("Run the checks");
  });

  test("waits behind an approval's +n", () => {
    show({ approvals: [approval], todo });

    expect(screen.getByTestId("notice-approval")).not.toBeNull();
    expect(screen.queryByTestId("notice-todo")).toBeNull();
    expect(screen.getByTestId("notice-more").textContent).toContain("+1");
  });
});

describe("an approval in the notice strip", () => {
  test("a Subagent's request says a subagent asks, with its moon", () => {
    const asked = ApprovalRequest.make({
      id: approval.id,
      sessionId: approval.sessionId,
      turnId: approval.turnId,
      kind: "command",
      subagentId: SubagentId.make("sub-2"),
      title: approval.title,
      detail: null,
      options: [],
      openedAt: approval.openedAt,
    });

    show({
      approvals: [asked],
      subagents: [
        { id: "sub-1", index: 0 },
        { id: "sub-2", index: 1 },
      ],
    });

    const row = screen.getByTestId("notice-approval");

    expect(row.textContent).toContain("A subagent wants to run");
    expect(row.querySelector("[data-slot=celestial]")?.getAttribute("data-body")).toBe(
      subagentMoon(1)
    );
  });

  test("the lead's own request names the Harness, with no moon", () => {
    show({ approvals: [approval], subagents: [{ id: "sub-1", index: 0 }] });

    const row = screen.getByTestId("notice-approval");

    expect(row.textContent).toContain("Claude Code wants to run");
    expect(row.querySelector("[data-slot=celestial]")).toBeNull();
  });
});
