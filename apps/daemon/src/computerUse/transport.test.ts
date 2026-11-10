/** Computer use over the real transport: the Host's RPCs and its feed, beside the stubs left. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import { AppId, ComputerUseItem, DaemonRpcs } from "@polaris/protocol";
import { Effect, Fiber, Layer, Stream } from "effect";
import { HostSecrets } from "../secrets/index.ts";
import { startServer } from "../transport/server.ts";
import { removeTempDirSettled } from "../platform/tempDir.testing.ts";
import { fakeHost } from "./host.testing.ts";
import { ComputerUseHost, ComputerUseHostRpcHandlers } from "./index.ts";

const hello = { clientName: "test", clientVersion: "0", deviceLabel: "test", capabilities: [] };

test("a Client turns computer use on, watches it turn ready, and the app RPC is still a stub", async () => {
  const host = fakeHost();
  await host.listen(join(host.root, "run", "1000", "wayland-0"));
  host.file(join(host.root, "dbus-1", "org.a11y.Bus.service"));
  host.command(
    "busctl",
    `case "$*" in *GetAddress*) printf 's "unix:path=/tmp/a11y"\\n';; *) exit 0;; esac`
  );

  const probe = host.probe({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.promise(() => removeTempDirSettled(host.root)));

        const server = yield* startServer({
          root: host.root,
          socketPath: join(host.root, "d.sock"),
          lockPath: join(host.root, "d.lock"),
          handlers: ComputerUseHostRpcHandlers.pipe(
            Layer.provide(
              ComputerUseHost.layerWith({ probe, file: join(host.root, "computer-use.json") })
            )
          ),
          capabilities: ["computer-use"],
          secrets: HostSecrets.memory(),
        });

        const { client } = yield* connectRpcWith(
          DaemonRpcs,
          yield* socketTransport(server.socketPath)
        );

        yield* client.hello(hello);

        const off = yield* client["computerUse.status"]({ refresh: false });

        const feed = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(client["computerUse.watch"]({}), 4))
        );

        yield* Effect.sleep("50 millis");
        const on = yield* client["computerUse.enable"]({});
        const items = yield* Fiber.join(feed);

        const app = yield* Effect.flip(
          client["computerUse.app"]({ appId: AppId.make("com.figma.Desktop") })
        );

        const terminal = AppId.make("com.apple.Terminal");
        const added = yield* client["computerUse.allowedApps.add"]({ appId: terminal });
        const listed = yield* client["computerUse.allowedApps"]({});

        expect(added.map((allowed) => allowed.app.id)).toEqual([terminal]);
        expect(listed).toEqual(added);
        expect([off.state._tag, on.state._tag]).toEqual(["Off", "Ready"]);

        expect(
          items.map((item) =>
            ComputerUseItem.guards.Status(item) ? item.status.state._tag : item._tag
          )
        ).toEqual(["Off", "AllowedApps", "ControlledApps", "Ready"]);

        expect(app._tag).toBe("Unsupported");
      })
    )
  );
});
