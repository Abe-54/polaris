import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  decodePairingString,
  encodePairingString,
  HostId,
  Pairing,
  PairingId,
} from "@polaris/protocol";
import { localEndpoint } from "@polaris/protocol/endpoint";
import { Option } from "effect";
import { type ExtensionCommand, formatPaired, formatPairings, parseExtensionArgs } from "./cli.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

test("a terminal still prints the pairing string when it exceeds QR capacity", () => {
  const name = "Phone shortcuts ".repeat(400);

  const pairing = new Pairing({
    id: PairingId.make("pair_1"),
    name,
    grant: ["read"],
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  });

  const pairingString = encodePairingString({
    hostId: HostId.make("h1"),
    hostName: "mac-studio",
    url: null,
    token: "pol_ext_token",
    name,
  });

  expect(formatPaired({ pairing, pairingString }, true).split("\n").at(-1)).toBe(pairingString);
});

test("list escapes terminal controls and bidirectional formatting in Pairing names", () => {
  const output = formatPairings([
    new Pairing({
      id: PairingId.make("pair_1"),
      name: "Raycast\u001b]52;c;clipboard\u0007\n\u202eevil",
      grant: ["read"],
      createdAt: "2026-10-01T00:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    }),
  ]);

  expect(output).toBe(
    "pair_1  ·  Raycast\\u001b]52;c;clipboard\\u0007\\u000a\\u202eevil  ·  read  ·  not used yet"
  );
});

test.each<[ReadonlyArray<string>, ExtensionCommand | string]>([
  [
    ["pair", "--name", "Raycast", "--allow", "read,approve,turn"],
    { kind: "pair", name: "Raycast", grant: ["read", "approve", "turn"] },
  ],
  [
    ["pair", "--allow", "voice", "--name", "Even G2"],
    { kind: "pair", name: "Even G2", grant: ["voice"] },
  ],
  [["list"], { kind: "list" }],
  [["revoke", "pair_1"], { kind: "revoke", id: PairingId.make("pair_1") }],
  [["pair", "--name", "Raycast", "--allow", "read,write"], 'unknown grant "write"'],
  [["pair", "--name", "Raycast"], "--allow is required"],
  [["pair", "--allow", "read"], "--name is required"],
  [["pair", "--name", "Raycast", "--allow", "read", "--force"], "unexpected --force"],
  [["revoke"], "revoke takes one pairing id"],
  [["remove", "pair_1"], 'unknown command "remove"'],
])("polaris extension %j", (args, expected) => {
  expect(parseExtensionArgs(args)).toEqual(expected);
});

const cli = async (main: string, env: Record<string, string | undefined>, args: string[]) => {
  const child = Bun.spawn([process.execPath, main, "extension", ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    code: await child.exited,
    out: await new Response(child.stdout).text(),
    err: await new Response(child.stderr).text(),
  };
};

test("the real CLI pairs, lists and revokes through an isolated Daemon", async () => {
  const home = newTempDir("polaris-ext-cli-", { short: true });
  const main = resolve(import.meta.dir, "../main.ts");

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    POLARIS_HOME: home,
    POLARIS_HOST_SOCKET: localEndpoint(home),
    POLARIS_BENCH_HARNESS: "1",
    POLARIS_SESSION_ID: undefined,
    POLARIS_BINARY: undefined,
  };

  const daemon = Bun.spawn([process.execPath, main, "serve", "--foreground"], {
    env,
    stdout: "pipe",
    stderr: "ignore",
  });

  try {
    const reader = daemon.stdout.getReader();
    let logs = "";

    while (!logs.includes("Daemon listening on")) {
      const chunk = await reader.read();

      if (chunk.done) throw new Error(`Daemon stopped: ${logs}`);
      logs += new TextDecoder().decode(chunk.value);
    }

    reader.releaseLock();

    const paired = await cli(main, env, ["pair", "--name", "Raycast", "--allow", "read,approve"]);
    expect(paired.code).toBe(0);
    const pairingString = paired.out.trim().split("\n").at(-1) ?? "";
    const payload = Option.getOrThrow(decodePairingString(pairingString));
    expect(payload).toMatchObject({ name: "Raycast", url: null });
    expect(payload.token).toMatch(/^pol_ext_/);

    const id = /\((pair_[^)]+)\)/.exec(paired.out)?.[1] ?? "";
    const listed = await cli(main, env, ["list"]);
    expect(listed.out).toContain(`${id}  ·  Raycast  ·  read, approve  ·  not used yet`);
    expect(listed.out + listed.err + paired.err).not.toContain(payload.token);

    expect((await cli(main, env, ["revoke", id])).out).toContain(`Revoked Raycast (${id}).`);
    expect((await cli(main, env, ["list"])).out).toMatch(new RegExp(`${id}.*revoked `));

    const missing = await cli(main, env, ["revoke", "pair_nope"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("no pairing pair_nope on this host");

    const unsafeName = "Phone\u001b]52;c;clipboard\u0007\n\u202ename";
    const unsafe = await cli(main, env, ["pair", "--name", unsafeName, "--allow", "read"]);
    expect(unsafe.code).toBe(0);
    expect(unsafe.out).toContain("Paired Phone\\u001b]52;c;clipboard\\u0007\\u000a\\u202ename");
    const unsafeId = /\((pair_[^)]+)\)/.exec(unsafe.out)?.[1] ?? "";
    const revoked = await cli(main, env, ["revoke", unsafeId]);
    expect(revoked.out).toContain("Revoked Phone\\u001b]52;c;clipboard\\u0007\\u000a\\u202ename");

    const unsafePayload = Option.getOrThrow(
      decodePairingString(unsafe.out.trim().split("\n").at(-1) ?? "")
    );

    expect(unsafePayload.name).toBe(unsafeName);
    expect(revoked.out + revoked.err).not.toContain(unsafePayload.token);
    const invalid = await cli(main, env, ["bad\u001b[2J\ncommand"]);
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain('unknown command "bad\\u001b[2J\\u000acommand"');
  } finally {
    daemon.kill("SIGTERM");
    await daemon.exited;
    await removeTempDirSettled(home);
  }
}, 30000);
