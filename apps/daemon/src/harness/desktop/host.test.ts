import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { ComputerUseHost } from "../../computerUse/index.ts";
import { a11yInstalled, busctl, fakeHost, linuxDesktop } from "../../computerUse/host.testing.ts";
import { computerUseDesktopHost } from "./host.ts";

test("the tools follow the Host's computer use status and its display", async () => {
  const host = fakeHost();
  const probe = await linuxDesktop(host);
  a11yInstalled(host);
  busctl(host, 0);

  const seen = await Effect.runPromise(
    Effect.gen(function* () {
      const desktop = yield* computerUseDesktopHost;
      const status = yield* ComputerUseHost;
      const off = (yield* desktop.state)._tag;
      const waiting = yield* Effect.forkScoped(desktop.untilReady);
      yield* Effect.sleep("30 millis");
      const doneWhileOff = waiting.pollUnsafe() !== undefined;
      yield* status.enable;
      const on = (yield* desktop.state)._tag;
      yield* Fiber.join(waiting);
      const env = yield* desktop.env;
      yield* status.disable;

      return { off, on, env, doneWhileOff, offAgain: (yield* desktop.state)._tag };
    }).pipe(
      Effect.provide(
        ComputerUseHost.layerWith({ probe, file: join(host.root, "computer-use.json") })
      ),
      Effect.scoped
    )
  );

  expect([seen.off, seen.on, seen.offAgain]).toEqual(["Off", "Ready", "Off"]);
  // `untilReady` waits while the Host is off and completes once it is Ready.
  expect(seen.doneWhileOff).toBe(false);
  expect(seen.env).toMatchObject({ WAYLAND_DISPLAY: "wayland-0" });
});
