import { describe, expect, test } from "bun:test";
import { WslDiscovery, WslDistro } from "@polaris/client/wsl";
import { unsupportedReason, wslDistrosView } from "./wsl.ts";

const ubuntu = new WslDistro({ name: "Ubuntu", version: 2, state: "running", isDefault: true });

const legacy = new WslDistro({ name: "Legacy", version: 1, state: "stopped", isDefault: false });

describe("wslDistrosView", () => {
  test("lists distros, marking WSL 1 ones unsupported with the fix", () => {
    expect(wslDistrosView(WslDiscovery.Distros({ distros: [ubuntu, legacy] }))).toEqual({
      status: "distros",
      detail: null,
      distros: [
        { name: "Ubuntu", version: 2, state: "running", isDefault: true, unsupported: null },
        {
          name: "Legacy",
          version: 1,
          state: "stopped",
          isDefault: false,
          unsupported: "WSL 1: convert it with wsl --set-version first",
        },
      ],
    });
    expect(unsupportedReason(ubuntu)).toBeNull();
  });

  test("the empty states carry wsl.exe's own line where there is one", () => {
    expect(wslDistrosView(WslDiscovery.NoDistros())).toEqual({
      status: "no-distros",
      distros: [],
      detail: null,
    });
    expect(wslDistrosView(WslDiscovery.NotInstalled({ detail: "wsl.exe: ENOENT" }))).toEqual({
      status: "not-installed",
      distros: [],
      detail: "wsl.exe: ENOENT",
    });
    expect(wslDistrosView(WslDiscovery.Unsupported()).status).toBe("unsupported");
    expect(wslDistrosView(WslDiscovery.Failed({ detail: "boom" })).detail).toBe("boom");
  });
});
