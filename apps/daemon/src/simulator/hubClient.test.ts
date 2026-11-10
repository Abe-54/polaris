import { afterEach, describe, expect, test } from "bun:test";
import { inputBarrier } from "./hubClient.ts";

const TIMING = { admitMs: 500, configMs: 1_000, answerMs: 100 };

interface Behaviour {
  /** Delay before the first `0x82`, as a cold capture session takes. */
  readonly configAfterMs: number;
  readonly answer: boolean;
}

let stop: (() => void) | null = null;

const frame = (tag: number, json: string) => {
  const body = new TextEncoder().encode(json);

  return new Uint8Array([tag, ...body]);
};

afterEach(() => stop?.());

/** An input socket that admits, configures after a delay, and only then answers barriers (or not). */
const serve = ({ configAfterMs, answer }: Behaviour) => {
  const configuredAt = { at: Number.POSITIVE_INFINITY };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, srv) =>
      srv.upgrade(request, { data: undefined }) ? undefined : new Response(null, { status: 400 }),
    websocket: {
      open: (socket) => {
        socket.send(new Uint8Array([0x83]));
        setTimeout(() => {
          configuredAt.at = Date.now();
          socket.send(frame(0x82, '{"inputUnavailable":false}'));
        }, configAfterMs);
      },
      message: (socket, message) => {
        if (!answer || !(message instanceof Uint8Array) || message[0] !== 0x11) return;
        const reply = () => socket.send(frame(0x91, '{"requestId":1,"ok":true}'));

        if (Date.now() >= configuredAt.at) reply();
        else setTimeout(reply, configAfterMs);
      },
    },
  });

  stop = () => {
    void server.stop(true);
  };

  return { port: server.port ?? 0, token: "t" };
};

describe("inputBarrier", () => {
  test("a cold session's late config isn't a wedge", async () => {
    const endpoint = serve({ configAfterMs: 300, answer: true });

    expect(await inputBarrier(endpoint, "udid", TIMING)).toBe("live");
  });

  test("an unanswered barrier after the config is a wedge", async () => {
    const endpoint = serve({ configAfterMs: 0, answer: false });

    expect(await inputBarrier(endpoint, "udid", TIMING)).toBe("wedged");
  });
});
