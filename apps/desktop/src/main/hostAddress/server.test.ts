import { afterEach, describe, expect, test } from "bun:test";
import { type AddressInfo, connect, createServer, Socket } from "node:net";
import { type Cause, Effect, Queue, Stream } from "effect";
import { PROXY_USER, type ProxyStatus } from "./proxy.ts";
import {
  type HostAddressTransport,
  lookupOutside,
  type ProxyServer,
  startProxyServer,
  type Target,
} from "./server.ts";

const isHostAddress = (name: string) =>
  /(^|\.)localhost\.?$/i.test(name) || name.startsWith("127.") || name === "::1";

/**
 * A Host side that records what it was sent and echoes it back in upper case, ending after
 * "BYE"; `written` is every byte the Host received.
 */
const echoTransport = (written: Array<string>) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>();

    const transport: HostAddressTransport = {
      incoming: Stream.fromQueue(queue),
      write: (bytes) =>
        Effect.gen(function* () {
          const text = Buffer.from(bytes).toString();

          written.push(text);
          yield* Queue.offer(queue, Buffer.from(text.toUpperCase()));

          if (text.includes("BYE")) yield* Queue.end(queue);
        }),
    };

    return transport;
  });

/** A Host side that answers its first bytes with `response`, then ends. */
/** Answers the first write with `response`'s chunks: offered at once, or one at a time if `apart`. */
const fixedTransport = (response: string | ReadonlyArray<string>, apart: boolean) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>();

    const chunks = [response].flat().map((chunk) => Buffer.from(chunk));

    const offered: Effect.Effect<unknown> = apart
      ? Effect.forEach(chunks, (chunk) =>
          Effect.andThen(Queue.offer(queue, chunk), Effect.sleep(5))
        )
      : Queue.offerAll(queue, chunks);

    const transport: HostAddressTransport = {
      incoming: Stream.fromQueue(queue),
      // Forked, so the relay reads each chunk apart before the next is offered.
      write: () => Effect.asVoid(Effect.forkDetach(Effect.andThen(offered, Queue.end(queue)))),
    };

    return transport;
  });

let server: ProxyServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

interface Start {
  readonly opened?: Array<Target>;
  readonly written?: Array<string>;
  readonly fail?: ProxyStatus;
  /** The Host's whole response to the first bytes it gets, instead of the echo. */
  readonly respond?: (realm: string) => string | ReadonlyArray<string>;
  /** The response's chunks arrive one at a time, rather than all at once. */
  readonly apart?: boolean;
  readonly direct?: Array<string>;
  readonly directPort?: number;
  readonly handshakeTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  /** The direct socket, for a test that controls it; `net.connect` to `directPort` otherwise. */
  readonly remote?: Socket;
  readonly maxConnections?: number;
}

const start = async (options: Start = {}) => {
  const proxy = await startProxyServer<never>({
    isHostAddress,
    run: (effect) => Effect.runFork(effect),
    open: (target) => {
      options.opened?.push(target);

      if (options.fail !== undefined) return Effect.fail(options.fail);

      return options.respond === undefined
        ? echoTransport(options.written ?? [])
        : fixedTransport(options.respond(server?.realm ?? ""), options.apart ?? false);
    },
    connectDirect: (hostname, port) => {
      options.direct?.push(`${hostname}:${port}`);

      return options.remote ?? connect(options.directPort ?? port, "127.0.0.1");
    },
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    maxConnections: options.maxConnections,
  });

  server = proxy;

  return proxy;
};

const basic = (password: string) =>
  `Proxy-Authorization: Basic ${Buffer.from(`${PROXY_USER}:${password}`).toString("base64")}`;

/** Sends `text` as the browser would, and collects everything until the proxy closes. */
const exchange = (port: number, text: string, waitMs = 500) =>
  new Promise<{ readonly received: string; readonly closedAt: number }>((resolve) => {
    const began = Date.now();
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    let received = "";

    socket.on("data", (chunk) => {
      received += Buffer.from(chunk).toString("latin1");
    });
    // A reset still ends in "close", with what arrived before it.
    socket.on("error", () => {});
    socket.on("close", () => resolve({ received, closedAt: Date.now() - began }));
    setTimeout(() => socket.end(), waitMs);
  });

const statusOf = (received: string) => received.slice(0, received.indexOf("\r\n"));

describe("the proxy's credential", () => {
  test.each([
    ["no credential", (_secret: string) => ""],
    [
      "a wrong secret",
      (secret: string) => `${basic(secret.replace(/^./, (c) => (c === "A" ? "B" : "A")))}\r\n`,
    ],
    ["the credential twice", (secret: string) => `${basic(secret)}\r\n${basic(secret)}\r\n`],
    [
      "another user",
      (secret: string) => `Proxy-Authorization: Basic ${btoa(`root:${secret}`)}\r\n`,
    ],
  ])("%s gets a 407 asking for Basic, and nothing is opened", async (_name, header) => {
    const opened: Array<Target> = [];
    const proxy = await start({ opened });

    const { received } = await exchange(
      proxy.port,
      `CONNECT app.localhost:443 HTTP/1.1\r\nHost: app.localhost:443\r\n${header(proxy.secret)}\r\nhello`
    );

    expect(statusOf(received)).toBe("HTTP/1.1 407 Proxy Authentication Required");
    expect(received).toContain(`Proxy-Authenticate: Basic realm="${proxy.realm}"`);
    expect(opened).toEqual([]);
  });

  test("a garbled request without the credential gets the 407, not a parse error", async () => {
    const proxy = await start();

    const { received } = await exchange(proxy.port, "NONSENSE\r\n\r\n");

    expect(statusOf(received)).toBe("HTTP/1.1 407 Proxy Authentication Required");
  });

  test("each server has its own secret", async () => {
    const first = await start();

    const second = await startProxyServer<never>({
      isHostAddress,
      run: (effect) => Effect.runFork(effect),
      open: () => Effect.fail(502),
    });

    await second.close();
    expect(first.secret).not.toBe(second.secret);
    expect(first.secret.length).toBeGreaterThanOrEqual(32);
  });
});

describe("the proxy's routes", () => {
  test("a CONNECT to a Host address reaches the Host with its hostname as sent, both ways", async () => {
    const opened: Array<Target> = [];
    const proxy = await start({ opened });

    const { received } = await exchange(
      proxy.port,
      `CONNECT App.localhost:443 HTTP/1.1\r\n${basic(proxy.secret)}\r\n\r\nhello bye`
    );

    expect(opened).toEqual([{ hostname: "App.localhost", port: 443 }]);
    expect(received).toBe("HTTP/1.1 200 Connection Established\r\n\r\nHELLO BYE");
  });

  test("an http request goes to the Host in origin form, without the credential or anything after its body", async () => {
    const opened: Array<Target> = [];
    const written: Array<string> = [];
    const proxy = await start({ opened, written });

    await exchange(
      proxy.port,
      [
        "POST http://localhost:5173/api?q=1 HTTP/1.1",
        "Host: localhost:5173",
        basic(proxy.secret),
        "Proxy-Connection: keep-alive",
        "Content-Length: 3",
        "",
        "byeGET http://other.localhost/ HTTP/1.1",
      ].join("\r\n")
    );

    expect(opened).toEqual([{ hostname: "localhost", port: 5173 }]);
    expect(written.join("")).toBe(
      "POST /api?q=1 HTTP/1.1\r\nHost: localhost:5173\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbye"
    );
  });

  test("a loopback IP CONNECT goes to the Host as its address text", async () => {
    const opened: Array<Target> = [];
    const proxy = await start({ opened });

    await exchange(proxy.port, `CONNECT [::1]:3000 HTTP/1.1\r\n${basic(proxy.secret)}\r\n\r\nbye`);

    expect(opened).toEqual([{ hostname: "::1", port: 3000 }]);
  });

  test.each([
    ["a CONNECT to an IP outside loopback", "CONNECT 10.0.0.1:80 HTTP/1.1"],
    ["an http request to the unspecified address", "GET http://0.0.0.0/ HTTP/1.1"],
  ])("%s is refused, never opened nor connected from here", async (_name, line) => {
    const opened: Array<Target> = [];
    const direct: Array<string> = [];
    const proxy = await start({ opened, direct });

    const { received } = await exchange(proxy.port, `${line}\r\n${basic(proxy.secret)}\r\n\r\n`);

    expect(statusOf(received)).toBe("HTTP/1.1 403 Forbidden");
    expect([opened, direct]).toEqual([[], []]);
  });

  test("a direct name that resolves to this machine is refused, not loaded from its loopback", async () => {
    const error = await new Promise((resolve) =>
      lookupOutside("localhost", { all: true }, (failure) => resolve(failure?.code))
    );

    expect(error).toBe("ELOOPBACK");
  });

  test("any other name loads directly from this machine, not from the Host", async () => {
    const site = createServer((socket) => socket.end("from this machine"));

    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));

    // SAFETY: a TCP server listening on a port reports an AddressInfo.
    const address = site.address() as AddressInfo;
    const opened: Array<Target> = [];
    const direct: Array<string> = [];
    const proxy = await start({ opened, direct, directPort: address.port });

    const { received } = await exchange(
      proxy.port,
      `CONNECT printer2:80 HTTP/1.1\r\n${basic(proxy.secret)}\r\n\r\n`
    );

    site.close();
    expect([opened, direct]).toEqual([[], ["printer2:80"]]);
    expect(received).toBe("HTTP/1.1 200 Connection Established\r\n\r\nfrom this machine");
  });

  test("a stream that won't open answers with its status and closes", async () => {
    const proxy = await start({ fail: 504 });

    const { received } = await exchange(
      proxy.port,
      `CONNECT localhost:5173 HTTP/1.1\r\n${basic(proxy.secret)}\r\n\r\n`
    );

    expect(statusOf(received)).toBe("HTTP/1.1 504 Gateway Timeout");
  });
});

describe("the proxy's limits", () => {
  test("a connection that never sends a request is closed after the handshake timeout", async () => {
    const proxy = await start({ handshakeTimeoutMs: 100 });

    const { received, closedAt } = await exchange(proxy.port, "CONNECT app.localhost:443", 2_000);

    expect(received).toBe("");
    expect(closedAt).toBeLessThan(1_000);
  });

  test("connections past the cap are closed unread", async () => {
    const opened: Array<Target> = [];
    const proxy = await start({ opened, maxConnections: 1 });
    const held = connect(proxy.port, "127.0.0.1");

    await new Promise((resolve) => held.once("connect", resolve));

    const { received, closedAt } = await exchange(
      proxy.port,
      `CONNECT app.localhost:443 HTTP/1.1\r\n${basic(proxy.secret)}\r\n\r\n`,
      2_000
    );

    held.destroy();
    expect([received, opened]).toEqual(["", []]);
    expect(closedAt).toBeLessThan(1_000);
  });
});

describe("the proxy's direct connections", () => {
  test("a load cancelled while its connection opens destroys that connection", async () => {
    const remote = new Socket();
    const proxy = await start({ remote });

    const browser = connect(proxy.port, "127.0.0.1", () =>
      browser.write(`CONNECT printer2:80 HTTP/1.1\r\n${basic(proxy.secret)}\r\n\r\n`)
    );

    await Bun.sleep(100);
    browser.destroy();
    await Bun.sleep(100);

    expect(remote.destroyed).toBe(true);
  });

  test("a connection that never opens answers 504 after the deadline", async () => {
    const remote = new Socket();
    const proxy = await start({ remote, connectTimeoutMs: 100 });

    const { received } = await exchange(
      proxy.port,
      `CONNECT printer2:80 HTTP/1.1\r\n${basic(proxy.secret)}\r\n\r\n`,
      2_000
    );

    expect([statusOf(received), remote.destroyed]).toEqual(["HTTP/1.1 504 Gateway Timeout", true]);
  });
});

describe("a 407 from the Host", () => {
  const challenge = (realm: string) => `Proxy-Authenticate: Basic realm="${realm}"`;
  const get = (secret: string) => `GET http://localhost:3000/ HTTP/1.1\r\n${basic(secret)}\r\n\r\n`;
  const early = "HTTP/1.1 103 Early Hints\r\nLink: </a.css>\r\n\r\n";

  test.each([
    ["as sent", (realm: string) => `HTTP/1.1 407 Proxy Auth\r\n${challenge(realm)}\r\n\r\n`],
    ["with bare LFs", (realm: string) => `HTTP/1.1 407\n${challenge(realm)}\n\n`],
    ["in lowercase after junk", (realm: string) => ` http/1.0 407\r\n${challenge(realm)}\r\n\r\n`],
    ["with a leading zero", (realm: string) => `HTTP/1.1 0407\r\n${challenge(realm)}\r\n\r\n`],
    [
      "after a 100 Continue",
      (realm: string) =>
        `HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 407 Proxy Auth\r\n${challenge(realm)}\r\n\r\n`,
    ],
    [
      "after a 103 Early Hints",
      (realm: string) => `${early}HTTP/1.1 407\r\n${challenge(realm)}\r\n\r\n`,
    ],
  ])(
    "is never relayed, %s, even in this proxy's own realm: the browser gets a 502",
    async (_, respond) => {
      const proxy = await start({ respond });
      const { received } = await exchange(proxy.port, get(proxy.secret));

      expect(statusOf(received)).toBe("HTTP/1.1 502 Bad Gateway");
      expect(received).not.toContain("Proxy-Authenticate");
    }
  );

  test.each([false, true])(
    "is never relayed when its status line is split across chunks (apart: %p)",
    async (apart) => {
      const proxy = await start({
        apart,
        respond: (realm) => [early, "HTTP/1.1 40", `7 Proxy Auth\r\n${challenge(realm)}\r\n\r\n`],
      });

      const { received } = await exchange(proxy.port, get(proxy.secret));

      expect(statusOf(received)).toBe("HTTP/1.1 502 Bad Gateway");
      expect(received).not.toContain("Proxy-Authenticate");
    }
  );

  test.each([
    [false, ["HTTP/1.1 103 Early Hints\r\nProxy-Authenticate: Basic\r\n\r\nHTTP/1.1 200 OK\r\n"]],
    [
      true,
      ["HTTP/1.1 103 Early Hints\r\nProxy-Auth", "enticate: Basic\r\n\r\nHTTP/1.1 200 OK\r\n"],
    ],
  ])("proxy auth headers are stripped from every head (apart: %p)", async (apart, interim) => {
    const proxy = await start({
      apart,
      respond: (realm) => [
        ...interim,
        `${challenge(realm)}\r\n proxy-continued\r\nproxy-authentication-info : x\r\n`,
        "Content-Length: 2\r\n\r\nok",
      ],
    });

    const { received } = await exchange(proxy.port, get(proxy.secret));

    expect(received).toBe(
      "HTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
    );
  });

  test.each([
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    `${early}HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok`,
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\nHTTP/1.1 407 in the frames",
    "HTTP/1.1 200 OK\r\n\r\nProxy-Authenticate: in the body",
  ])("other responses pass through untouched: %j", async (response) => {
    const proxy = await start({ respond: () => response });
    const { received } = await exchange(proxy.port, get(proxy.secret));

    expect(received).toBe(response);
  });

  test.each([
    ["without a readable status", () => "SSH-2.0-OpenSSH_9.6\r\n\r\n"],
    [
      "with a header after a bare CR",
      (realm: string) => `HTTP/1.1 200 OK\r\nX-A: b\r${challenge(realm)}\r\n\r\nok`,
    ],
    ["with a bare CR anywhere in a head", () => "HTTP/1.1 200 OK\r\nX-A: b\rc\r\n\r\nok"],
    [
      "with a NUL in a header name",
      () => "HTTP/1.1 200 OK\r\nProxy-Authen\0ticate: Basic\r\n\r\nok",
    ],
    [
      "with a proxy auth header it can't strip",
      (realm: string) => `HTTP/1.1 200 OK\r\nX-A: b\r\n ${challenge(realm)}\r\n\r\nok`,
    ],
  ])("a response %s gets a 502", async (_, respond) => {
    const proxy = await start({ respond });
    const { received } = await exchange(proxy.port, get(proxy.secret));

    expect(statusOf(received)).toBe("HTTP/1.1 502 Bad Gateway");
    expect(received).not.toContain("Proxy-Authenticate");
  });
});
