/**
 * A miniature Daemon for upgrade.slow.test.ts: it listens on the Daemon socket,
 * keeps one "Harness" child (`cat`) on socketpair stdio, answers `info` with
 * its version, PID, the child's PID and an echo through the child, and
 * serves upgrade requests exactly as the real Daemon will.
 *
 *   bun handoff-daemon.ts --as <version>
 */
import type { Socket, SocketHandler } from "bun";
import { Effect } from "effect";
import { paths } from "../../paths.ts";
import { executableOf } from "../../platform/executable.ts";
import { CommandRunner } from "../CommandRunner.ts";
import { closeFd, socketPair } from "../libc.ts";
import {
  adoptListener,
  bindAtomically,
  connectFd,
  listenerFd,
  serveUpgrades,
  takeHandoff,
} from "../upgrade.ts";

const version = process.argv[process.argv.indexOf("--as") + 1] ?? "unknown";

const HARNESS = "harness:echo";

/** A line-oriented wrapper over our end of the child's socketpair. */
const harnessLink = async (fd: number) => {
  const waiting: Array<(line: string) => void> = [];
  let buffered = "";

  const socket = await connectFd(fd, {
    data(_socket, data) {
      buffered += data.toString();

      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        waiting.shift()?.(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    },
  });

  return {
    echo: (text: string) =>
      new Promise<string>((resolve) => {
        waiting.push(resolve);
        socket.write(`${text}\n`);
      }),
  };
};

const program = Effect.gen(function* () {
  const adopted = yield* adoptListener();
  const handoff = yield* takeHandoff();

  let harnessFd: number;
  let childPid: number;
  const inherited = handoff?.fds[HARNESS];

  if (handoff && inherited !== undefined) {
    harnessFd = inherited;
    childPid = handoff.children[HARNESS]!;
  } else {
    const [ours, theirs] = socketPair();
    const child = Bun.spawn([executableOf("cat")], { stdio: [theirs, theirs, "inherit"] });
    closeFd(theirs);
    harnessFd = ours;
    childPid = child.pid;
  }

  const harness = yield* Effect.promise(() => harnessLink(harnessFd));

  const handlers: SocketHandler<undefined> = {
    data(socket: Socket, data: Buffer) {
      if (data.toString().trim() !== "info") return;
      void harness.echo("ok").then((echo) => {
        const info = { version, pid: process.pid, childPid, echo, adopted: adopted !== null };
        socket.write(`${JSON.stringify(info)}\n`);
      });
    },
  };

  const server = yield* bindAtomically(paths().socket, (temporary) =>
    Effect.sync(() => Bun.listen({ unix: temporary, socket: handlers }))
  );

  if (adopted) {
    yield* adopted.drain((fd) => {
      void connectFd(fd, handlers);
    });
  }

  yield* serveUpgrades({
    listenerFd: () => listenerFd(server),
    collect: () =>
      Effect.succeed({ fds: { [HARNESS]: harnessFd }, children: { [HARNESS]: childPid } }),
    args: ["serve"],
  });
  console.log(`ready ${version}`);

  return yield* Effect.never;
});

Effect.runFork(program.pipe(Effect.scoped, Effect.provide(CommandRunner.layer)));
