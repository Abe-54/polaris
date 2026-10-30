import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as P from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import type { HostView, Plain } from "../../../../shared/api.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { harnessGroups, type ProbedHost } from "../model/harnesses.ts";
import { ReadinessCard } from "./HarnessesPage.tsx";

let fake: FakeBridge;

beforeEach(() => {
  fake = installFakeBridge();
  fake.refuse("terminal.open", { code: "TerminalError", message: "no terminal in tests" });
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const connected = (key: string, label: string): HostView => {
  const base = hostView(key);

  return {
    ...base,
    label,
    status: {
      ...base.status,
      host: new P.HostInfo({
        hostId: P.HostId.make(`host-${key}`),
        hostname: key,
        platform: "linux-x64",
        daemonVersion: "fixture",
        homeDir: `/home/${key}`,
        startedAt: "2026-10-30T00:00:00Z",
      }),
    },
  };
};

const availability = (
  harness: string,
  status: P.HarnessAvailability["status"],
  login: string
): Plain<P.HarnessAvailability> => ({
  harness,
  status,
  version: "2.1.312",
  minVersion: "2.1.0",
  signInKind: null,
  olderThanTested: null,
  detail: null,
  signInArgv: [`/opt/${harness}`, login],
});

const reported = (
  hostKey: string,
  label: string,
  harnesses: ReadonlyArray<Plain<P.HarnessAvailability>>
): ProbedHost => ({
  hostKey,
  label,
  probe: { kind: "reported", report: { harnesses, checkedAt: "2026-10-30T00:00:00Z" } },
});

// Claude Code needs sign-in on the VM, Codex on the Pi; everything on the Mac is ready.
const HOSTS = [
  reported("mac", "This Mac", [
    availability("claude", "ready", "login"),
    availability("codex", "ready", "login"),
  ]),
  reported("vm", "Linux VM", [
    availability("claude", "needs-sign-in", "auth-vm"),
    availability("codex", "ready", "login"),
  ]),
  reported("pi", "Raspberry Pi 4", [
    availability("claude", "ready", "login"),
    availability("codex", "needs-sign-in", "auth-pi"),
  ]),
];

const mount = async () => {
  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [
      connected("mac", "This Mac"),
      connected("vm", "Linux VM"),
      connected("pi", "Raspberry Pi 4"),
    ],
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  render(
    <AppProvider
      value={{
        connection,
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TooltipProvider>
        <ReadinessCard
          groups={harnessGroups(HOSTS)}
          hosts={HOSTS}
          colours={{}}
          refresh={() => undefined}
        />
      </TooltipProvider>
    </AppProvider>
  );

  await act(async () => undefined);
};

const click = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name }));
  await act(async () => undefined);
};

test("every cell that needs sign-in has its own button, running that harness's command on that host", async () => {
  await mount();

  expect(screen.getAllByRole("button", { name: /^Sign in/ }).map((b) => b.textContent)).toEqual([
    "Sign in",
    "Sign in",
  ]);

  await click("Sign in to Codex on Raspberry Pi 4");
  await click("Sign in to Claude Code on Linux VM");

  expect(
    fake.sent("terminal.open").map(({ hostKey, cwd, argv }) => ({ hostKey, cwd, argv }))
  ).toEqual([
    { hostKey: "pi", cwd: "/home/pi", argv: ["/opt/codex", "auth-pi"] },
    { hostKey: "vm", cwd: "/home/vm", argv: ["/opt/claude", "auth-vm"] },
  ]);
  expect(
    screen.getAllByLabelText("Sign in to Claude Code on Linux VM").map((e) => e.tagName)
  ).toContain("DIV");
});
