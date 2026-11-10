import { expect, test } from "bun:test";
import manifest from "../app.json" with { type: "json" };
import { BadHost, hostsFromArgs, withWhitelist } from "./manifest.ts";

test("whitelists https and wss for a bare host, and an origin as given", () => {
  const built = withWhitelist(
    manifest,
    hostsFromArgs([
      "--host",
      "mac.tail1.ts.net",
      "--host=ws://127.0.0.1:7477",
      "--host",
      "mac.tail1.ts.net",
    ]),
    "1.2.3"
  );

  expect(built.version).toBe("1.2.3");
  expect(built.permissions.find((p) => p.name === "network")?.whitelist).toEqual([
    "https://mac.tail1.ts.net",
    "wss://mac.tail1.ts.net",
    "ws://127.0.0.1:7477",
  ]);
  expect(built.permissions.map((p) => p.name)).toContain("g2-microphone");
});

test("refuses what isn't a host or a web origin", () => {
  expect(() => withWhitelist(manifest, ["ftp://mac"], "1.0.0")).toThrow(BadHost);
  expect(() => withWhitelist(manifest, ["https://user:pw@mac"], "1.0.0")).toThrow(BadHost);
  expect(() => withWhitelist(manifest, ["not a host"], "1.0.0")).toThrow(BadHost);
});

test.each([
  "*",
  "*.ts.net",
  "https://*.tail1.ts.net",
  "wss://*",
  "mac*.tail1.ts.net",
  "%2A.tail1.ts.net",
  "https://mac.tail1.ts.net/polaris",
  "https://mac.tail1.ts.net/?token=1",
  "https://mac.tail1.ts.net/#frag",
])("refuses a wildcard or a non-origin: %s", (host) => {
  expect(() => withWhitelist(manifest, [host], "1.0.0")).toThrow(BadHost);
});

test("keeps exact Tailscale, loopback and local development origins", () => {
  const built = withWhitelist(
    manifest,
    ["mac.tail1.ts.net:8443", "http://localhost:5173/", "ws://[::1]:7477", "http://100.64.0.7"],
    "1.0.0"
  );

  expect(built.permissions.find((p) => p.name === "network")?.whitelist).toEqual([
    "https://mac.tail1.ts.net:8443",
    "wss://mac.tail1.ts.net:8443",
    "http://localhost:5173",
    "ws://[::1]:7477",
    "http://100.64.0.7",
  ]);
});
