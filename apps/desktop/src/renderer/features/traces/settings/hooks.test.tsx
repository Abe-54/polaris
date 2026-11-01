import "../../../test/dom.testing.ts";
import {
  WorkspaceId,
  type WorkspaceTracesSettings,
  type WorkspaceTracesSettingsUpdate,
} from "@polaris/protocol";
import { act, renderHook } from "@testing-library/react";
import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { Result } from "../../../../shared/api.ts";
import { FRESH_SETTINGS } from "./fixtures.ts";
import { TracesSettingsLayer, useWorkspaceTracesSettings } from "./hooks.tsx";

const AT = { hostKey: "mac", workspaceId: WorkspaceId.make("sightline") };

/** A Daemon that answers each save only when the test says so. */
const heldApi = () => {
  const pending: Array<(r: Result<WorkspaceTracesSettings>) => void> = [];

  return {
    pending,
    api: {
      get: async () => ({ ok: true as const, value: FRESH_SETTINGS }),
      set: (_h: string, _w: WorkspaceId, _patch: WorkspaceTracesSettingsUpdate) =>
        new Promise<Result<WorkspaceTracesSettings>>((resolve) => pending.push(resolve)),
    },
  };
};

test("a refusal that answers after a later accepted save rolls back only its own field", async () => {
  const { pending, api } = heldApi();

  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <TracesSettingsLayer api={api}>{children}</TracesSettingsLayer>
  );

  const { result } = renderHook(() => useWorkspaceTracesSettings(AT), { wrapper });

  await act(async () => undefined);
  let first: Promise<unknown> = Promise.resolve();
  let second: Promise<unknown> = Promise.resolve();

  await act(async () => {
    first = result.current.update({ enabled: false });
  });
  await act(async () => {
    second = result.current.update({ autoInstrument: "node" });
  });
  await act(async () => {
    pending[1]?.({ ok: true, value: { ...FRESH_SETTINGS, autoInstrument: "node" } });
    await second;
  });
  await act(async () => {
    pending[0]?.({ ok: false, error: { code: "E-TRACE-SETTINGS-INVALID", message: "no" } });
    await first;
  });

  const shown = result.current.settings.status === "ready" ? result.current.settings.value : null;

  expect({ enabled: shown?.enabled, autoInstrument: shown?.autoInstrument }).toEqual({
    enabled: FRESH_SETTINGS.enabled,
    autoInstrument: "node",
  });
});
