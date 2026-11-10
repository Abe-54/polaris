import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { LoopbackConnectError } from "../transport/bunSocket.ts";
import { parseHostsFile } from "./etcHosts.ts";
import { HostAddressStreams } from "./hostAddressStreams.ts";

const HOSTS = `
# Portless and a custom domain
127.0.0.1\tlocalhost
255.255.255.255 broadcasthost
::1             localhost ip6-loopback
127.0.0.1 app.test API.Test.   # trailing comment
127.0.1.1 lucas-box
::1 app.test
::ffff:127.0.0.1 mapped.test
192.168.1.20 nas.lan
10.0.0.1 127.0.0.1 #127.0.0.1 commented.test
127.0.0.1 1.2.3.4 bad!name
`;

describe("parseHostsFile", () => {
  test("keeps loopback names with their addresses in file order, nothing else", () => {
    expect(Object.fromEntries(parseHostsFile(HOSTS))).toEqual({
      "ip6-loopback": ["::1"],
      "app.test": ["127.0.0.1", "::1"],
      "api.test": ["127.0.0.1"],
      "lucas-box": ["127.0.0.1"],
    });
  });

  test("CRLF line endings parse the same", () => {
    expect([...parseHostsFile("127.0.0.1 app.test\r\n::1 app.test\r\n").keys()]).toEqual([
      "app.test",
    ]);
  });
});

/** A connector that records each address and refuses it, so `connect` tries the next. */
const refusing = () => {
  const tried: Array<string> = [];

  return {
    tried,
    connector: (address: string) => {
      tried.push(address);

      return Effect.fail(new LoopbackConnectError("refused", "nothing listens"));
    },
  };
};

const connectTo = (hostname: string, hosts: string) => {
  const { tried, connector } = refusing();
  const streams = HostAddressStreams.make(connector, Effect.succeed(hosts));
  const exit = Effect.runSyncExit(Effect.scoped(streams.connect({ hostname, port: 3000 })));

  return { tried, exit };
};

describe("HostAddressStreams and the hosts file", () => {
  test("a hosts-file loopback name connects to the addresses the file gives it", () => {
    const { tried, exit } = connectTo("App.Test.", HOSTS);

    expect(tried).toEqual(["127.0.0.1", "::1"]);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("a name the file maps elsewhere is refused before any connect", () => {
    const { tried, exit } = connectTo("nas.lan", HOSTS);

    expect(tried).toEqual([]);
    expect(JSON.stringify(exit)).toContain("not-host-address");
  });

  test("names lists the file's loopback names, read on each request", async () => {
    let text = "127.0.0.1 one.test";

    const streams = HostAddressStreams.make(
      refusing().connector,
      Effect.sync(() => text)
    );

    expect(await Effect.runPromise(streams.names)).toEqual(["one.test"]);
    text = "127.0.0.1 two.test";
    expect(await Effect.runPromise(streams.names)).toEqual(["two.test"]);
  });
});
