/**
 * `LocalHost`'s contract for each Layer: Windows on Arm has no local Host, macOS, Linux and
 * Windows x64 find one Daemon and keep it, and the label follows the Client's OS. Nothing spawns or
 * connects, so this runs on the Windows CI leg too.
 */
import { describe, expect, test } from "bun:test";
import { HostTarget } from "@polaris/client";
import { Effect, Layer, Option } from "effect";
import { clientCopy } from "../../shared/clientCopy.ts";
import { LocalHost, localTarget, testDaemon } from "./index.ts";

const serviceOf = (layer: Layer.Layer<LocalHost>) =>
  Effect.runSync(LocalHost.useSync((service) => service).pipe(Effect.provide(layer)));

const given = (env: Record<string, string>) => ({ dev: true, repoRoot: "/nonexistent", env });

describe("LocalHost", () => {
  test("Windows on Arm has no local Host: nothing resolves, even a given socket", async () => {
    for (const dev of [true, false]) {
      const local = serviceOf(
        LocalHost.forPlatform(
          "win32",
          { ...given({ POLARIS_DESKTOP_LOCAL_SOCKET: "/nonexistent/daemon.sock" }), dev },
          "arm64"
        )
      );

      expect(local.supported).toBe(false);
      expect(local.label).toBe("This PC");
      const refused = await Effect.runPromise(Effect.flip(local.resolve));
      expect(refused._tag).toBe("LocalHostUnsupported");
      expect(refused.message).toBe(clientCopy("win32").localHostUnsupported);
      expect(Option.isNone(Effect.runSync(local.current))).toBe(true);
      expect((await Effect.runPromise(Effect.flip(local.listening("C:\\h")))).message).toBe(
        refused.message
      );
    }
  });

  test("macOS, Linux and Windows x64 find the given socket once and keep it", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const env = {
        POLARIS_DESKTOP_LOCAL_SOCKET: "/test/daemon.sock",
        POLARIS_DESKTOP_LOCAL_HOME: "/test/home",
      };

      const local = serviceOf(LocalHost.forPlatform(platform, given(env), "x64"));

      expect(local.supported).toBe(true);
      expect(Option.isNone(Effect.runSync(local.current))).toBe(true);
      const daemon = await Effect.runPromise(local.resolve);
      expect(daemon).toMatchObject({
        socketPath: "/test/daemon.sock",
        installedHome: "/test/home",
      });

      env.POLARIS_DESKTOP_LOCAL_SOCKET = "/elsewhere.sock";
      expect(await Effect.runPromise(local.resolve)).toBe(daemon);
      expect(Option.getOrNull(Effect.runSync(local.current))).toBe(daemon);
    }
  });

  test("the local Host's name follows the Client's OS unless overridden", () => {
    const label = (platform: NodeJS.Platform, override?: string) =>
      serviceOf(LocalHost.forPlatform(platform, { ...given({}), label: override }, "x64")).label;

    expect(label("darwin")).toBe("This Mac");
    expect(label("linux")).toBe("This computer");
    expect(label("win32")).toBe("This PC");
    expect(label("darwin", "")).toBe("This Mac");
    expect(label("linux", "Workstation")).toBe("Workstation");
  });

  test("only a Daemon Polaris installed carries a home to act on", () => {
    expect(localTarget(testDaemon("/h"))).toEqual(
      HostTarget.Local({ socketPath: "/h/.polaris/daemon.sock", installedHome: "/h" })
    );
    expect(localTarget(testDaemon(null))).toEqual(HostTarget.Local({ socketPath: "dev.sock" }));
  });
});
