import { expect, test } from "bun:test";
import { DeveloperMode } from "@polaris/protocol";
import type { AppEvent, PolarisApi } from "../../../shared/api.ts";
import { connectHostDeveloperModes, hostDeveloperModesStore } from "./hostDeveloperModes.ts";

const mode = (stored: boolean) =>
  DeveloperMode.make({
    stored,
    leases: 0,
    fromSource: false,
    effective: stored,
    polarisWorkspaceId: null,
    polarisWorkspaceSource: null,
  });

test("the store starts from main's values and follows each Host's change and disconnect", async () => {
  let send: (event: AppEvent) => void = () => undefined;

  connectHostDeveloperModes({
    // SAFETY: the store sends only developerMode.hosts, which answers a record by Host key.
    request: () => Promise.resolve({ ok: true, value: { studio: mode(false) } }) as never,
    subscribe: () => () => undefined,
    onAppEvent: (listener) => {
      send = listener;

      return () => undefined;
    },
  } satisfies PolarisApi);

  await Promise.resolve();
  expect(Object.keys(hostDeveloperModesStore.getState())).toEqual(["studio"]);

  send({ kind: "developer-mode", hostKey: "pi", mode: mode(true) });
  send({ kind: "developer-mode", hostKey: "studio", mode: null });

  expect(hostDeveloperModesStore.getState()).toEqual({ pi: mode(true) });
});
