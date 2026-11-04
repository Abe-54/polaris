/**
 * The local transport (Node and Bun only): the Daemon's Unix socket, at
 * `$POLARIS_HOME/daemon.sock` (`~/.polaris/daemon.sock` by default), or on Windows its named pipe.
 */
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ByteTransport, readEvents, writeEvents } from "@polaris/protocol";
import { localEndpoint } from "@polaris/protocol/endpoint";
import { Effect, type Scope } from "effect";
import { HostUnreachable } from "../errors.ts";

export const defaultSocketPath = (): string =>
  localEndpoint(process.env.POLARIS_HOME ?? join(homedir(), ".polaris"));

const opened = (socket: ReturnType<typeof connect>, path: string, hostId: string) =>
  Effect.callback<void, HostUnreachable>((resume) => {
    const onError = (error: NodeJS.ErrnoException) =>
      resume(
        Effect.fail(
          new HostUnreachable({
            hostId,
            detail:
              error.code === "ENOENT" || error.code === "ECONNREFUSED"
                ? `no Daemon is listening on ${path}`
                : `${path}: ${error.code ?? error.message}`,
          })
        )
      );

    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      // Errors after connecting end the stream through `readEvents`.
      socket.on("error", () => {});
      resume(Effect.void);
    });

    return Effect.sync(() => socket.destroy());
  });

/** Connects to the local Daemon's socket for `hostId`; it closes with the scope. */
export const socketTransport = (
  path: string,
  hostId: string
): Effect.Effect<ByteTransport, HostUnreachable, Scope.Scope> =>
  Effect.gen(function* () {
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => connect(path)),
      (socket) => Effect.sync(() => socket.destroy())
    );

    yield* opened(socket, path, hostId);

    return {
      incoming: readEvents(socket),
      write: writeEvents(socket),
      close: Effect.sync(() => {
        socket.end();
      }),
    } satisfies ByteTransport;
  });
