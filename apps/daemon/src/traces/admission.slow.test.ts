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
      socket.on("data", (data) => {
        output += data.toString();
      });
      socket.on("error", () => {});
      const closed = new Promise<void>((resolve) => socket.once("close", resolve));
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(
        `POST ${url.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nContent-Type: application/json\r\nContent-Length: 10000\r\n\r\n`
      );
      const drip = setInterval(() => socket.write(" "), 100);

      try {
        await Bun.sleep(100);
        expect((await postTraces(f.endpoint!)).status).toBe(429);
        const other = await Effect.runPromise(f.runtime.terminalEnvironment(f.root, {}));
        expect((await postTraces(other.OTEL_EXPORTER_OTLP_ENDPOINT!)).status).toBe(200);
        await Promise.race([closed, Bun.sleep(6500)]);
        expect(output).toContain("408");
        expect((await postTraces(f.endpoint!)).status).toBe(200);
      } finally {
        clearInterval(drip);
        socket.destroy();
      }
    }),
  10_000
);
