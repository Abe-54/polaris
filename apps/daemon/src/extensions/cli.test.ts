import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { encodePairingString, HostId, Pairing, PairingId } from "@polaris/protocol";
import { localEndpoint } from "@polaris/protocol/endpoint";
import { connectRpc, socketTransport } from "@polaris/client";
import { Effect } from "effect";
import { type ExtensionCommand, formatPaired, formatPairings, parseExtensionArgs } from "./cli.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";
import { TEST_USER_KEY } from "../transport/userAccess.testing.ts";

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

test("the real CLI pairs, lists and revokes through an isolated Daemon, as the Desktop App does", async () => {
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

    // The Desktop App pairs too, with its user key, which the Daemon no longer checks (ADR 0110).
    const desktopPair = (name: string) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* socketTransport(localEndpoint(home));
            const { client } = yield* connectRpc(transport);
            yield* client.hello({
              clientName: "test",
              clientVersion: "0",
              deviceLabel: "test",
              capabilities: [],
              ...TEST_USER_KEY,
            });

            return yield* client["extensions.pair"]({ name, grant: ["read", "approve"] });
          })
        )
      );

    const cliPair = await cli(main, env, ["pair", "--name", "Agent", "--allow", "approve"]);
    expect(cliPair.code).toBe(0);
    expect(cliPair.out).toContain("Paired Agent (");

    const raycast = await desktopPair("Raycast");
    const unsafeName = "Phone\u001b]52;c;clipboard\u0007\n\u202ename";
    const unsafe = await desktopPair(unsafeName);

    const listed = await cli(main, env, ["list"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(
      `${raycast.pairing.id}  ·  Raycast  ·  read, approve  ·  not used yet`
    );
    expect(listed.out).toContain("Phone\\u001b]52;c;clipboard\\u0007\\u000a\\u202ename");
    expect(listed.out + listed.err).not.toContain(raycast.token);
    expect(listed.out).not.toContain(unsafe.token);

    const revoked = await cli(main, env, ["revoke", raycast.pairing.id]);
    expect(revoked.out).toContain(`Revoked Raycast (${raycast.pairing.id}).`);

    expect((await cli(main, env, ["list"])).out).toMatch(
      new RegExp(`${raycast.pairing.id}.*revoked `)
    );

    const invalid = await cli(main, env, ["bad\u001b[2J\ncommand"]);
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain('unknown command "bad\\u001b[2J\\u000acommand"');
  } finally {
    daemon.kill("SIGTERM");
    await daemon.exited;
    await removeTempDirSettled(home);
  }
}, 30000);
