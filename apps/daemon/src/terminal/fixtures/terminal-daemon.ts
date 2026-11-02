/**
 * A miniature Daemon for handoff.slow.test.ts: the real `Terminals` (recorded under
 * `POLARIS_HOME`, handed across upgrades) behind a line protocol on the Daemon
 * socket, and the real upgrade hand-off.
 *
 *   bun terminal-daemon.ts --as <version>
 *
 * Requests (one JSON line each): `{op:"info"}`, `{op:"open",cwd}`,
 * `{op:"input",id,text}`, `{op:"resize",id,cols,rows}`, `{op:"read",id}` (the
 * replay an attacher gets now, as text, with `<exit N>` appended once exited),
 * `{op:"list"}`.
 */
import { TerminalId } from "@polaris/protocol";
import type { Socket } from "bun";
import { Context, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { paths } from "../../paths.ts";
import { CommandRunner } from "../../service/CommandRunner.ts";
import {
  adoptListener,
  bindAtomically,
  connectFd,
  listenerFd,
  serveUpgrades,
} from "../../service/upgrade.ts";
import { type TerminalInfo, TerminalItem, Terminals, TerminalsDaemonLive } from "../Terminals.ts";

const version = process.argv[process.argv.indexOf("--as") + 1] ?? "unknown";

/** One request line, keyed by `op`. */
const Request = Schema.Union([
  Schema.Struct({ op: Schema.Literal("info") }),
  Schema.Struct({ op: Schema.Literal("open"), cwd: Schema.String }),
  Schema.Struct({ op: Schema.Literal("input"), id: TerminalId, text: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("resize"),
    id: TerminalId,
    cols: Schema.Number,
    rows: Schema.Number,
  }),
  Schema.Struct({ op: Schema.Literal("read"), id: TerminalId }),
  Schema.Struct({ op: Schema.Literal("list") }),
]).pipe(Schema.toTaggedUnion("op"));

const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(Request));

interface Info {
  readonly version: string;
  readonly pid: number;
  readonly adopted: boolean;
}

interface BadRequest {
  readonly error: string;
}

/** Every reply is one JSON line. */
type Reply = string | Info | ReadonlyArray<TerminalInfo> | BadRequest;

const program = Effect.gen(function* () {
  const adopted = yield* adoptListener();
  // Built in this scope (after adopting the listener), as the Daemon's own layer.
  const terminals = Context.get(yield* Layer.build(TerminalsDaemonLive), Terminals);

  const read = (id: TerminalId) =>
    Effect.gen(function* () {
      const items: Array<TerminalItem> = [];

      const fiber = yield* terminals.attach(id).pipe(
        Stream.runForEach((item) => Effect.sync(() => items.push(item))),
        Effect.forkChild
      );

      yield* Effect.sleep("150 millis");
      yield* Fiber.interrupt(fiber);

      return items
        .map((i) =>
          TerminalItem.match(i, {
            Output: (o) => new TextDecoder().decode(o.data),
            Exit: (e) => `<exit ${e.code}>`,
          })
        )
        .join("");
    });

  const handle = Request.match({
    info: () => Effect.succeed({ version, pid: process.pid, adopted: adopted !== null }),
    open: ({ cwd }) =>
      terminals.open({ cwd, cols: 80, rows: 24, argv: ["/bin/sh"] }).pipe(Effect.orDie),
    input: ({ id, text }) =>
      terminals.input(id, new TextEncoder().encode(text)).pipe(Effect.as("ok"), Effect.orDie),
    resize: ({ id, cols, rows }) =>
      terminals.resize(id, cols, rows).pipe(Effect.as("ok"), Effect.orDie),
    read: ({ id }) => read(id),
    list: () => terminals.list,
  });

  const reply = (line: string): Effect.Effect<Reply> =>
    Option.match(decodeRequest(line), {
      onNone: () => Effect.succeed({ error: `bad request ${line}` }),
      onSome: handle,
    });

  const handlers = {
    data(socket: Socket, data: Buffer) {
      for (const line of data.toString().split("\n")) {
        if (line.trim() === "") continue;
        Effect.runFork(
          reply(line).pipe(
            Effect.tap((reply) => Effect.sync(() => socket.write(`${JSON.stringify(reply)}\n`)))
          )
        );
      }
    },
  };

  const server = yield* bindAtomically(paths().socket, (temporary) =>
    Effect.sync(() => Bun.listen({ unix: temporary, socket: handlers }))
  );

  if (adopted) yield* adopted.drain((fd) => void connectFd(fd, handlers));
  yield* serveUpgrades({ listenerFd: () => listenerFd(server), args: ["serve"] });
  console.log(`ready ${version}`);

  return yield* Effect.never;
});

Effect.runFork(program.pipe(Effect.scoped, Effect.provide(CommandRunner.layer)));
