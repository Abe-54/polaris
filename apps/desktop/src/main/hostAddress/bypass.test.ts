import { describe, expect, test } from "bun:test";
import { BlockList, isIP } from "node:net";
import { PROXY_BYPASS_RULES } from "./bypass.ts";

/**
 * Chromium's bypass matching as observed in Electron 44: a glob rule (`*` only) matches the
 * URL's host, IPv4 literals bare and IPv6 literals in brackets; a CIDR rule only IP literals.
 */
const rules = PROXY_BYPASS_RULES.split(",");

const cidrs = new BlockList();

const globs: Array<RegExp> = [];

for (const rule of rules.slice(1)) {
  const [address, prefix] = rule.split("/");

  if (prefix !== undefined)
    cidrs.addSubnet(address!, Number(prefix), isIP(address!) === 6 ? "ipv6" : "ipv4");
  else globs.push(new RegExp(`^${rule.replace(/[.\-_]/g, "\\$&").replace(/\*/g, ".*")}$`));
}

/** Whether Chromium loads `host` directly rather than through the proxy. */
const bypassed = (raw: string) => {
  const host = new URL(`http://${raw}/`).hostname;
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  const family = isIP(bare);

  if (family !== 0 && cidrs.check(bare, family === 6 ? "ipv6" : "ipv4")) return true;

  return globs.some((glob) => glob.test(host));
};

/** The Host-address shape: `localhost` as the last label, optionally with a trailing dot. */
const isLocalhostName = (host: string) => /(^|\.)localhost\.?$/.test(host);

/** The host Chromium would see, or null when the URL parser refuses it. */
const canonical = (raw: string) => {
  try {
    return raw === "" ? null : new URL(`http://${raw}/`).hostname;
  } catch {
    return null;
  }
};

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-_.";

/** A seeded generator, so a failure replays. */
const random = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;

  return seed / 2 ** 31;
};

const randomName = (next: () => number) => {
  const pieces = ["localhost", "ocalhost", "host", ".", "t", "lo"];
  let name = "";

  for (let i = 0, n = 1 + Math.floor(next() * 6); i < n; i++)
    name +=
      next() < 0.3
        ? pieces[Math.floor(next() * pieces.length)]
        : CHARS[Math.floor(next() * CHARS.length)];

  return name.replace(/^\.+/, "").replace(/\.{2,}/g, ".");
};

describe("the bypass rules", () => {
  test("starts with <-loopback>, or Chromium bypasses loopback before the rules", () => {
    expect(rules[0]).toBe("<-loopback>");
  });

  test.each([
    "localhost",
    "app.localhost",
    "a.b-c.localhost",
    "localhost.",
    "app.localhost.",
    "127.0.0.1",
    "127.1.2.3",
    "[::1]",
    "[0:0:0:0:0:0:0:1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f01:ab]",
    "0.0.0.0",
  ])("%s goes to the proxy", (host) => {
    expect(bypassed(host)).toBe(false);
  });

  test.each([
    "example.com",
    "github.com",
    "fonts.googleapis.com",
    "localhost.example.com",
    "xlocalhost",
    "my-localhost",
    "localhostx",
    "ocalhost",
    "host",
    "t",
    "example.com.",
    "xn--80ak6aa92e.xn--p1ai",
    "10.0.0.1",
    "192.168.1.20",
    "8.8.8.8",
    "126.255.255.255",
    "128.0.0.1",
    "[2001:db8::1]",
    "[fe80::1]",
  ])("%s loads directly", (host) => {
    expect(bypassed(host)).toBe(true);
  });

  test("never bypasses a localhost name, and bypasses every other name ending in a letter", () => {
    const next = random(7);

    for (let i = 0; i < 20_000; i++) {
      const name = canonical(randomName(next));

      if (name === null || isIP(name.replace(/^\[|\]$/g, "")) !== 0 || /\d\.?$/.test(name))
        continue;
      expect([name, bypassed(name)]).toEqual([name, !isLocalhostName(name)]);
    }
  });

  test("bypasses every IPv4 literal outside 0.0.0.0/8 and 127.0.0.0/8", () => {
    for (let first = 0; first < 256; first++) {
      const address = `${first}.${first % 7}.3.${255 - first}`;

      expect([address, bypassed(address)]).toEqual([address, first !== 0 && first !== 127]);
    }
  });
});
