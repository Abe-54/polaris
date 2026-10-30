/**
 * The OpenCode Harness driver: drives the user's own `opencode` through the v1
 * HTTP + SSE API of one `opencode serve` per Host (ENG-199 Q10). Polaris never
 * reads, stores or forwards OpenCode's provider credentials (ADR 0001); sign-in
 * stays in OpenCode's own `opencode auth login` or its TUI's `/connect`.
 */
import { childEnv } from "../../service/childEnv.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, type Scope } from "effect";
import { polarisHome } from "../../paths.ts";
import type { HarnessDriver, HarnessProbe } from "../HarnessDriver.ts";
import { clientFor } from "./Client.ts";
import { toModels } from "./mapping.ts";
import { openSession } from "./OpenCodeSession.ts";
import { listOpenCodeCommands } from "./commands.ts";
import * as P from "./protocol.ts";
import { acquireServer, type OpenCodeServer, type ServerOptions } from "./Server.ts";

export interface OpenCodeDriverOptions extends ServerOptions {
  /** An empty directory the server lists Models from; defaults to `~/.polaris/opencode`. */
  readonly modelsDirectory?: string;
  /** Tests only: a server to use instead of starting `opencode serve`. */
  readonly server?: OpenCodeServer;
}

/** Throwaway XDG directories, so `opencode --version` writes nothing under the user's home. */
export const scratchXdg = (root: string) => ({
  XDG_DATA_HOME: join(root, "data"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
});

/** `opencode --version` only, with throwaway XDG directories: never a server, a session or a login. */
export const probeOpenCode = (opencodePath: string | null): Effect.Effect<HarnessProbe> =>
  Effect.promise(async (): Promise<HarnessProbe> => {
    if (opencodePath === null)
      return { available: false, version: null, detail: "opencode was not found on PATH" };
    const scratch = mkdtempSync(join(tmpdir(), "polaris-opencode-probe-"));

    try {
      const proc = Bun.spawn([opencodePath, "--version"], {
        env: childEnv({ ...process.env, ...scratchXdg(scratch) }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });

      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (code !== 0)
        return { available: false, version: null, detail: (err || out).trim() || `exit ${code}` };

      return {
        available: true,
        version: out.trim().match(/(\d+\.\d+\.\d+\S*)/)?.[1] ?? null,
        detail: opencodePath,
      };
    } catch (cause) {
      return { available: false, version: null, detail: String(cause) };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

const decodeProviders = P.decoder(P.ConfigProviders);

const decodeConfig = P.decoder(P.Config);

/**
 * Builds the driver. The server it starts lives at most as long as the caller's
 * scope (normally the HarnessRegistry layer), and stops once no session holds it.
 */
export const makeOpenCodeDriver = (
  options: OpenCodeDriverOptions
): Effect.Effect<HarnessDriver, never, Scope.Scope> =>
  Effect.gen(function* () {
    const server = options.server ?? (yield* acquireServer(options));
    const modelsDirectory = options.modelsDirectory ?? join(polarisHome(), "opencode");

    const listModels = Effect.scoped(
      Effect.gen(function* () {
        mkdirSync(modelsDirectory, { recursive: true });
        const client = clientFor(yield* server.lease, modelsDirectory);
        const providers = decodeProviders(yield* client.get("/config/providers"));
        const config = decodeConfig(yield* client.get("/config"));

        return providers === null ? [] : toModels(providers, config?.model ?? null);
      })
    );

    const listCommands = (cwd: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          return yield* listOpenCodeCommands(clientFor(yield* server.lease, cwd));
        })
      );

    return {
      kind: "opencode",
      capabilities: { steer: true, steerAttachments: true, liveCoAttach: true, switchModel: true },
      probe: Effect.suspend(() => probeOpenCode(options.opencodePath())),
      listModels,
      listCommands,
      open: (openOptions) => openSession(server, openOptions),
    } satisfies HarnessDriver;
  });
