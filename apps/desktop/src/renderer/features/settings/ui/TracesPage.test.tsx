import "../../../test/dom.testing.ts";
import { WorkspaceId } from "@polaris/protocol";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { tracesSettingsTarget } from "../../traces/index.ts";
import { mountApp } from "../../traces/settings/app.testing.tsx";
import { fixtureTracesSettingsApi, SIGHTLINE_SETTINGS } from "../../traces/settings/fixtures.ts";
import { TracesPage } from "./TracesPage.tsx";

let fake: FakeBridge;

beforeEach(() => {
  fake = installFakeBridge();
  const api = fixtureTracesSettingsApi({ sightline: SIGHTLINE_SETTINGS });

  fake.answer("traces.settings", ({ hostKey, workspaceId }) => api.get(hostKey, workspaceId));
  fake.answer("traces.setSettings", ({ hostKey, workspaceId, settings }) =>
    api.set(hostKey, workspaceId, settings)
  );
  tracesSettingsTarget.setState({ hostKey: "mac", workspaceId: "sightline" }, true);
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const mount = () => mountApp(<TracesPage />, { capabilities: ["traces", "traces.settings"] });

const settle = () => act(async () => undefined);

const switchNamed = (name: string) => screen.getByRole("switch", { name });

test("a deep link opens on its workspace, with the detected collector and header names but no values", async () => {
  await mount();

  expect(fake.sent("traces.settings").map((s) => String(s.workspaceId))).toEqual(["sightline"]);
  expect(screen.getByRole("textbox", { name: "Collector URL" })).toHaveProperty(
    "value",
    "https://api.axiom.co/v1/traces"
  );
  expect(
    screen.getByText("Headers authorization · x-axiom-dataset · values stay on this host")
  ).toBeTruthy();
  expect(screen.getByText(/^Skipped: this workspace sets up OpenTelemetry itself/)).toBeTruthy();
  expect(tracesSettingsTarget.getState()).toBeNull();
});

test("each switch saves only its own field", async () => {
  await mount();

  fireEvent.click(switchNamed("Forward traces to"));
  await settle();
  fireEvent.click(switchNamed("Copy traces into Polaris"));
  await settle();

  expect(fake.sent("traces.setSettings").map((s) => s.settings)).toEqual([
    { forwarding: false },
    { enabled: false },
  ]);
  expect(switchNamed("Forward traces to").getAttribute("aria-checked")).toBe("false");
});

test("a URL carrying credentials says why and is never sent; a clean one keeps the header names", async () => {
  await mount();
  const field = screen.getByRole("textbox", { name: "Collector URL" });

  fireEvent.change(field, { target: { value: "https://me:secret@api.axiom.co/v1/traces" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await settle();

  expect(fake.sent("traces.setSettings")).toEqual([]);
  expect(screen.getByText(/no user, password, query or fragment/)).toBeTruthy();

  fireEvent.change(field, { target: { value: "https://otel.example.com/v1/traces" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await settle();

  expect(fake.sent("traces.setSettings").map((s) => s.settings)).toEqual([
    {
      forwardTo: {
        url: "https://otel.example.com/v1/traces",
        headerNames: ["authorization", "x-axiom-dataset"],
      },
    },
  ]);
});

test("a refused save puts the switch back", async () => {
  fake.refuse("traces.setSettings", {
    code: "E-TRACE-SETTINGS-UNAVAILABLE",
    message: "settings store is read-only",
    fix: "free disk space",
  });
  await mount();

  fireEvent.click(switchNamed("Forward traces to"));
  await settle();

  expect(switchNamed("Forward traces to").getAttribute("aria-checked")).toBe("true");
});

test("the Node override shows only while Node is requested", async () => {
  await mount();

  expect(switchNamed("Instrument even when the app sets up OpenTelemetry")).toBeTruthy();

  fireEvent.click(switchNamed("Instrument even when the app sets up OpenTelemetry"));
  await settle();

  expect(fake.sent("traces.setSettings").map((s) => s.settings)).toEqual([
    { autoInstrumentOverride: true },
  ]);
});

test("a daemon without traces.settings says so and reads nothing", async () => {
  await mountApp(<TracesPage />, { capabilities: ["traces"] });

  expect(fake.sent("traces.settings")).toEqual([]);
  expect(screen.getByText("Traces settings need a newer daemon on This Mac")).toBeTruthy();
});

test("removing the picked workspace falls back to one still listed, not 'No workspaces yet'", async () => {
  const { store } = await mount();
  const picker = screen.getByRole("combobox", { name: "Workspace" });

  await act(async () => {
    fireEvent.keyDown(picker, { key: "ArrowDown" });
  });
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("option", { name: /ledger/ }), { key: "Enter" });
  });

  expect(screen.getByRole("combobox", { name: "Workspace" }).textContent).toBe("ledger");

  await act(async () => {
    store.setState((s) => {
      const mac = s.hostModels.mac;

      if (mac === undefined) return s;
      const workspaces = new Map(mac.workspaces);

      workspaces.delete(WorkspaceId.make("ledger"));

      return { hostModels: { ...s.hostModels, mac: { ...mac, workspaces } } };
    });
  });

  expect(screen.queryByText("No workspaces yet")).toBeNull();
  expect(screen.getByRole("combobox", { name: "Workspace" }).textContent).toBe("sightline");
});

test("emptying the collector URL offers Remove, which clears the collector", async () => {
  await mount();
  const field = screen.getByRole("textbox", { name: "Collector URL" });

  fireEvent.change(field, { target: { value: "  " } });

  expect(screen.getByText(/^Saving removes this collector/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await settle();

  expect(fake.sent("traces.setSettings").map((s) => s.settings)).toEqual([{ forwardTo: null }]);
});

test("why a URL is refused is the field's description, so a screen reader hears it", async () => {
  await mount();
  const field = screen.getByRole("textbox", { name: "Collector URL" });

  fireEvent.change(field, { target: { value: "https://api.axiom.co/v1/traces?token=abc" } });
  const described = document.getElementById(field.getAttribute("aria-describedby") ?? "");

  expect(described?.textContent).toMatch(/no user, password, query or fragment/);
});
