import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { CommandRunner } from "./CommandRunner.ts";
import { TaskConflictError } from "./errors.ts";
import {
  activateWindowsTask,
  missingTaskReason,
  planWindowsTask,
  removeWindowsTask,
  taskRunning,
  type WindowsTaskFacts,
} from "./windowsService.ts";
import { readTask, taskWorkingDirectory, taskXml, taskXmlBytes } from "./windowsTask.ts";

const facts = (overrides: Partial<WindowsTaskFacts>): WindowsTaskFacts => ({
  registered: true,
  changed: { binary: false, serviceFile: false },
  running: { pid: 42, version: "0.2.0" },
  version: "0.2.0",
  ...overrides,
});

describe("planWindowsTask", () => {
  test("a second install of what already runs touches nothing", () => {
    expect(planWindowsTask(facts({}))).toEqual({ register: false, stop: null, start: false });
  });

  test("a new binary stops the running Daemon as an upgrade, then starts the task", () => {
    expect(
      planWindowsTask(facts({ changed: { binary: true, serviceFile: false }, version: "0.2.1" }))
    ).toEqual({ register: false, stop: "upgrade", start: true });
  });

  test("a Daemon of another version is replaced even when the files were already in place", () => {
    expect(planWindowsTask(facts({ version: "0.2.1" }))).toMatchObject({ stop: "upgrade" });
  });

  test("a changed task definition re-registers and restarts, since the running loop is the old one", () => {
    expect(planWindowsTask(facts({ changed: { binary: false, serviceFile: true } }))).toEqual({
      register: true,
      stop: "restart",
      start: true,
    });
  });

  test("install --restart stops and starts the Daemon though nothing changed (Restart daemon)", () => {
    expect(planWindowsTask(facts({ restart: true }))).toEqual({
      register: false,
      stop: "restart",
      start: true,
    });
  });

  test("a task removed by hand is registered again", () => {
    expect(planWindowsTask(facts({ registered: false, running: null }))).toEqual({
      register: true,
      stop: null,
      start: true,
    });
  });

  test("with no Daemon answering, the task is started without stopping anything", () => {
    expect(planWindowsTask(facts({ running: null }))).toEqual({
      register: false,
      stop: null,
      start: true,
    });
  });
});

/** A Polaris home with `bin\current\polaris.exe`, as an install leaves it. */
const installedHome = () => {
  const home = newTempDir("polaris-installed-");
  mkdirSync(join(home, "bin", "current"), { recursive: true });
  writeFileSync(join(home, "bin", "current", "polaris.exe"), "");

  return home;
};

const USER_SID = "S-1-5-21-1";

/** A target for `home` as this user (`USER_SID`), with Windows in `C:\Windows`. */
const targetFor = (home: string, task = "dev.lux.polaris.lucas") => ({
  task,
  home,
  definition: "polaris-task.xml",
  userSid: USER_SID,
  systemRoot: "C:\\Windows",
});

/**
 * `schtasks` with one task registered, which runs `home`, or with none it lets this user read
 * (`xml` null; Task Scheduler's COM then answers `hresult`). Records every call.
 */
const schtasksWith = (
  home: string,
  xml: string | null = taskXml({ userSid: USER_SID, polarisHome: home, systemRoot: "C:\\Windows" }),
  hresult = "80070002"
) => {
  const calls: Array<string> = [];

  const answer = (argv: ReadonlyArray<string>) => {
    if (argv[0] === "powershell.exe") return { code: 0, stdout: `${hresult}\r\n`, stderr: "" };

    if (argv[1] === "/Query" && xml === null)
      return { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };

    return { code: 0, stdout: argv[1] === "/Query" ? (xml ?? "") : "", stderr: "" };
  };

  const layer = Layer.succeed(
    CommandRunner,
    CommandRunner.of({
      run: (argv) =>
        Effect.sync(() => {
          calls.push(argv.join(" "));

          return answer(argv);
        }),
    })
  );

  return { calls, layer };
};

const changesTask = (call: string) => / \/(Create|Run|Delete) /.test(call);

describe("taskRunning", () => {
  const answering = (stdout: string, code = 0) =>
    Layer.succeed(
      CommandRunner,
      CommandRunner.of({ run: () => Effect.succeed({ code, stdout, stderr: "" }) })
    );

  test("reads Task Scheduler's state number, and says nothing when it gets none", async () => {
    const state = (stdout: string, code = 0) =>
      Effect.runPromise(taskRunning("t").pipe(Effect.provide(answering(stdout, code))));

    expect(await state("4\r\n")).toBe(true);
    expect(await state("3\r\n")).toBe(false);
    expect(await state("", 1)).toBeNull();
    expect(await state("Running\r\n")).toBeNull();
  });
});

describe("activateWindowsTask", () => {
  test("a task that runs another installed home is left alone, and the error says whose it is", async () => {
    const real = installedHome();
    const { calls, layer } = schtasksWith(real);
    const target = targetFor(join(tmpdir(), "redirected", ".polaris"));

    try {
      const error = await Effect.runPromise(
        activateWindowsTask(target, { binary: true, serviceFile: true }, "0.2.0", false).pipe(
          Effect.flip,
          Effect.provide(layer)
        )
      );

      expect(error).toBeInstanceOf(TaskConflictError);
      expect(error.message).toContain(`runs the Polaris home ${real}`);
      expect(error.message).toContain("--replace-task");
      expect(calls.filter(changesTask)).toEqual([]);
    } finally {
      removeTempDir(real);
    }
  });

  test("a task under the name this user may not read is a conflict, with no home to name", async () => {
    const home = join(tmpdir(), "unreadable", ".polaris");
    const { calls, layer } = schtasksWith(home, null, "80070005");

    const error = await Effect.runPromise(
      activateWindowsTask(
        targetFor(home),
        { binary: true, serviceFile: true },
        "0.2.0",
        false
      ).pipe(Effect.flip, Effect.provide(layer))
    );

    expect(error).toEqual(
      new TaskConflictError({ task: "dev.lux.polaris.lucas", home, otherHome: null })
    );
    expect(calls.filter(changesTask)).toEqual([]);
  });
});

describe("missingTaskReason", () => {
  test("only Task Scheduler's access denied means another account holds the name", async () => {
    const reason = (hresult: string) =>
      Effect.runPromise(
        missingTaskReason("t").pipe(Effect.provide(schtasksWith("/h", null, hresult).layer))
      );

    expect(await reason("80070005")).toBe("unreadable");
    expect(await reason("80070002")).toBe("absent");
    // PowerShell stalled or failed: install goes on, and schtasks /Create says if it can't.
    expect(await reason("")).toBe("absent");
  });
});

const windows = process.platform === "win32";

const PROFILE_PROBE = `
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { realProfileDirectory } from "./windowsProfile.ts";
import { windowsTaskName } from "./windowsTask.ts";
const profile = realProfileDirectory();
const name = windowsTaskName(userInfo().username, join(homedir(), ".polaris"), profile);
console.log(JSON.stringify({ profile, home: homedir(), name }));
`;

// A real task stands in for the real install's: a redirected home must neither replace nor delete it.
describe.skipIf(!windows)("a redirected home and the real install's task (Windows only)", () => {
  test("the profile from the token ignores a redirected USERPROFILE, so the name gets a hash", () => {
    const fake = newTempDir("polaris-fake-profile-");
    const probe = join(import.meta.dir, `.profile-probe-${process.pid}.ts`);
    writeFileSync(probe, PROFILE_PROBE);

    try {
      const ran = Bun.spawnSync([process.execPath, probe], {
        env: { ...process.env, USERPROFILE: fake, HOME: fake },
      });

      // SAFETY: the probe prints exactly this object as one JSON line.
      const seen = JSON.parse(ran.stdout.toString()) as {
        profile: string | null;
        home: string;
        name: string;
      };

      expect(seen.home).toBe(fake);
      expect(seen.profile?.toLowerCase()).not.toBe(fake.toLowerCase());
      expect(seen.name).toMatch(/\.[0-9a-f]{8}$/);
    } finally {
      rmSync(probe, { force: true });
      removeTempDir(fake);
    }
  });

  test("install refuses the task and uninstall keeps it; both leave it running the real home", async () => {
    const real = installedHome();
    mkdirSync(join(real, "logs"));
    const redirected = newTempDir("polaris-redirected-");
    const name = `dev.lux.polaris.eng322-test-${process.pid}`;
    const { currentUserSid } = await import("../transport/windowsPipe/win32.ts");

    const definition = (home: string) => {
      const file = join(home, "polaris-task.xml");
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      writeFileSync(
        file,
        taskXmlBytes(taskXml({ userSid: currentUserSid(), polarisHome: home, systemRoot }))
      );

      return file;
    };

    const runsHome = () =>
      taskWorkingDirectory(
        Bun.spawnSync(["schtasks", "/Query", "/TN", name, "/XML"]).stdout.toString()
      );

    const run = <A, E>(effect: Effect.Effect<A, E, CommandRunner>) =>
      Effect.runPromise(effect.pipe(Effect.provide(CommandRunner.layer)));

    try {
      const created = Bun.spawnSync([
        "schtasks",
        "/Create",
        "/F",
        "/TN",
        name,
        "/XML",
        definition(real),
      ]);

      expect(created.exitCode).toBe(0);

      const target = {
        task: name,
        home: redirected,
        definition: definition(redirected),
        userSid: currentUserSid(),
        systemRoot: process.env.SystemRoot ?? "C:\\Windows",
      };

      const refused = await run(
        activateWindowsTask(target, { binary: true, serviceFile: true }, "0.2.0", false).pipe(
          Effect.flip
        )
      );

      expect(refused).toBeInstanceOf(TaskConflictError);
      expect(runsHome()).toBe(real);
      const removed = await run(removeWindowsTask(target));
      expect(removed.keptTask).toBe(name);
      expect(runsHome()).toBe(real);
      // Had either started the task, its loop's redirect would have created this log.
      expect(existsSync(join(real, "logs", "daemon.out.log"))).toBe(false);
    } finally {
      Bun.spawnSync(["schtasks", "/End", "/TN", name]);
      Bun.spawnSync(["schtasks", "/Delete", "/F", "/TN", name]);
      removeTempDir(real);
      removeTempDir(redirected);
    }
  });
});

const SOMETHING_ELSE =
  "<Command>C:\\Windows\\System32\\cmd.exe</Command><Arguments>/c exit 0</Arguments>";

// The task runs this home and as this user, but not the action install writes: it isn't ours.
describe.skipIf(!windows)(
  "a task under this home's name that runs something else (Windows only)",
  () => {
    test("install refuses it and uninstall keeps it, both leaving its action as it was", async () => {
      const home = installedHome();
      const name = `dev.lux.polaris.eng333-test-${process.pid}`;
      const { currentUserSid } = await import("../transport/windowsPipe/win32.ts");
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const xml = taskXml({ userSid: currentUserSid(), polarisHome: home, systemRoot });
      const definition = join(home, "polaris-task.xml");
      const planted = join(home, "planted.xml");

      writeFileSync(definition, taskXmlBytes(xml));
      writeFileSync(
        planted,
        taskXmlBytes(xml.replace(/<Command>[\s\S]*<\/Arguments>/, SOMETHING_ELSE))
      );

      const command = () =>
        readTask(Bun.spawnSync(["schtasks", "/Query", "/TN", name, "/XML"]).stdout.toString())
          .action;

      const run = <A, E>(effect: Effect.Effect<A, E, CommandRunner>) =>
        Effect.runPromise(effect.pipe(Effect.provide(CommandRunner.layer)));

      const target = { task: name, home, definition, userSid: currentUserSid(), systemRoot };

      try {
        const created = Bun.spawnSync(["schtasks", "/Create", "/F", "/TN", name, "/XML", planted]);
        expect(created.exitCode).toBe(0);
        const before = command();
        expect(before?.arguments).toBe("/c exit 0");

        const refused = await run(
          activateWindowsTask(target, { binary: true, serviceFile: true }, "0.2.0", false).pipe(
            Effect.flip
          )
        );

        expect(refused).toEqual(new TaskConflictError({ task: name, home, otherHome: null }));
        expect(command()).toEqual(before);
        expect((await run(removeWindowsTask(target))).keptTask).toBe(name);
        expect(command()).toEqual(before);
      } finally {
        Bun.spawnSync(["schtasks", "/Delete", "/F", "/TN", name]);
        removeTempDir(home);
      }
    });
  }
);
