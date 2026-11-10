import { expect, test } from "bun:test";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AppId,
  type ComputerUseItem,
  ComputerUseSetup,
  ComputerUseState,
  type ComputerUseStatus,
  ControlledApp,
  DesktopApp,
  SessionId,
} from "@polaris/protocol";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { ComputerUseHelper } from "../service/computerUse/index.ts";
import { ComputerUseHost } from "./host.ts";
import {
  a11yInstalled,
  busctl,
  type FakeHost,
  fakeHost,
  linuxDesktop,
  macStatus,
} from "./host.testing.ts";
import { makeHelper, toolOf } from "../service/computerUse/helper.testing.ts";
import { newTempDir } from "../platform/tempDir.testing.ts";
import type { HostProbe } from "./probe.ts";

const run = <A, E>(
  host: { probe: HostProbe; file: string; helper?: string | null },
  body: (service: typeof ComputerUseHost.Service) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const layer = ComputerUseHost.layerWith({
          probe: host.probe,
          file: host.file,
          follow: { every: 10, times: 100 },
        });

        const helper =
          host.helper === undefined
            ? layer
            : layer.pipe(Layer.provide(ComputerUseHelper.layerAt(() => host.helper ?? null)));

        const context = yield* Layer.build(helper);

        return yield* Effect.provide(
          Effect.flatMap(Effect.service(ComputerUseHost), body),
          context
        );
      })
    )
  );

const tag = (status: ComputerUseStatus) => status.state._tag;

test("a Host with no desktop says so whether computer use is on or off", async () => {
  const host = fakeHost();
  const file = join(host.root, "computer-use.json");
  const probe = host.probe({ platform: "linux" });

  const states = await run({ probe, file }, (service) =>
    Effect.gen(function* () {
      const before = tag(yield* service.current);
      const enabled = tag(yield* service.enable);

      return [before, enabled];
    })
  );

  expect(states).toEqual(["NoDesktop", "NoDesktop"]);
});

test("computer use is off until turned on, and stays on after the Daemon restarts", async () => {
  const host = fakeHost();
  const file = join(host.root, "computer-use.json");
  const probe = await linuxDesktop(host);
  a11yInstalled(host);
  busctl(host, 0);

  const first = await run({ probe, file }, (service) =>
    Effect.gen(function* () {
      const before = tag(yield* service.current);
      const after = tag(yield* service.enable);

      return [before, after];
    })
  );

  const restarted = await run({ probe, file }, (service) => Effect.map(service.current, tag));
  const off = await run({ probe, file }, (service) => Effect.map(service.disable, tag));
  const restartedOff = await run({ probe, file }, (service) => Effect.map(service.current, tag));

  expect([...first, restarted, off, restartedOff]).toEqual(["Off", "Ready", "Ready", "Off", "Off"]);
});

test.each([
  [
    "without at-spi2-core, the package and the Host's command to install it",
    false,
    0,
    ComputerUseSetup.cases.LinuxPackages.make({
      packages: ["at-spi2-core"],
      command: "sudo apt-get install -y at-spi2-core",
    }),
  ],
  [
    "with at-spi2-core but no registry on the bus, the accessibility bus",
    true,
    1,
    ComputerUseSetup.cases.AccessibilityBus.make({}),
  ],
] as const)("Linux needs setup %s", async (_, installed, ping, setup) => {
  const host = fakeHost();
  const probe = await linuxDesktop(host);

  if (installed) a11yInstalled(host);
  busctl(host, ping);
  host.command("apt-get", "exit 0");

  const status = await run({ probe, file: join(host.root, "cu.json") }, (s) => s.enable);

  expect(status.state).toEqual(ComputerUseState.cases.NeedsSetup.make({ setup }));
});

test("the accessibility bus is asked on the desktop's session bus", async () => {
  const host = fakeHost();
  const probe = await linuxDesktop(host);
  a11yInstalled(host);
  busctl(host, 0);

  await run({ probe, file: join(host.root, "cu.json") }, (s) => s.enable);

  expect(host.calls("busctl")).toEqual([
    "--user call org.a11y.Bus /org/a11y/bus org.a11y.Bus GetAddress",
    "--address=unix:path=/tmp/a11y call org.a11y.atspi.Registry /org/a11y/atspi/accessible/root org.freedesktop.DBus.Peer Ping",
  ]);
});

let built: Promise<string> | null = null;

/** D6's test helper (the real launcher and Mach hand-off), built once per test file. */
const sharedHelper = () => {
  built ??= makeHelper(realpathSync(newTempDir("pl-cuh-", { short: true })), process.execPath);

  return built;
};

/**
 * The helper app with a script in agent-desktop's place that prints what `status` holds, so a
 * test changes a grant by rewriting it. The script's calls are logged under `host`. macOS only.
 */
export const fakeHelper = async (host: FakeHost, status: string) => {
  const bundle = await sharedHelper();
  const statusFile = host.file(join(host.root, "status.json"), status);
  const calls = join(host.root, "agent-desktop.calls");
  writeFileSync(toolOf(bundle), `#!/bin/sh\necho "$*" >> '${calls}'\n/bin/cat '${statusFile}'\n`);
  chmodSync(toolOf(bundle), 0o755);

  return {
    bundle,
    grant: (next: string) => writeFileSync(statusFile, next),
    calls: () => host.calls("agent-desktop"),
  };
};

/** These run the real launcher (D6's test helper), which needs macOS. */
const macTest = test.skipIf(process.platform !== "darwin");

const macHost = (host: FakeHost) => {
  host.file(join(host.root, "console"));

  return host.probe({ platform: "darwin", uid: process.getuid?.() ?? 0 });
};

macTest.each([
  ["granted", "denied", { accessibility: true, screenRecording: false }],
  ["denied", "granted", { accessibility: false, screenRecording: true }],
  ["denied", "denied", { accessibility: false, screenRecording: false }],
])(
  "macOS with accessibility %s and screen recording %s needs each permission it lacks",
  async (accessibility, screen, permissions) => {
    const host = fakeHost();
    const helper = await fakeHelper(host, macStatus(accessibility, screen));
    const probe = macHost(host);

    const status = await run(
      { probe, file: join(host.root, "cu.json"), helper: helper.bundle },
      (s) => s.enable
    );

    expect(status.state).toEqual(
      ComputerUseState.cases.NeedsSetup.make({
        setup: ComputerUseSetup.cases.MacPermissions.make(permissions),
      })
    );

    expect(helper.calls()).toEqual(["status"]);
  }
);

macTest("macOS with both permissions is ready, and the helper isn't asked while off", async () => {
  const host = fakeHost();
  const helper = await fakeHelper(host, macStatus("granted", "granted"));
  const probe = macHost(host);
  const file = join(host.root, "cu.json");

  const states = await run({ probe, file, helper: helper.bundle }, (service) =>
    Effect.gen(function* () {
      const off = tag(yield* service.ensure);
      const asked = helper.calls().length;
      const on = tag(yield* service.enable);

      return [off, asked, on];
    })
  );

  expect(states).toEqual(["Off", 0, "Ready"]);
});

macTest(
  "setup reveals the helper and opens the pane, then turns ready by itself once granted",
  async () => {
    const host = fakeHost();
    const helper = await fakeHelper(host, macStatus("denied", "denied"));
    host.command("open", "exit 0");
    const probe = macHost(host);

    const states = await run(
      { probe, file: join(host.root, "cu.json"), helper: helper.bundle },
      (service) =>
        Effect.gen(function* () {
          yield* service.enable;

          const ready = yield* Stream.runHead(
            service.changes.pipe(Stream.filter((status) => tag(status) === "Ready"))
          ).pipe(Effect.forkChild);

          const opened = tag(yield* service.openSetup(null));
          helper.grant(macStatus("granted", "granted"));

          return [opened, tag(Option.getOrThrow(yield* Fiber.join(ready)))];
        })
    );

    expect(states).toEqual(["NeedsSetup", "Ready"]);

    expect(host.calls("open")).toEqual([
      `-R ${helper.bundle}`,
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
    ]);
  }
);

test("setup without a helper beside the Daemon fails with why, and says both are missing", async () => {
  const host = fakeHost();
  const probe = macHost(host);

  const result = await run({ probe, file: join(host.root, "cu.json"), helper: null }, (s) =>
    Effect.gen(function* () {
      const status = yield* s.enable;
      const opened = yield* Effect.flip(s.openSetup("screen-recording"));

      return [status.state, opened.message];
    })
  );

  expect(result).toEqual([
    ComputerUseState.cases.NeedsSetup.make({
      setup: ComputerUseSetup.cases.MacPermissions.make({
        accessibility: false,
        screenRecording: false,
      }),
    }),
    "this Daemon has no computer use helper beside it",
  ]);
});

test("setup on Linux opens nothing and says what to run on the Host", async () => {
  const host = fakeHost();
  const probe = await linuxDesktop(host);
  host.command("apt-get", "exit 0");

  const message = await run({ probe, file: join(host.root, "cu.json") }, (s) =>
    Effect.andThen(
      s.enable,
      Effect.map(Effect.flip(s.openSetup(null)), (e) => e.message)
    )
  );

  expect(message).toBe(
    "Run `sudo apt-get install -y at-spi2-core` on this Host, then check again."
  );
});

const figma = DesktopApp.make({ id: AppId.make("com.figma.Desktop"), name: "Figma", icon: null });

const arc = DesktopApp.make({
  id: AppId.make("company.thebrowser.Browser"),
  name: "Arc",
  icon: null,
});

const take = (feed: Stream.Stream<ComputerUseItem>, count: number) =>
  Effect.map(Stream.runCollect(Stream.take(feed, count)), (items) =>
    items.map((item) => item._tag)
  );

test("the Host feed sends one of each first, then only what changed", async () => {
  const host = fakeHost();
  const probe = await linuxDesktop(host);
  a11yInstalled(host);
  busctl(host, 0);

  const controlled = ControlledApp.make({
    app: { id: figma.id, name: figma.name },
    sessionId: SessionId.make("session-1"),
    since: "2026-11-10T00:00:00.000Z",
  });

  const items = await run({ probe, file: join(host.root, "cu.json") }, (service) =>
    Effect.gen(function* () {
      const watched = yield* Effect.forkChild(take(service.feed, 7));
      yield* Effect.sleep(20);
      yield* service.allowApp(figma);
      yield* service.setControlledApps([controlled]);
      yield* service.enable;
      yield* service.disable;

      return yield* Fiber.join(watched);
    })
  );

  expect(items).toEqual([
    "Status",
    "AllowedApps",
    "ControlledApps",
    "AllowedApps",
    "ControlledApps",
    "Status",
    // Turning off publishes the released apps and the new status.
    "ControlledApps",
  ]);
});

test("the always-allowed list is kept by name, survives a restart, and removes by id", async () => {
  const host = fakeHost();
  const probe = host.probe({ platform: "linux" });
  const file = join(host.root, "cu.json");

  const added = await run({ probe, file }, (service) =>
    Effect.gen(function* () {
      yield* service.allowApp(figma);
      yield* service.allowApp(arc);

      return yield* service.allowApp(figma);
    })
  );

  const afterRestart = await run({ probe, file }, (service) =>
    Effect.andThen(service.removeAllowedApp(figma.id), service.allowedApps)
  );

  expect(added.map((allowed) => allowed.app.name)).toEqual(["Arc", "Figma"]);
  expect(afterRestart.map((allowed) => allowed.app.id)).toEqual([arc.id]);
});

macTest("watching the Host checks it once and never again until asked", async () => {
  const host = fakeHost();
  const helper = await fakeHelper(host, macStatus("granted", "granted"));
  const probe = macHost(host);

  const calls = await run(
    { probe, file: join(host.root, "cu.json"), helper: helper.bundle },
    (service) =>
      Effect.gen(function* () {
        yield* service.enable;
        const first = helper.calls().length;
        const watched = yield* Effect.forkChild(Stream.runDrain(service.feed));
        yield* Effect.sleep(50);
        const idle = helper.calls().length;
        yield* Fiber.interrupt(watched);
        yield* service.ensure;

        return [first, idle, helper.calls().length];
      })
  );

  expect(calls).toEqual([1, 1, 2]);
});
