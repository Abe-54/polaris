import { describe, expect, test } from "bun:test";
import { BRIDGE_EXIT_NO_DAEMON } from "@polaris/protocol";
import {
  classifyWslExit,
  wslBridgeArgv,
  wslExecArgv,
  wslShellArgv,
  wslWindowsPath,
} from "./command.ts";
import { FAKE_WSL_MESSAGES } from "./fakeWsl.testing.ts";

describe("wsl.exe argv", () => {
  test("the bridge runs the installed Daemon through sh, so ~ expands in the distro", () => {
    expect(wslBridgeArgv("Ubuntu")).toEqual([
      "wsl.exe",
      "--distribution",
      "Ubuntu",
      "--exec",
      "/bin/sh",
      "-c",
      "exec ~/.polaris/bin/current/polaris bridge",
    ]);
  });

  test("a remote command override and a fake binary are honoured", () => {
    expect(
      wslBridgeArgv("Debian", {
        wslBinary: "/tmp/wsl.exe",
        remoteCommand: ["bun", "x.ts", "bridge"],
      })
    ).toEqual([
      "/tmp/wsl.exe",
      "--distribution",
      "Debian",
      "--exec",
      "/bin/sh",
      "-c",
      "exec bun x.ts bridge",
    ]);
  });

  test("install commands run as given", () => {
    expect(wslExecArgv("Ubuntu", ["/bin/sh", "-c", "uname -s"])).toEqual([
      "wsl.exe",
      "--distribution",
      "Ubuntu",
      "--exec",
      "/bin/sh",
      "-c",
      "uname -s",
    ]);
    expect(wslShellArgv("Ubuntu")).toEqual(["wsl.exe", "--distribution", "Ubuntu"]);
  });

  test("a Linux path inside the distro is shown as a \\\\wsl.localhost path", () => {
    expect(wslWindowsPath("Ubuntu", "/home/lucas/code/polaris")).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\lucas\\code\\polaris"
    );
  });
});

describe("classifyWslExit", () => {
  const exit = (code: number | null, stderr: string) =>
    classifyWslExit({ code, signal: null, stderr });

  test("a missing distro and a missing WSL need the user", () => {
    const missing = exit(
      255,
      "There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n"
    );

    expect(missing.kind).toBe("needs-attention");
    expect(missing.reason).toBe("wsl-distro-missing");
    expect(missing.detail).toBe("There is no distribution with the supplied name.");

    const stub = exit(
      1,
      "Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'."
    );

    expect(stub.reason).toBe("wsl-missing");
  });

  const WSL_NOT_FOUND =
    "There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n";

  test.each([
    [
      "wsl.exe's own message arrives on stdout with exit 255",
      255,
      WSL_NOT_FOUND,
      "There is no distribution with the supplied name.",
    ],
    [
      "wsl.exe's own message arrives on stdout with exit -1, as real WSL 2.7 writes it",
      4294967295,
      WSL_NOT_FOUND,
      "There is no distribution with the supplied name.",
    ],
    [
      "a localized missing distro classifies by WSL's error code",
      255,
      FAKE_WSL_MESSAGES.de.notFound,
      "Es ist keine Distribution mit dem angegebenen Namen vorhanden.",
    ],
  ])("%s", (_, code, stdout, detail) => {
    const missing = classifyWslExit({ code, signal: null, stderr: "", stdout });

    expect(missing.reason).toBe("wsl-distro-missing");
    expect(missing.detail).toBe(detail);
  });

  test("a Linux command's stdout is not mistaken for wsl.exe's message", () => {
    const own = classifyWslExit({
      code: 3,
      signal: null,
      stderr: "",
      stdout: "systemctl is not installed",
    });

    expect(own.reason).toBe("connection-lost");
  });

  test("NUL-interleaved stderr (UTF-16LE read as UTF-8) still classifies", () => {
    const text = "There is no distribution with the supplied name.";

    const mangled = text
      .split("")
      .map((c) => `${c}\u0000`)
      .join("");

    expect(exit(255, mangled).reason).toBe("wsl-distro-missing");
  });

  test("what the bridge or sh said goes through the ssh classifier", () => {
    expect(
      exit(BRIDGE_EXIT_NO_DAEMON, "polaris bridge: no Daemon is running on this Host").reason
    ).toBe("daemon-not-running");
    expect(exit(127, "/bin/sh: 1: /home/u/.polaris/bin/current/polaris: not found").reason).toBe(
      "polaris-not-installed"
    );
    expect(exit(1, "").kind).toBe("transient");
  });
});
