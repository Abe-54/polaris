import { describe, expect, test } from "bun:test";
import type { ConnectionStatusView, MachineView } from "../../../../shared/api.ts";
import { HostId } from "@polaris/protocol";
import { clientCopy } from "../../../../shared/clientCopy.ts";
import { hostName, listLine, pageLine, pill } from "./state.ts";

const NOW = 1_800_000_000_000;

const status = (patch: Partial<ConnectionStatusView>): ConnectionStatusView => ({
  state: "connected",
  failure: null,
  attempt: 0,
  since: NOW,
  nextAttemptAt: null,
  host: null,
  capabilities: [],
  epoch: 1,
  latencyMs: 47,
  lastSeenAt: null,
  ...patch,
});

const machine = (patch: Partial<ConnectionStatusView> = {}): MachineView => ({
  daemon: null,
  key: "studio",
  kind: "ssh",
  label: "Mac Studio",
  colour: "#8FB0E8",
  alias: "lucas-mac-studio",
  target: null,
  enabled: true,
  forwardAgent: false,
  remoteCommand: null,
  status: status(patch),
  install: null,
});

describe("the Connection State pill", () => {
  test("Retry now is hidden on a connected host", () => {
    expect(pill(machine(), NOW)).toEqual({
      state: "connected",
      label: "Connected · 47 ms",
      retry: false,
    });
  });

  test("Retry now shows while Reconnecting or Offline", () => {
    expect(pill(machine({ state: "reconnecting", since: NOW - 12_000 }), NOW)).toEqual({
      state: "reconnecting",
      label: "Reconnecting · 12s",
      retry: true,
    });
    expect(pill(machine({ state: "offline", lastSeenAt: NOW - 2 * 3_600_000 }), NOW)).toMatchObject(
      { label: "Offline · last seen 2h ago", retry: true }
    );
  });

  test("Retry now is hidden while a restart is already reconnecting the host", () => {
    expect(
      pill(machine({ state: "reconnecting", since: NOW - 4_000 }), NOW, "restarting")
    ).toMatchObject({ label: "Reconnecting · 4s", retry: false });
  });

  test("a failed restart reads Needs attention, with Retry now", () => {
    expect(pill(machine(), NOW, "failed")).toEqual({
      state: "needs-attention",
      label: "Needs attention",
      retry: true,
    });
  });
});

test("the header's line has the alias, platform, workspaces and daemon version", () => {
  const view = machine({
    host: {
      hostId: HostId.make("h"),
      hostname: "studio",
      platform: "darwin-arm64",
      daemonVersion: "0.5.0",
      homeDir: "/Users/lucas",
      startedAt: "2026-10-30T00:00:00.000Z",
    },
  });

  expect(pageLine(view, 4, "0.5.0")).toBe(
    "ssh lucas-mac-studio · macOS arm64 · 4 workspaces · daemon 0.5.0"
  );
});

describe("the local Host's row (Paper HS-D2)", () => {
  const local = (label: string): MachineView => ({
    ...machine({
      host: {
        hostId: HostId.make("l"),
        hostname: "lucas-mbp",
        platform: "darwin-arm64",
        daemonVersion: "0.5.0",
        homeDir: "/Users/lucas",
        startedAt: "2026-10-30T00:00:00.000Z",
      },
    }),
    kind: "local",
    alias: null,
    label,
  });

  // "This Mac" on macOS, "This PC" on Windows: the Client's own word for itself.
  const thisClient = clientCopy().localHost;

  test("is titled This Mac, with the name the user gave it in the mono line", () => {
    expect(hostName(local("MacBook Pro"))).toBe(thisClient);
    expect(listLine(local("MacBook Pro"))).toBe("MacBook Pro · macOS arm64");
  });

  test("never repeats This Mac in its line when the user left the default name", () => {
    expect(listLine(local(thisClient))).toBe("macOS arm64");
  });

  test("a remote host keeps its own name", () => {
    expect(hostName(machine())).toBe("Mac Studio");
  });
});
