import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import type { ConnectionStatusView, MachineView, PolarisApi } from "../../../../shared/api.ts";
import type { RestartDaemonResult, RestartPreviewView } from "../../../../shared/restart.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { standInBridge } from "../../bridge.ts";
import type { WorkerCap } from "../../settings/model/resources.ts";
import { setResourcesClient } from "../../settings/resources.ts";
import { HostPage } from "./HostPage.tsx";

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const offline: ConnectionStatusView = {
  state: "offline",
  failure: null,
  attempt: 1,
  since: 0,
  nextAttemptAt: null,
  host: null,
  capabilities: [],
  epoch: 0,
  latencyMs: null,
  lastSeenAt: null,
};

const machine = (patch: Partial<MachineView> = {}): MachineView => ({
  daemon: null,
  key: "local",
  kind: "local",
  label: "This Mac",
  colour: null,
  alias: null,
  target: null,
  enabled: true,
  forwardAgent: false,
  remoteCommand: null,
  status: offline,
  install: null,
  ...patch,
});

const nothing: RestartPreviewView = {
  available: true,
  unavailableReason: null,
  interrupts: { workingSessions: [], terminals: 0, pendingApprovals: 0 },
};

const busy: RestartPreviewView = {
  ...nothing,
  interrupts: {
    workingSessions: [{ sessionId: "s1", title: "Spike GPUI review", harness: "claude", turn: 12 }],
    terminals: 0,
    pendingApprovals: 1,
  },
};

const back: RestartDaemonResult = {
  outcome: "back",
  manager: "launchd",
  command: "launchctl kickstart -k gui/501/dev.lux.polaris",
  previousStartedAt: null,
  startedAt: "2026-10-30T12:00:00.000Z",
  interruptedTurns: 2,
};

const failed: RestartDaemonResult = {
  outcome: "failed",
  stage: "start",
  message: "the daemon on This Mac didn't come back",
  manager: "launchd",
  command: "launchctl kickstart -k gui/501/dev.lux.polaris",
  output: "Could not find service",
  exitCode: 113,
  reinstall: true,
};

const mount = (
  view: MachineView,
  answers: { readonly preview: RestartPreviewView; readonly result: RestartDaemonResult }
) => {
  const calls: Array<string> = [];
  let backs = 0;
  let finish: (() => void) | null = null;

  const bridge: PolarisApi = {
    request: (method) => {
      calls.push(method);

      if (method === "machines.restartPreview")
        // SAFETY: each answer is the output type of the request it answers.
        return Promise.resolve({ ok: true, value: answers.preview } as never);

      if (method === "machines.restartDaemon")
        return new Promise((resolve) => {
          // SAFETY: as above.
          finish = () => resolve({ ok: true, value: answers.result } as never);
        });

      const refusal = { ok: false, error: { code: "Unsupported", message: "test" } };

      // SAFETY: a refusal fits every request's result.
      return Promise.resolve(refusal as never);
    },
    subscribe: () => () => undefined,
    onAppEvent: () => () => undefined,
  };

  standInBridge(bridge);
  const store = createStore<AppState>(() => initialState);

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
      <HostPage machine={view} now={Date.now()} onBack={() => (backs += 1)} />
    </AppProvider>
  );

  return {
    calls,
    backs: () => backs,
    finish: async () => {
      await act(async () => {
        finish?.();
        await Promise.resolve();
      });
    },
  };
};

const restartButton = () => screen.getByRole("button", { name: "Restart daemon…" });

const settle = () => act(async () => await Promise.resolve());

describe("Restart daemon", () => {
  test("with nothing to interrupt it restarts at once, then says the daemon is back", async () => {
    const page = mount(machine(), { preview: nothing, result: back });

    fireEvent.click(restartButton());
    await settle();

    expect(screen.queryByTestId("restart-confirm")).toBeNull();
    expect(page.calls).toContain("machines.restartDaemon");
    expect(screen.getByTestId("vitals-restarting").textContent).toContain("Restarting the daemon");

    await page.finish();
    expect(screen.getByTestId("restart-back").textContent).toContain(
      "2 sessions wait for you to continue"
    );
  });

  test("with work in flight it asks first, focuses Cancel, and esc cancels without leaving", async () => {
    const page = mount(machine(), { preview: busy, result: back });

    fireEvent.click(restartButton());
    await settle();

    const confirm = screen.getByTestId("restart-confirm");

    expect(within(confirm).getByTestId("restart-consequence").textContent).toBe(
      "1 agent session is working. Its turn stops and waits for you to continue; a constellation worker continues once on its own. 1 pending approval is withdrawn."
    );
    expect(document.activeElement?.textContent).toBe("Cancel");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("restart-confirm")).toBeNull();
    expect(page.backs()).toBe(0);
    expect(page.calls).not.toContain("machines.restartDaemon");
  });

  test("a failed restart reads Needs attention with Retry now, over the reason card", async () => {
    const page = mount(machine(), { preview: nothing, result: failed });

    fireEvent.click(restartButton());
    await settle();
    await page.finish();

    expect(screen.getByTestId("connection-pill").textContent).toBe("Needs attention");
    expect(screen.getByRole("button", { name: "Retry now" })).not.toBeNull();
    expect(screen.getByTestId("restart-failed").textContent).toContain(
      "The daemon on This Mac didn't come back"
    );
  });

  test("a remote host that isn't connected can't restart, and says when it can", () => {
    mount(machine({ key: "studio", kind: "ssh", alias: "studio", label: "Mac Studio" }), {
      preview: nothing,
      result: back,
    });

    expect(restartButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("daemon-card").textContent).toContain(
      "Restarts once Mac Studio is connected"
    );
  });
});

describe("the host page", () => {
  test("esc goes back to the host list, ahead of Settings' own esc that closes Settings", () => {
    let closed = 0;

    // Settings listens as it opens, before the host page mounts.
    const settings = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closed += 1;
    };

    window.addEventListener("keydown", settings, true);
    const page = mount(machine(), { preview: nothing, result: back });

    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", settings, true);
    expect(page.backs()).toBe(1);
    expect(closed).toBe(0);
  });

  test("before the first sample every vital reads a dash", () => {
    mount(machine(), { preview: nothing, result: back });

    expect(screen.getAllByTestId("vital-figure").map((el) => el.textContent)).toEqual([
      "—",
      "—",
      "—",
      "—",
    ]);
  });
});

describe("Capacity", () => {
  const caps = (workerCap: WorkerCap) => {
    const set: Array<number | null> = [];

    const answer = () =>
      Promise.resolve({
        ok: true,
        value: { resources: [], resourceLeases: [], waiting: [], overdueLeaseIds: [], workerCap },
      } as const);

    setResourcesClient({
      get: answer,
      declare: answer,
      remove: answer,
      release: answer,
      setCap: (_, cap) => {
        set.push(cap);

        return answer();
      },
    });

    return set;
  };

  const connected = machine({ status: { ...offline, state: "connected" } });

  test("Resources… opens the resources alone; Workers at once stays in Capacity's header", async () => {
    caps({ cap: 4, default: 4, working: 1, waiting: 0 });
    mount(connected, { preview: nothing, result: back });
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Resources…" }));
    await settle();

    expect(screen.getByTestId("host-resources").textContent).toContain("None on this host.");
    expect(screen.getAllByRole("button", { name: /more workers|increase workers/i })).toHaveLength(
      1
    );
  });

  test("a cap set by hand goes back to automatic from Capacity", async () => {
    const set = caps({ cap: 6, default: 4, working: 1, waiting: 0 });
    mount(connected, { preview: nothing, result: back });
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Automatic (4)" }));
    await settle();

    expect(set).toEqual([null]);
  });
});
