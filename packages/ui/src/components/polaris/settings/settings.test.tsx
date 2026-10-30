import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { useState } from "react";

import {
  SettingsConfirmRow,
  SettingsHostRow,
  SettingsOverrideRow,
  SettingsRow,
  SettingsSelect,
  SettingsStepper,
} from ".";

afterEach(cleanup);

function Stepper({ start, step, min, max }: Record<"start" | "step" | "min" | "max", number>) {
  const [value, setValue] = useState(start);

  return (
    <SettingsStepper
      label="Minimum context"
      value={value}
      onChange={setValue}
      step={step}
      min={min}
      max={max}
      format={(n) => `${n / 1000}k`}
    />
  );
}

describe("SettingsStepper", () => {
  test("a press snaps an off-step value to the step, then moves by it", () => {
    render(<Stepper start={190_500} step={50_000} min={50_000} max={400_000} />);

    fireEvent.click(screen.getByRole("button", { name: "Increase Minimum context" }));
    expect(screen.getByRole("status").textContent).toBe("200k");

    fireEvent.click(screen.getByRole("button", { name: "Decrease Minimum context" }));
    expect(screen.getByRole("status").textContent).toBe("150k");
  });

  test("stops at its bounds and disables the button that would pass them", () => {
    render(<Stepper start={350_000} step={50_000} min={50_000} max={400_000} />);

    const increase = screen.getByRole("button", { name: "Increase Minimum context" });

    fireEvent.click(increase);
    expect(screen.getByRole("status").textContent).toBe("400k");
    expect(increase).toHaveProperty("disabled", true);
  });
});

describe("SettingsSelect", () => {
  const options = [
    {
      value: "default",
      label: "Branch only from the default branch",
      short: "Branch from default",
    },
    { value: "current", label: "Commit to the current branch" },
  ] as const;

  test("closed, a narrow card shows the short label; an option without one, its wording", () => {
    const { rerender } = render(
      <SettingsSelect label="Branch" value="default" options={options} onChange={() => {}} />
    );

    expect(screen.getByRole("combobox", { name: "Branch" }).textContent).toBe(
      "Branch from default"
    );

    rerender(
      <SettingsSelect label="Branch" value="current" options={options} onChange={() => {}} />
    );
    expect(screen.getByRole("combobox").textContent).toBe("Commit to the current branch");
  });

  test("unset reads the placeholder on a dashed trigger", () => {
    render(
      <SettingsSelect
        label="Account for acme"
        value={undefined}
        placeholder="Choose account"
        options={options}
        onChange={() => {}}
      />
    );

    const trigger = screen.getByRole("combobox");

    expect(trigger.textContent).toBe("Choose account");
    expect(trigger.className).toContain("border-dashed");
  });
});

describe("SettingsRow", () => {
  test.each([
    [false, "truncate"],
    [true, "line-clamp-2"],
  ])("wrap %p: a long title and caption fit by %s", (wrap, fit) => {
    render(
      <SettingsRow wrap={wrap} title="When you open an agent session in Review" caption="Rules run">
        <button>On</button>
      </SettingsRow>
    );

    for (const text of ["When you open an agent session in Review", "Rules run"])
      expect(screen.getByText(text).className.split(" ")).toContain(fit);
  });
});

describe("SettingsHostRow", () => {
  test("an offline host shows 'Not connected' in place of its control", () => {
    render(
      <SettingsHostRow
        name="Raspberry Pi 4"
        colour="#9FD0B4"
        fact="Offline · last seen 2h ago"
        offline
      >
        <button>After 7 days</button>
      </SettingsHostRow>
    );

    expect(screen.queryByRole("button", { name: "After 7 days" })).toBeNull();
    expect(screen.getByText("Not connected")).not.toBeNull();
  });
});

describe("SettingsOverrideRow", () => {
  const options = [
    { value: "7", label: "After 7 days" },
    { value: "30", label: "After 30 days" },
  ] as const;

  function Override({ onChange }: { readonly onChange: (value: string | null) => void }) {
    const [value, setValue] = useState<"7" | "30" | null>("30");

    return (
      <SettingsOverrideRow
        name="dotfiles"
        value={value}
        options={options}
        defaultLabel="After 7 days"
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    );
  }

  test("an override says so; × clears it back to following, reading 'Default · …'", () => {
    const onChange = mock((value: string | null) => value);

    render(<Override onChange={onChange} />);

    expect(screen.getByText("Overrides the host")).not.toBeNull();
    expect(screen.getByRole("combobox").textContent).toBe("After 30 days");

    fireEvent.click(screen.getByRole("button", { name: "Follow the host for dotfiles" }));

    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByText("Follows the host")).not.toBeNull();
    expect(screen.getByRole("combobox").textContent).toBe("Default · After 7 days");
    expect(screen.queryByRole("button", { name: "Follow the host for dotfiles" })).toBeNull();
  });
});

describe("SettingsConfirmRow", () => {
  const row = (onConfirm: () => void, disabledReason?: string) => (
    <SettingsConfirmRow
      title="Even G2"
      caption="Read · approve · used 3h ago"
      action="Revoke"
      consequence="Revoking disconnects it now. To use it again, pair it again."
      confirm="Revoke Even G2"
      onConfirm={onConfirm}
      {...(disabledReason === undefined ? {} : { disabledReason })}
    />
  );

  test("asks in place: the caption becomes the consequence and Cancel holds focus", () => {
    const onConfirm = mock(() => {});

    render(row(onConfirm));
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    expect(screen.getByText(/Revoking disconnects it now/)).not.toBeNull();
    expect(screen.queryByText("Read · approve · used 3h ago")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Revoke Even G2" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("esc backs out without acting, focus back on the action", () => {
    const onConfirm = mock(() => {});

    render(row(onConfirm));
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });

    expect(screen.queryByText(/Revoking disconnects it now/)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Revoke" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("a disabled action shows its reason as the caption", () => {
    render(row(() => {}, "2 agent sessions remain"));

    expect(screen.getByRole("button", { name: "Revoke" })).toHaveProperty("disabled", true);
    expect(screen.getByText("2 agent sessions remain")).not.toBeNull();
  });

  test("the action reads as danger unless the row asks for a neutral trigger; confirm stays danger", () => {
    const { rerender } = render(row(() => {}));

    expect(screen.getByRole("button", { name: "Revoke" }).dataset.variant).toBe("danger");

    rerender(
      <SettingsConfirmRow
        title="Even G2"
        action="Revoke"
        actionVariant="secondary"
        consequence="Revoking disconnects it now."
        confirm="Revoke Even G2"
        onConfirm={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Revoke" }).dataset.variant).toBe("secondary");

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(screen.getByRole("button", { name: "Revoke Even G2" }).dataset.variant).toBe("danger");
  });

  test("Cancel draws its Starlight ring on any focus, not only keyboard focus", () => {
    render(row(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    const ring = screen
      .getByRole("button", { name: "Cancel" })
      .className.split(" ")
      .filter((c) => c.startsWith("focus:outline"));

    expect(ring).toContain("focus:outline-starlight");
  });
});
