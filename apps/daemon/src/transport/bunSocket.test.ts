/**
 * The graceful-end drain deadline (ENG-613): `end()` waits for a stuck peer to flush queued bytes,
 * but not forever — after `DRAIN_LIMIT_MS` it force-terminates, so a peer that never reads cannot
 * pin the socket open. Driven by fake timers so the 10 s bound is asserted deterministically.
 */
import { afterEach, expect, jest, test } from "bun:test";
import { BunSocketStream, type SocketLike } from "./bunSocket.ts";

afterEach(() => {
  jest.useRealTimers();
});

/** A socket whose `write` accepts nothing, so every chunk stays queued; `end`/`terminate` recorded. */
const stuckSocket = () => {
  const calls = { ended: 0, terminated: 0 };

  const socket: SocketLike = {
    write: () => 0,
    end: () => {
      calls.ended++;
    },
    terminate: () => {
      calls.terminated++;
    },
    pause: () => {},
    resume: () => {},
  };

  return { socket, calls };
};

test("a graceful end force-terminates a stuck peer only after the drain deadline", () => {
  jest.useFakeTimers();
  const { socket, calls } = stuckSocket();
  const stream = new BunSocketStream(socket);

  let writeError: Error | null | undefined;
  stream.write(new Uint8Array(64), (error) => {
    writeError = error;
  });

  let closed = false;
  stream.on("close", () => {
    closed = true;
  });

  // The peer never drains: end queues the close behind the stuck write instead of closing now.
  stream.end();
  expect(calls.ended).toBe(0);

  // Just short of the deadline it is still waiting; crossing it force-terminates.
  jest.advanceTimersByTime(9_999);
  expect(calls.terminated).toBe(0);
  expect(closed).toBe(false);

  jest.advanceTimersByTime(1);
  expect(calls.terminated).toBe(1);
  expect(closed).toBe(true);
  expect(writeError?.message).toBe("socket terminated");
});
