import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  discoverDistros,
  discoveryOf,
  parseDistroList,
  WslDiscovery,
  WslDistro,
} from "./distros.ts";
import { FAKE_WSL_MESSAGES, writeFakeWsl } from "./fakeWsl.testing.ts";
import { scriptedChildProcess, type SpawnRequest } from "../process/index.ts";

const LIST = [
  "  NAME                   STATE           VERSION",
  "* Ubuntu                 Running         2",
  "  Debian                 Stopped         2",
  "  Legacy                 Stopped         1",
  "  docker-desktop         Running         2",
  "",
].join("\r\n");

describe("parseDistroList", () => {
  test.each([
    [
      "reads names, states, versions and the default",
      LIST,
      [
        new WslDistro({ name: "Ubuntu", version: 2, state: "running", isDefault: true }),
        new WslDistro({ name: "Debian", version: 2, state: "stopped", isDefault: false }),
        new WslDistro({ name: "Legacy", version: 1, state: "stopped", isDefault: false }),
        new WslDistro({ name: "docker-desktop", version: 2, state: "running", isDefault: false }),
      ],
    ],
    [
      "a localized header and state still yield the name and version",
      "  NAME       ZUSTAND         VERSION\r\n* Ubuntu     Wird ausgeführt  2\r\n  Alt   Angehalten   1\r\n",
      [
        new WslDistro({ name: "Ubuntu", version: 2, state: "running", isDefault: true }),
        new WslDistro({ name: "Alt", version: 1, state: "unknown", isDefault: false }),
      ],
    ],
    [
      "a BOM, LF endings and a name with a space are fine",
      "﻿  NAME  STATE  VERSION\n  My Distro  Stopped  2\n",
      [new WslDistro({ name: "My Distro", version: 2, state: "stopped", isDefault: false })],
    ],
    ["lines that aren't rows are skipped", "  NAME  STATE  VERSION\n  garbage\n", []],
  ])("%s", (_, text, distros) => {
    expect(parseDistroList(text)).toEqual(distros);
  });
});

describe("discoveryOf", () => {
  const utf16 = (text: string) => new Uint8Array(Buffer.from(text, "utf16le"));
  const none = new Uint8Array(0);

  test("a missing wsl.exe is NotInstalled", () => {
    const error: NodeJS.ErrnoException = Object.assign(new Error("spawn"), { code: "ENOENT" });
    expect(discoveryOf({ code: null, stdout: none, stderr: none, spawnError: error })).toEqual(
      WslDiscovery.NotInstalled({ detail: "wsl.exe: ENOENT" })
    );
  });

  test.each([
    [
      "the stub's message is NotInstalled",
      {
        code: 1,
        stdout: none,
        stderr: utf16(
          "Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.\r\n"
        ),
      },
    ],
    [
      "WSL's error code reads as NotInstalled in any language",
      {
        code: 255,
        stdout: utf16(
          "Diese Anwendung erfordert die Windows-Subsystem für Linux optionale Komponente.\r\nFehlercode: Wsl/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED\r\n"
        ),
        stderr: none,
      },
    ],
  ])("%s", (_, output) => {
    expect(discoveryOf({ ...output, spawnError: null })._tag).toBe("NotInstalled");
  });

  test.each(["en", "de"] as const)(
    "no distros (%s) is NoDistros by the empty --list --quiet, not by its words",
    (language) => {
      const verbose = {
        code: 255,
        stdout: utf16(FAKE_WSL_MESSAGES[language].noDistros),
        stderr: none,
        spawnError: null,
      };

      const quiet = { code: 0, stdout: none, stderr: none, spawnError: null };

      expect(discoveryOf(verbose, quiet)).toEqual(WslDiscovery.NoDistros());
    }
  );

  test("a failed --list --verbose whose --list --quiet still names distros is Failed", () => {
    const verbose = { code: 255, stdout: utf16("Zugriff verweigert\r\n"), stderr: none };
    const quiet = { code: 0, stdout: utf16("Ubuntu\r\n"), stderr: none, spawnError: null };

    expect(discoveryOf({ ...verbose, spawnError: null }, quiet)).toEqual(
      WslDiscovery.Failed({ detail: "Zugriff verweigert" })
    );
  });

  test("Docker Desktop's helper distros are hidden; only those alone count as none", () => {
    const only = utf16("  NAME  STATE  VERSION\r\n  docker-desktop  Running  2\r\n");
    expect(discoveryOf({ code: 0, stdout: only, stderr: none, spawnError: null })._tag).toBe(
      "NoDistros"
    );
    const found = discoveryOf({ code: 0, stdout: utf16(LIST), stderr: none, spawnError: null });
    expect(found).toEqual(
      WslDiscovery.Distros({
        distros: parseDistroList(LIST).filter((d) => d.name !== "docker-desktop"),
      })
    );
  });

  test("any other failure is Failed with the message", () => {
    const result = discoveryOf({ code: 2, stdout: none, stderr: utf16("boom"), spawnError: null });
    expect(result).toEqual(WslDiscovery.Failed({ detail: "boom" }));
  });
});

describe("discoverDistros", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polaris-wsl-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const distros = [
    { name: "Ubuntu", version: 2 as const, state: "Running" as const, isDefault: true, home: "" },
    { name: "Old", version: 1 as const, state: "Stopped" as const, home: "" },
  ].map((d) => ({ ...d, home: join(dir ?? tmpdir(), d.name) }));

  test("off Windows the answer is Unsupported without spawning", async () => {
    expect(
      await Effect.runPromise(discoverDistros({ platform: "darwin", wslBinary: "/nope" }))
    ).toEqual(WslDiscovery.Unsupported());
  });

  test.each([true, false])(
    "lists the fake's distros (WSL_UTF8 honoured: %p)",
    async (honoursUtf8) => {
      const fake = writeFakeWsl(dir, {
        distros: distros.map((d) => ({ ...d, home: join(dir, d.name) })),
        honoursUtf8,
      });

      const found = await Effect.runPromise(discoverDistros({ ...fake, platform: "win32" }));
      expect(found).toEqual(
        WslDiscovery.Distros({
          distros: [
            new WslDistro({ name: "Ubuntu", version: 2, state: "running", isDefault: true }),
            new WslDistro({ name: "Old", version: 1, state: "stopped", isDefault: false }),
          ],
        })
      );
    }
  );

  test("a stub wsl.exe and a missing binary are NotInstalled", async () => {
    const fake = writeFakeWsl(dir, { distros: [], installed: false });
    expect((await Effect.runPromise(discoverDistros({ ...fake, platform: "win32" })))._tag).toBe(
      "NotInstalled"
    );

    const missing = await Effect.runPromise(
      discoverDistros({ wslBinary: join(dir, "absent.exe"), env: fake.env, platform: "win32" })
    );

    expect(missing._tag).toBe("NotInstalled");
  });

  test.each(["en", "de"] as const)("a WSL with no distro (%s) is NoDistros", async (language) => {
    const fake = writeFakeWsl(dir, { distros: [], language });

    expect(await Effect.runPromise(discoverDistros({ ...fake, platform: "win32" }))).toEqual(
      WslDiscovery.NoDistros()
    );
  });

  test("Windows' wsl.exe waiting on its install prompt is NotInstalled once it times out", async () => {
    const fake = writeFakeWsl(dir, { distros: [], installed: false, prompts: true });

    const found = await Effect.runPromise(
      discoverDistros({ ...fake, platform: "win32", timeoutMs: 1_000 })
    );

    expect(found._tag).toBe("NotInstalled");
  });
});

describe("discoverDistros asks the registry for WSL's service first", () => {
  const LISTED = Buffer.from("  NAME  STATE  VERSION\r\n* Ubuntu  Running  2\r\n", "utf16le");

  const discover = (reg: (key: string) => { code?: number; spawnError?: string }) => {
    const spawned: Array<SpawnRequest> = [];

    const processes = scriptedChildProcess((request) => {
      spawned.push(request);

      if (request.file !== "reg.exe") return { exit: { code: 0, stdout: new Uint8Array(LISTED) } };
      const answer = reg(request.args[1] ?? "");

      return answer.spawnError === undefined
        ? { exit: { code: answer.code ?? 0 } }
        : { spawnError: answer.spawnError };
    });

    return Effect.runPromise(discoverDistros({ platform: "win32", processes })).then((found) => ({
      found,
      ranWsl: spawned.some((request) => request.file === "wsl.exe"),
    }));
  };

  test("no WSLService or LxssManager is NotInstalled, without running wsl.exe", async () => {
    const { found, ranWsl } = await discover(() => ({ code: 1 }));

    expect(found._tag).toBe("NotInstalled");
    expect(ranWsl).toBe(false);
  });

  test.each([
    ["WSLService", (key: string) => ({ code: key.endsWith("WSLService") ? 0 : 1 })],
    ["LxssManager", (key: string) => ({ code: key.endsWith("LxssManager") ? 0 : 1 })],
    ["no reg.exe", () => ({ spawnError: "ENOENT" })],
  ])("%s lets wsl.exe answer", async (_, reg) => {
    const { found } = await discover(reg);

    expect(found).toEqual(
      WslDiscovery.Distros({
        distros: [new WslDistro({ name: "Ubuntu", version: 2, state: "running", isDefault: true })],
      })
    );
  });
});
