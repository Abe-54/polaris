import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
  GATEWAY_DEFAULT_PORT,
  configuredGatewayPort,
  newGatewaySecret,
  readGatewayRecord,
  removeGatewayRecord,
  writeGatewayRecord,
} from "./config.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

const withRoot = async (body: (root: string) => Promise<void>) => {
  const root = newTempDir("pl-gw-cfg-", { short: true });

  try {
    await body(root);
  } finally {
    removeTempDir(root);
  }
};

const portFor = (configPath: string, env: Record<string, string | undefined> = {}) =>
  Effect.runPromise(configuredGatewayPort(configPath, env));

test("the port comes from the environment, then daemon.json, then the default", () =>
  withRoot(async (root) => {
    const config = join(root, "daemon.json");
    expect(await portFor(config)).toBe(GATEWAY_DEFAULT_PORT);

    writeFileSync(config, JSON.stringify({ gateway: { port: 8123 } }));
    expect(await portFor(config)).toBe(8123);
    expect(await portFor(config, { POLARIS_GATEWAY_PORT: "0" })).toBe(0);

    writeFileSync(config, JSON.stringify({ gateway: {} }));
    expect(await portFor(config)).toBe(GATEWAY_DEFAULT_PORT);
  }));

test("a port that is not one is ignored, in the environment and in daemon.json", () =>
  withRoot(async (root) => {
    const config = join(root, "daemon.json");
    writeFileSync(config, JSON.stringify({ gateway: { port: 70000 } }));
    expect(await portFor(config, { POLARIS_GATEWAY_PORT: "websocket" })).toBe(GATEWAY_DEFAULT_PORT);
    writeFileSync(config, "{ not json");
    expect(await portFor(config, { POLARIS_GATEWAY_PORT: "-1" })).toBe(GATEWAY_DEFAULT_PORT);
    expect(await portFor(config, { POLARIS_GATEWAY_PORT: "7.5" })).toBe(GATEWAY_DEFAULT_PORT);
  }));

test("gateway.json is {port, secret}, private to the user in a private directory, and gone once removed", () =>
  withRoot(async (root) => {
    const record = join(root, "private", "gateway.json");
    const secret = newGatewaySecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newGatewaySecret()).not.toBe(secret);
    writeGatewayRecord(record, { port: 7477, secret });
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ port: 7477, secret });
    expect(readGatewayRecord(record)).toEqual({ port: 7477, secret });

    if (process.platform !== "win32") {
      expect(statSync(record).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700);
    }

    writeGatewayRecord(record, { port: 7478, secret });
    expect(readGatewayRecord(record)?.port).toBe(7478);
    writeFileSync(record, JSON.stringify({ port: 7478 }));
    expect(readGatewayRecord(record)).toBeNull();
    writeFileSync(record, JSON.stringify({ port: 7478, nonce: secret }));
    expect(readGatewayRecord(record)).toBeNull();
    writeFileSync(record, JSON.stringify({ port: 7478, secret: "not a secret" }));
    expect(readGatewayRecord(record)).toBeNull();
    removeGatewayRecord(record);
    removeGatewayRecord(record);
    expect(readGatewayRecord(record)).toBeNull();
  }));
