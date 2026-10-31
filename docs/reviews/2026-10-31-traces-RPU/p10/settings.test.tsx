/** @jsxImportSource ../../../../apps/desktop/node_modules/react */
/** P10 repros (ENG-657): Settings → Traces' page and its save hook. Expected to FAIL on 99ca0343d. */
import "../../../../apps/desktop/src/renderer/test/dom.testing.ts";
import type {
  WorkspaceId,
  WorkspaceTracesSettings,
  WorkspaceTracesSettingsUpdate,
} from "../../../../packages/protocol/src/index.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, renderHook, screen } from "./deps.ts";
import { mountP10 } from "./harness.tsx";
import type { Result } from "../../../../apps/desktop/src/shared/api.ts";
import {
  type FakeBridge,
  installFakeBridge,
} from "../../../../apps/desktop/src/renderer/test/bridge.testing.ts";
import { standInBridge } from "../../../../apps/desktop/src/renderer/features/bridge.ts";
import {
  fixtureTracesSettingsApi,
  FRESH_SETTINGS,
  SIGHTLINE_SETTINGS,
} from "../../../../apps/desktop/src/renderer/features/traces/settings/fixtures.ts";
import { tracesSettingsTarget } from "../../../../apps/desktop/src/renderer/features/traces/settings/focus.ts";
import {
  TracesSettingsLayer,
  useWorkspaceTracesSettings,
} from "../../../../apps/desktop/src/renderer/features/traces/settings/hooks.tsx";
import { TracesPage } from "../../../../apps/desktop/src/renderer/features/settings/ui/TracesPage.tsx";

let fake: FakeBridge;

beforeEach(() => {
  fake = installFakeBridge();
  const api = fixtureTracesSettingsApi({ sightline: SIGHTLINE_SETTINGS });

  fake.answer("traces.settings", ({ hostKey, workspaceId }) => api.get(hostKey, workspaceId));
  fake.answer("traces.setSettings", ({ hostKey, workspaceId, settings }) =>
    api.set(hostKey, workspaceId, settings)
  );
  tracesSettingsTarget.setState(null, true);
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const CAPS = ["traces", "traces.settings"] as const;

test("finding P10-5: a refused save that answers after a later accepted one leaves the later value shown", async () => {
  const pending: Array<(r: Result<WorkspaceTracesSettings>) => void> = [];
  const daemon: { value: WorkspaceTracesSettings } = { value: FRESH_SETTINGS };

  const api = {
    get: async () => ({ ok: true as const, value: daemon.value }),
    set: (_h: string, _w: WorkspaceId, _patch: WorkspaceTracesSettingsUpdate) =>
      new Promise<Result<WorkspaceTracesSettings>>((resolve) => pending.push(resolve)),
  };

  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <TracesSettingsLayer api={api}>{children}</TracesSettingsLayer>
  );

  // SAFETY: a test Workspace id; the fake api ignores it.
  const at = { hostKey: "mac", workspaceId: "sightline" as WorkspaceId };
  const { result } = renderHook(() => useWorkspaceTracesSettings(at), { wrapper });

  await act(async () => undefined);

  let first: Promise<unknown> = Promise.resolve();
  let second: Promise<unknown> = Promise.resolve();

  await act(async () => {
    first = result.current.update({ enabled: false });
  });
  await act(async () => {
    second = result.current.update({ autoInstrument: "node" });
  });

  // The Daemon refuses the first and applies the second, answering the second first.
  daemon.value = { ...FRESH_SETTINGS, autoInstrument: "node" };
  await act(async () => {
    pending[1]?.({ ok: true, value: daemon.value });
    await second;
  });
  await act(async () => {
    pending[0]?.({ ok: false, error: { code: "E-TRACE-SETTINGS-INVALID", message: "no" } });
    await first;
  });

  const shown = result.current.settings.status === "ready" ? result.current.settings.value : null;

  expect({ enabled: shown?.enabled, autoInstrument: shown?.autoInstrument }).toEqual({
    enabled: true,
    autoInstrument: "node",
  });
});

test("finding P10-6: removing the picked workspace falls back to another, not 'No workspaces yet'", async () => {
  tracesSettingsTarget.setState({ hostKey: "mac", workspaceId: "sightline" }, true);
  const { store } = await mountP10(<TracesPage />, { capabilities: CAPS });

  const picker = screen.getByRole("combobox", { name: "Workspace" });

  await act(async () => {
    fireEvent.keyDown(picker, { key: "ArrowDown" });
  });
  const ledger = screen.getByRole("option", { name: /ledger/ });

  await act(async () => {
    fireEvent.keyDown(ledger, { key: "Enter" });
  });

  expect(screen.getByRole("combobox", { name: "Workspace" }).textContent).toBe("ledger");

  await act(async () => {
    store.setState((s) => {
      const mac = s.hostModels.mac;

      if (mac === undefined) return s;
      const workspaces = new Map(mac.workspaces);

      workspaces.delete("ledger");

      return { hostModels: { ...s.hostModels, mac: { ...mac, workspaces } } };
    });
  });

  // sightline is still listed, so the page should show it rather than claim there are none.
  expect(screen.queryAllByText("No workspaces yet").map((e) => e.textContent)).toEqual([]);
});

test("finding P10-7: the collector to forward to can be removed once set", async () => {
  tracesSettingsTarget.setState({ hostKey: "mac", workspaceId: "sightline" }, true);
  await mountP10(<TracesPage />, { capabilities: CAPS });

  const field = screen.getByRole("textbox", { name: "Collector URL" });

  fireEvent.change(field, { target: { value: "" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await act(async () => undefined);

  const cleared = fake.sent("traces.setSettings").some((s) => s.settings.forwardTo === null);
  const removable = screen.queryAllByRole("button", { name: /remove|clear/i }).length > 0;

  expect(cleared || removable).toBe(true);
});
