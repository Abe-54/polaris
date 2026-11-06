import { expect, test } from "bun:test";
import { connect } from "node:net";
import { Effect } from "effect";
import { postTraces, withTraceFixture } from "./testing.ts";

test(
  "a slow authenticated token cannot occupy another token's slot and has a total deadline",
  () =>
    withTraceFixture(async (f) => {
      const url = new URL(`${f.endpoint}/v1/traces`);
      const socket = connect(f.port, "127.0.0.1");
      let output = "";
      let answeredAt: number | undefined;
      let closedAt: number | undefined;
      socket.on("data", (data) => {
        output += data.toString();
        answeredAt ??= Date.now();
      });
      socket.on("error", () => {});

      const closed = new Promise<void>((resolve) =>
        socket.once("close", () => {
          closedAt = Date.now();
          resolve();
        })
      );

      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(
        `POST ${url.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nContent-Type: application/json\r\nContent-Length: 10000\r\n\r\n`
      );
      const started = Date.now();
      // Never stops, so only a total deadline ends it, and the Daemon closes with bytes in flight.
      const drip = setInterval(() => socket.write(" "), 5);

      try {
        await Bun.sleep(100);
        expect((await postTraces(f.endpoint!)).status).toBe(429);
        const other = await Effect.runPromise(f.runtime.terminalEnvironment(f.root, {}));
        expect((await postTraces(other.OTEL_EXPORTER_OTLP_ENDPOINT!)).status).toBe(200);
        await Bun.sleep(4500 - (Date.now() - started));
        expect(output).toBe("");
        await Promise.race([closed, Bun.sleep(6500 - (Date.now() - started))]);
        expect(output).toContain("408");
        expect(closedAt).toBeNumber();
        // A close right behind the answer resets it away from a client on Windows (ENG-802).
        expect(closedAt! - answeredAt!).toBeGreaterThan(100);
        expect((await postTraces(f.endpoint!)).status).toBe(200);
      } finally {
        clearInterval(drip);
        socket.destroy();
      }
    }),
  10_000
);
