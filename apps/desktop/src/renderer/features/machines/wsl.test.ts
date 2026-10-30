import { describe, expect, test } from "bun:test";
import type { WslDistroView } from "../../../shared/api.ts";
import { clientCopy } from "../../../shared/clientCopy.ts";
import { setClientPlatform } from "../../../shared/platform.ts";
import { addHint, distroCaption, hostsIntro, hostWhere, wslFooter, wslSection } from "./wsl.ts";

const distro = (patch: Partial<WslDistroView> = {}): WslDistroView => ({
  name: "Ubuntu",
  version: 2,
  state: "running",
  isDefault: true,
  unsupported: null,
  ...patch,
});

describe("the WSL section of Add a host", () => {
  test("hidden off Windows, loading before the answer, the distros on it", () => {
    expect(wslSection(null)).toEqual({ kind: "loading" });
    expect(wslSection({ status: "unsupported", distros: [], detail: null })).toEqual({
      kind: "hidden",
    });
    expect(wslSection({ status: "distros", distros: [distro()], detail: null })).toEqual({
      kind: "distros",
      distros: [distro()],
    });
  });

  test("not installed, no distros and a failed listing each say what to do", () => {
    const missing = wslSection({ status: "not-installed", distros: [], detail: "x" });
    expect(missing).toMatchObject({ kind: "empty", command: "wsl --install" });
    expect(wslSection({ status: "no-distros", distros: [], detail: null })).toMatchObject({
      kind: "empty",
      command: "wsl --install -d Ubuntu",
    });
    expect(wslSection({ status: "failed", distros: [], detail: "exit 1" })).toMatchObject({
      kind: "empty",
      body: "WSL didn't answer when Polaris listed its distros: exit 1",
      command: null,
    });
  });

  test("a distro's caption: version, state, default; or why it can't be picked", () => {
    expect(distroCaption(distro())).toBe("WSL 2 · running · default");
    expect(distroCaption(distro({ state: "stopped", isDefault: false }))).toBe("WSL 2 · stopped");
    expect(distroCaption(distro({ state: "unknown", isDefault: false }))).toBe("WSL 2");
    expect(
      distroCaption(
        distro({ version: 1, unsupported: "WSL 1: convert it with wsl --set-version first" })
      )
    ).toBe("WSL 1: convert it with wsl --set-version first");
  });

  test("copy: where a Host is, the footer, the intro", () => {
    expect(hostWhere({ kind: "wsl", alias: "Ubuntu" })).toBe("wsl Ubuntu");
    expect(hostWhere({ kind: "ssh", alias: "pi" })).toBe("ssh pi");
    expect(hostWhere({ kind: "local", alias: null })).toBe(clientCopy().localHost);
    expect(wslFooter("Ubuntu")).toContain("\\\\wsl.localhost\\Ubuntu");
    expect(hostsIntro(false, clientCopy("darwin"))).toBe(
      "The machines your agents run on. Each runs its own daemon; this Mac reaches the others over SSH."
    );
    expect(hostsIntro(true, clientCopy("win32"))).toContain(
      "this PC reaches the others over SSH or WSL"
    );
    expect(addHint(false)).toBe(
      "Pick an alias from ~/.ssh/config; the first install asks for your approval."
    );
  });

  test("a PC without WSL, or a Linux Client, never reads as a Mac", () => {
    expect(hostsIntro(false, clientCopy("win32"))).toContain(
      "this PC reaches the others over SSH."
    );
    expect(hostsIntro(false, clientCopy("linux"))).toContain("this computer reaches");
    setClientPlatform("linux");

    try {
      expect(hostWhere({ kind: "local", alias: null })).toBe("This computer");
    } finally {
      setClientPlatform(null);
    }
  });
});
