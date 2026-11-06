import "../../../test/dom.testing.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SessionId, Subagent, SubagentId, TurnId } from "@polaris/protocol";
import { EntryView } from "./entries.tsx";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(cleanup);

const command = (id: string, line: string) => ({
  kind: "command" as const,
  id,
  live: false,
  command: line,
  output: `${line} output`,
  exitCode: 0,
  status: "completed" as const,
});

test("a tool run starts folded, lists its commands folded, and each opens on its own", () => {
  const { getByRole, queryByRole, queryByText } = render(
    <EntryView
      entry={{
        kind: "run",
        id: "run-folds",
        items: [command("c1", "git status"), command("c2", "bun test")],
        summary: "Ran 2 commands",
      }}
      ctx={{ hue: "claude", onOpenDiff: () => {} }}
    />
  );

  const run = getByRole("button", { name: /Ran 2 commands/ });
  expect(run.getAttribute("aria-expanded")).toBe("false");
  expect(queryByRole("button", { name: /\$ git status/ })).toBeNull();

  fireEvent.click(run);
  expect(run.getAttribute("aria-expanded")).toBe("true");
  expect(queryByRole("button", { name: /\$ git status/ })).not.toBeNull();
  expect(queryByText("git status output")).toBeNull();

  fireEvent.click(getByRole("button", { name: /\$ git status/ }));
  expect(queryByText("git status output")).not.toBeNull();
  expect(queryByText("bun test output")).toBeNull();
});

test("a finished Subagent's report stays folded until its card opens", () => {
  const subagent = new Subagent({
    id: SubagentId.make("toolu_report"),
    sessionId: SessionId.make("s1"),
    turnId: TurnId.make("t1"),
    parentItemId: "toolu_report",
    title: "Explore the visualize tool",
    agent: "Explore",
    model: null,
    status: "completed",
    startedAt: "2026-10-01T00:00:00.000Z",
    endedAt: "2026-10-01T00:01:00.000Z",
  });

  const { getByRole, queryByTestId } = render(
    <EntryView
      entry={{
        kind: "subagent",
        card: {
          id: "toolu_report",
          subagent,
          task: null,
          entries: [],
          report: "The visualize tool takes a title and html.",
          activity: null,
        },
      }}
      ctx={{ hue: "claude", onOpenDiff: () => {} }}
    />
  );

  expect(queryByTestId("subagent-report")).toBeNull();

  fireEvent.click(getByRole("button", { name: /Explore the visualize tool/ }));
  expect(queryByTestId("subagent-report")?.textContent).toContain("takes a title and html");
});
