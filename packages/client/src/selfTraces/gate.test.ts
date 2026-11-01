import { describe, expect, test } from "bun:test";
import { DeveloperMode, WorkspaceId } from "@polaris/protocol";
import { selfTraceGate } from "./gate.ts";

const mode = (effective: boolean, workspace: string | null) =>
  DeveloperMode.make({
    leases: 0,
    fromSource: false,
    stored: effective,
    effective,
    polarisWorkspaceId: workspace === null ? null : WorkspaceId.make(workspace),
    polarisWorkspaceSource: workspace === null ? null : "remote",
  });

describe("selfTraceGate", () => {
  test("follows the Host that holds the Polaris Workspace, not the local one", () => {
    const modes = new Map([
      ["local", mode(true, null)],
      ["studio", mode(false, "ws-polaris")],
    ]);

    expect(selfTraceGate(modes, "local")).toEqual({ hostKey: "studio", enabled: false });
  });

  test("falls back to the local Daemon when no Host knows the Polaris Workspace", () => {
    expect(selfTraceGate(new Map([["local", mode(true, null)]]), "local")).toEqual({
      hostKey: "local",
      enabled: true,
    });
    expect(selfTraceGate(new Map(), "local")).toEqual({ hostKey: "local", enabled: false });
  });

  test("prefers the local Host when several hold a Polaris Workspace", () => {
    const modes = new Map([
      ["alpha", mode(false, "ws-a")],
      ["local", mode(true, "ws-b")],
    ]);

    expect(selfTraceGate(modes, "local")).toEqual({ hostKey: "local", enabled: true });
  });
});
