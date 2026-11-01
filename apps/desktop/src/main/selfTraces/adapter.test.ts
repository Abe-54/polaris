import { describe, expect, test } from "bun:test";
import { DeveloperMode, WorkspaceId } from "@polaris/protocol";
import { developerModeSource } from "./adapter.ts";

const mode = (effective: boolean, workspace: string | null) =>
  DeveloperMode.make({
    leases: 0,
    fromSource: false,
    stored: effective,
    effective,
    polarisWorkspaceId: workspace === null ? null : WorkspaceId.make(workspace),
    polarisWorkspaceSource: workspace === null ? null : "remote",
  });

describe("developerModeSource", () => {
  test("follows the Host that holds the Polaris Workspace as per-Host modes change", () => {
    const modes = new Map([["local", mode(false, null)]]);
    let changed: () => void = () => undefined;

    const source = developerModeSource("local", {
      all: () => modes,
      onChange: (listener) => {
        changed = listener;

        return () => undefined;
      },
    });

    const heard: Array<unknown> = [];

    source.subscribe((gate) => heard.push(gate));
    modes.set("studio", mode(true, "ws-polaris"));
    changed();

    expect(heard).toEqual([{ hostKey: "studio", enabled: true }]);
    expect(source.current()).toEqual({ hostKey: "studio", enabled: true });
  });

  test("with no per-Host state wired, Self-Traces stay off", () => {
    expect(developerModeSource("local").current()).toEqual({ hostKey: "local", enabled: false });
  });
});
