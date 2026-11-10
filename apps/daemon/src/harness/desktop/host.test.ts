import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
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
      const off = yield* desktop.ready;
      yield* status.enable;
      const on = yield* desktop.ready;
      const env = yield* desktop.env;
      yield* status.disable;

      return { off, on, env, offAgain: yield* desktop.ready };
    }).pipe(
      Effect.provide(
        ComputerUseHost.layerWith({ probe, file: join(host.root, "computer-use.json") })
      ),
      Effect.scoped
    )
  );

  expect([seen.off, seen.on, seen.offAgain]).toEqual([false, true, false]);
  expect(seen.env).toMatchObject({ WAYLAND_DISPLAY: "wayland-0" });
});
