import { expect, test } from "bun:test";
import {
  originLocality,
  parseOrigin,
  tcpConnect,
  type ConnectProbe,
  type OwnerLookup,
} from "./locality.ts";

const owned =
  (...executables: string[]): OwnerLookup =>
  async () =>
    executables.map((executable, index) => ({ pid: 100 + index, executable }));

// Something answers on the port: only its owner can make it Local.
const accepting: ConnectProbe = async () => "accepted";

const cases: ReadonlyArray<[string, OwnerLookup, "local" | "remote"]> = [
  ["a node dev server", owned("/opt/homebrew/bin/node"), "local"],
  ["Docker's port proxy", owned("/usr/bin/docker-proxy"), "local"],
  ["Docker Desktop's backend", owned("/Applications/Docker.app/com.docker.backend"), "local"],
  ["cloudflared", owned("/opt/homebrew/bin/cloudflared"), "remote"],
  ["ssh -L", owned("/usr/bin/ssh"), "remote"],
  ["kubectl port-forward", owned("/usr/local/bin/kubectl"), "remote"],
  ["ngrok on Windows paths", owned("C:\\Tools\\NGROK.EXE"), "remote"],
  ["flyctl proxy", owned("/Users/me/.fly/bin/flyctl"), "remote"],
  ["tailscale serve", owned("/usr/sbin/tailscaled"), "remote"],
  ["node alongside a tunnel", owned("/usr/bin/node", "/usr/bin/ssh"), "remote"],
  ["an owner whose executable can't be read", owned(""), "remote"],
  ["an accepting listener with no visible owner", owned(), "remote"],
  [
    "a lookup that fails",
    async () => {
      throw new Error("lsof missing");
    },
    "remote",
  ],
];

for (const [name, owners, expected] of cases)
  test(`loopback served by ${name} is ${expected}`, async () => {
    expect(
      await originLocality(
        { hostname: "localhost", port: 8787 },
        { owners, connect: accepting, platform: "darwin" }
      )
    ).toBe(expected);
  });

test("every loopback spelling is checked against its listener; other hosts never are", async () => {
  const seen: string[] = [];

  const lookup: OwnerLookup = async ({ hostname, port }) => {
    seen.push(`${hostname}:${port}`);

    return [{ pid: 1, executable: "/usr/bin/node" }];
  };

  for (const url of ["http://localhost:3000", "http://127.0.0.9:3000", "http://[::1]:3000"])
    expect(await originLocality(parseOrigin(url)!, { owners: lookup, platform: "darwin" })).toBe(
      "local"
    );

  for (const url of ["http://0.0.0.0:3000", "https://api.example.com", "http://10.0.0.2:3000"])
    expect(await originLocality(parseOrigin(url)!, { owners: lookup, platform: "darwin" })).toBe(
      "remote"
    );

  expect(seen).toEqual(["localhost:3000", "127.0.0.9:3000", "[::1]:3000"]);
});

test("an origin always names its port; paths keep the query", () => {
  expect(parseOrigin("https://API.example.com/v1/users?page=2")).toEqual({
    origin: "https://api.example.com:443",
    hostname: "api.example.com",
    port: 443,
    path: "/v1/users?page=2",
  });
  expect(parseOrigin("http://localhost")?.origin).toBe("http://localhost:80");
  expect(parseOrigin("ftp://example.com/file")).toBeUndefined();
  expect(parseOrigin("/relative")).toBeUndefined();
});

test("a *.localhost name is loopback: its owner is looked up on 127.0.0.1", async () => {
  const seen: string[] = [];

  const lookup: OwnerLookup = async ({ hostname, port }) => {
    seen.push(`${hostname}:${port}`);

    return [{ pid: 1, executable: "/usr/bin/node" }];
  };

  const origin = parseOrigin("http://api.localhost:4000/v1")!;
  expect(await originLocality(origin, { owners: lookup, platform: "darwin" })).toBe("local");
  expect(seen).toEqual(["127.0.0.1:4000"]);
  expect(await originLocality(origin, { owners: owned("/usr/bin/ssh"), platform: "darwin" })).toBe(
    "remote"
  );
});

test("a real loopback port: refused is Local, accepting with no visible owner is Remote", async () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = server;
  const probes = { owners: owned(), connect: tcpConnect, platform: "darwin" as const };

  try {
    expect(await originLocality({ hostname: "127.0.0.1", port }, probes)).toBe("remote");
  } finally {
    server.stop(true);
  }

  expect(await originLocality({ hostname: "127.0.0.1", port }, probes)).toBe("local");
});

test("localhost is refused only when both families refuse", async () => {
  const v6Only: ConnectProbe = async (host) => (host === "::1" ? "accepted" : "refused");
  const probes = { owners: owned(), platform: "darwin" as const };

  expect(
    await originLocality({ hostname: "localhost", port: 4000 }, { ...probes, connect: v6Only })
  ).toBe("remote");
  expect(
    await originLocality(
      { hostname: "localhost", port: 4000 },
      { ...probes, connect: async () => "refused" }
    )
  ).toBe("local");
});

test("Windows loopback stays Remote, whatever listens", async () => {
  for (const connect of [accepting, (async () => "refused") satisfies ConnectProbe])
    expect(
      await originLocality(
        { hostname: "localhost", port: 4000 },
        { owners: owned("C:\\node.exe"), connect, platform: "win32" }
      )
    ).toBe("remote");
});
