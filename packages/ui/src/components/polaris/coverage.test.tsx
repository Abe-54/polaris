import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { harnessEntry } from "@polaris/protocol";

import { HarnessChoice } from "./harness-choice";
import { HostStateCard, HostStateChip } from "./host-state";
import { MachineBar } from "./machine-bar";
import { NeedsYouCard, WaitingCard } from "./needs-you";
import { SetupRow } from "./onboarding";
import { QuestionCard } from "./question-card";

afterEach(cleanup);

describe("HostStateChip", () => {
  test("says the Connection State in words", () => {
    const cases = [
      ["connected", undefined, "Mac Studio"],
      ["reconnecting", "12s", "Linux VM · reconnecting 12s"],
      ["offline", "09:14", "MacBook Pro · offline since 09:14"],
    ] as const;

    for (const [state, since, text] of cases) {
      const host = text.split(" · ")[0] ?? "";
      const { container } = render(<HostStateChip host={host} state={state} since={since} />);

      expect(container.textContent).toBe(text);
      cleanup();
    }
  });

  test("needs attention is a button that opens the inline card, never a dialog", () => {
    const onOpen = mock(() => undefined);

    const { getByRole, queryByRole } = render(
      <HostStateChip host="Raspberry Pi 4" state="needs-attention" onOpen={onOpen} />
    );

    fireEvent.click(getByRole("button", { name: /Raspberry Pi 4 Needs attention/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(queryByRole("dialog")).toBeNull();
  });
});

describe("HostStateCard", () => {
  test("has at most one primary fix", () => {
    const { container } = render(
      <HostStateCard
        reason="host-key-unknown"
        title="Linux VM's host key isn't trusted yet"
        body="Connect once in a terminal."
        detail="ssh linux-vm"
        fix={{ label: "Open in terminal", onAction: () => undefined }}
        secondary={{ label: "Retry", onAction: () => undefined }}
      />
    );

    expect(container.querySelectorAll("[data-variant=primary]").length).toBe(1);
    expect(container.querySelector("[data-slot=code-well]")?.textContent).toBe("ssh linux-vm");
  });

  test("a changed host key can go without a fix", () => {
    const { container } = render(
      <HostStateCard
        reason="host-key-changed"
        title="Linux VM's host key changed"
        body="If you didn't rebuild it, don't connect."
        secondary={{ label: "Copy command", onAction: () => undefined }}
      />
    );

    expect(container.querySelector("[data-variant=primary]")).toBeNull();
  });

  test("shows install progress as a progressbar", () => {
    const { getByRole } = render(
      <HostStateCard
        reason="installing"
        title="Installing on Linux VM"
        body="Copying the build."
        progress={{ value: 0.57, label: "3 of 4 files" }}
      />
    );

    expect(getByRole("progressbar").getAttribute("aria-valuenow")).toBe("57");
  });
});

describe("HarnessChoice", () => {
  test("is a radio group of catalogue Harnesses, named from the catalogue", () => {
    const onValueChange = mock((_value: string) => undefined);

    const { getAllByRole } = render(
      <HarnessChoice
        aria-label="Harness"
        value="claude"
        onValueChange={onValueChange}
        harnesses={[
          { kind: "claude", caption: "Opus 5" },
          { kind: "codex", caption: "GPT-5.4" },
        ]}
      />
    );

    const radios = getAllByRole("radio");

    expect(radios.map((radio) => radio.textContent)).toEqual(["Claude CodeOpus 5", "CodexGPT-5.4"]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);

    const [, codex] = radios;

    if (codex === undefined) throw new Error("no Codex card");
    fireEvent.click(codex);
    expect(onValueChange).toHaveBeenCalledWith("codex");
  });

  test("a Harness that isn't installed shows the setup line and a docs link only", () => {
    const { container, getAllByRole, getByRole } = render(
      <HarnessChoice
        aria-label="Harness"
        value="claude"
        onValueChange={() => undefined}
        harnesses={[
          { kind: "claude", caption: "Opus 5" },
          { kind: "codex", caption: "GPT-5.4", status: "not-installed" },
        ]}
      />
    );

    const card = container.querySelector("[data-status=not-installed]");
    const codex = harnessEntry("codex");

    expect(getAllByRole("radio").length).toBe(1);
    expect(card?.textContent).toBe(`CodexSetup guide${codex?.setup.install}`);
    expect(getByRole("link", { name: "Setup guide" }).getAttribute("href")).toBe(
      codex?.setup.docsUrl ?? null
    );
    expect(card?.querySelectorAll("button").length).toBe(0);
  });

  test("a Harness that isn't ready can't be chosen", () => {
    const { getAllByRole } = render(
      <HarnessChoice
        aria-label="Harness"
        value="claude"
        onValueChange={() => undefined}
        harnesses={[
          { kind: "claude", caption: "Opus 5" },
          { kind: "codex", caption: "GPT-5.4", status: "needs-sign-in", detail: "Sign in first" },
        ]}
      />
    );

    expect(getAllByRole("radio")[1]?.hasAttribute("disabled")).toBe(true);
  });
});

describe("Needs You", () => {
  test.each([
    ["with", () => undefined, ["Approve", "Always here", "Deny"]],
    ["without", undefined, ["Approve", "Deny"]],
  ] as const)("an approval card %s an Always allow handler offers %p", (_, always, buttons) => {
    const { getAllByRole } = render(
      <NeedsYouCard
        harness="codex"
        title="Spike GPUI review screen"
        where="Mac Studio · polaris · 42m"
        approval={
          always === undefined
            ? { command: "cargo build --release" }
            : { command: "cargo build --release", onAlwaysAllow: always }
        }
      />
    );

    expect(getAllByRole("button").map((button) => button.textContent)).toEqual([...buttons]);
  });

  test("a waiting card has exactly one action", () => {
    const { getAllByRole } = render(
      <WaitingCard
        kind="failed"
        icon={null}
        title="Home automation cron"
        detail="Failed · out of memory"
        action={{ label: "Retry", onAction: () => undefined }}
      />
    );

    expect(getAllByRole("button").length).toBe(1);
  });

  test("a question numbers its answers and fills only the recommended one", () => {
    const onAnswer = mock((_picks: ReadonlyArray<ReadonlyArray<number>>) => undefined);

    const { getAllByRole, container } = render(
      <QuestionCard
        harness="claude"
        questions={[
          {
            question: "Monthly or annually?",
            answers: [{ label: "Annual", recommended: true }, { label: "Monthly" }],
          },
        ]}
        onAnswer={onAnswer}
      />
    );

    const answers = getAllByRole("button");

    expect(container.textContent).toContain("Claude Code needs an answer");
    expect(container.textContent).not.toContain("1 of");
    expect(answers[0]?.textContent).toBe("1AnnualRecommended");
    expect(answers[0]?.className).toContain("bg-primary");
    expect(answers[1]?.className).not.toContain("bg-primary");
    const [, monthly] = answers;

    if (monthly === undefined) throw new Error("no second answer");
    fireEvent.click(monthly);
    expect(onAnswer).toHaveBeenCalledWith([[1]]);
  });

  test("several questions are asked one at a time and sent together", () => {
    const onAnswer = mock((_picks: ReadonlyArray<ReadonlyArray<number>>) => undefined);

    const { getByRole, getByText, container } = render(
      <QuestionCard
        harness="claude"
        questions={[
          {
            header: "Scope",
            question: "Which history?",
            answers: [{ label: "Own" }, { label: "Host" }],
          },
          {
            header: "Tools",
            question: "Which tools?",
            multiSelect: true,
            answers: [{ label: "Search" }, { label: "Read" }, { label: "Execute" }],
          },
        ]}
        onAnswer={onAnswer}
      />
    );

    expect(container.textContent).toContain("1 of 2");
    fireEvent.click(getByText("Host"));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(container.textContent).toContain("2 of 2");
    expect(container.textContent).toContain("Which tools?");
    expect(getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);

    fireEvent.click(getByText("Execute"));
    fireEvent.click(getByText("Search"));
    fireEvent.click(getByRole("button", { name: "Back" }));
    expect(container.textContent).toContain("Which history?");
    fireEvent.click(getByText("Own"));
    fireEvent.click(getByRole("button", { name: "Send" }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith([[0], [0, 2]]);
  });
});

describe("MachineBar", () => {
  test("marks the selected machine and adds machines", () => {
    const onSelect = mock((_id: string) => undefined);
    const onAdd = mock(() => undefined);

    const { getByRole } = render(
      <MachineBar
        selected="vm"
        onSelect={onSelect}
        onAdd={onAdd}
        machines={[
          { id: "mbp", name: "MacBook Pro", detail: "3 workspaces" },
          { id: "vm", name: "Linux VM", needsYou: 1 },
        ]}
      />
    );

    expect(getByRole("button", { name: /Linux VM/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(getByRole("button", { name: /MacBook Pro/ }));
    expect(onSelect).toHaveBeenCalledWith("mbp");
    fireEvent.click(getByRole("button", { name: /Add machine/ }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe("SetupRow", () => {
  test("a locked row says why instead of offering its action", () => {
    const { container } = render(
      <SetupRow
        icon={null}
        title="Start a session"
        caption="Ready"
        action={<button type="button" />}
        locked="Needs a workspace"
      />
    );

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Needs a workspace");
  });
});
