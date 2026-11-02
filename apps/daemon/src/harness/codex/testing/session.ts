/**
 * A Codex session against a fake app-server, for driver tests: open it, script
 * the server, wait for events. Test files run `cleanup` after each test.
 */
import { join } from "node:path";
import { type PermissionMode, SessionId } from "@polaris/protocol";
import { Effect, Schema, type Scope, Stream } from "effect";
import {
  type OpenOptions,
  type HarnessDriver,
  HarnessEvent,
  type HarnessSession,
} from "../../HarnessDriver.ts";
import type { CodexDriverOptions } from "../CodexDriver.ts";
import type { Json } from "../protocol.ts";
import {
  type ClientRequest,
  type FakeAppServer,
  type FakeConnection,
  type Handler,
  startFakeAppServer,
} from "./FakeAppServer.ts";
import { unstamped } from "../../itemClock.testing.ts";
import { newTempDir, removeTempDir } from "../../../platform/tempDir.testing.ts";

export const THREAD = "thr_1";

export type EventOf<T extends HarnessEvent["_tag"]> = Extract<HarnessEvent, { readonly _tag: T }>;

export const ofTag = <T extends HarnessEvent["_tag"]>(
  events: ReadonlyArray<HarnessEvent>,
  tag: T
): Array<EventOf<T>> => events.filter(HarnessEvent.$is(tag));

const decodeThreadId = Schema.decodeUnknownSync(Schema.Struct({ threadId: Schema.String }));

export const cleanup: Array<() => void> = [];

/** Socket paths must stay under ~104 bytes, so tests use a short temp root. */
const socketPath = () => {
  const dir = newTempDir("pcx-", { short: true });
  cleanup.push(() => removeTempDir(dir));

  return join(dir, "s.sock");
};

export interface Harness {
  readonly session: HarnessSession;
  readonly server: FakeAppServer;
  /** Events with their start stamps cleared; `stamped` keeps them. */
  readonly events: Array<HarnessEvent>;
  readonly stamped: Array<HarnessEvent>;
  /** The first event with `tag` (and matching `where`), waiting up to two seconds. */
  readonly waitFor: <T extends HarnessEvent["_tag"]>(
    tag: T,
    where?: (e: EventOf<T>) => boolean
  ) => Effect.Effect<EventOf<T>>;
}

/**
 * Opens a session of `makeDriver`'s driver against a fake app-server and runs
 * `body`; the scope closes afterwards.
 */
export const sessionWith =
  (makeDriver: (options: CodexDriverOptions) => Effect.Effect<HarnessDriver, never, Scope.Scope>) =>
  <A>(
    handler: Handler,
    body: (h: Harness) => Effect.Effect<A, unknown>,
    options: {
      readonly resumeCursor?: string;
      readonly serviceTier?: "default" | "priority";
      readonly permissionMode?: PermissionMode;
      readonly readOnly?: boolean;
      readonly constellation?: NonNullable<OpenOptions["constellation"]>;
      readonly constellations?: NonNullable<OpenOptions["constellations"]>;
      readonly environment?: NonNullable<OpenOptions["environment"]>;
    } = {}
  ): Promise<{
    result: A;
    events: Array<HarnessEvent>;
    stamped: Array<HarnessEvent>;
    server: FakeAppServer;
  }> => {
    const path = socketPath();
    const server = startFakeAppServer(path, handler);
    cleanup.push(server.stop);
    const events: Array<HarnessEvent> = [];
    const stamped: Array<HarnessEvent> = [];

    const program = Effect.gen(function* () {
      const driver = yield* makeDriver({
        socketPath: path,
        spawnAppServer: false,
        codexPath: "/opt/codex/bin/codex",
      });

      const session = yield* driver.open({
        sessionId: SessionId.make("s1"),
        cwd: "/repo",
        permissionMode: options.permissionMode ?? "supervised",
        model: null,
        effort: null,
        resumeCursor: options.resumeCursor ?? null,
        readOnly: options.readOnly ?? false,
        ...options,
      });

      yield* session.events.pipe(
        Stream.runForEach((e) =>
          Effect.sync(() => {
            stamped.push(e);
            events.push(unstamped(e));
          })
        ),
        // Detached, so it keeps reading through scope close and sees the final `Exited`.
        Effect.forkDetach
      );

      const waitFor = <T extends HarnessEvent["_tag"]>(
        tag: T,
        where: (e: EventOf<T>) => boolean = () => true
      ) =>
        Effect.promise(async () => {
          for (let i = 0; i < 200; i++) {
            const found = ofTag(events, tag).find(where);

            if (found) return found;
            await Bun.sleep(10);
          }

          throw new Error(
            `timed out waiting for ${tag}; saw ${events.map((e) => e._tag).join(",")}`
          );
        });

      return yield* body({ session, server, events, stamped, waitFor });
    });

    return Effect.runPromise(Effect.scoped(program)).then(async (result) => {
      await Bun.sleep(20);

      return { result, events, stamped, server };
    });
  };

/** A handler for the handshake and thread lifecycle, delegating the rest. */
/** What codex-cli 0.162.1's app-server answers `initialize` with. */
export const FAKE_USER_AGENT = "polaris/0.162.1 (Mac OS 27.0.0; arm64) ghostty/1.3.1 (polaris; 0)";

/** What `config/read` answers: one MCP server and one plugin the user has set up. */
export const FAKE_EFFECTIVE_CONFIG = {
  model: "gpt-5",
  mcp_servers: { linear: { url: "https://mcp.linear.app/mcp", enabled: true } },
  plugins: { "chrome@openai-bundled": { enabled: true } },
};

export const scripted =
  (rest: (request: ClientRequest, conn: FakeConnection) => void | Promise<void>): Handler =>
  (request, conn) => {
    switch (request.method) {
      case "initialize":
        return conn.reply({ userAgent: FAKE_USER_AGENT, codexHome: "/home/user/.codex" });
      case "thread/start":
        return conn.reply({ thread: { id: THREAD } });
      case "thread/resume":
        return conn.reply({ thread: { id: decodeThreadId(request.params).threadId } });
      case "thread/unsubscribe":
        return conn.reply({ status: "unsubscribed" });
      case "config/read":
        return conn.reply({ config: FAKE_EFFECTIVE_CONFIG });
      default:
        return rest(request, conn);
    }
  };

export const turn = (id: string, status = "inProgress", error: Json = null) => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status,
  error,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});
