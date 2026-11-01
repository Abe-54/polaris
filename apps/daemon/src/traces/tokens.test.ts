import { shortTemp } from "../platform/testing.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { SessionId, TurnId, WorkspaceId } from "@polaris/protocol";
import { TraceBinding, TraceTokenVault } from "./tokens.ts";

const sessionId = SessionId.make("one");

const workspaceId = WorkspaceId.make("workspace");

test("saved token hashes survive reload; session revocation does not revoke Workspace authority", () => {
  const root = mkdtempSync(shortTemp("t1-token-"));
  const filename = join(root, "tokens.json");

  try {
    const first = new TraceTokenVault(filename);
    const session = TraceBinding.make({ sessionId, workspaceId, checkout: "/one" });
    const workspace = TraceBinding.make({ sessionId: null, workspaceId, checkout: "/one" });
    const sessionToken = first.issue(session);
    const workspaceToken = first.issue(workspace);
    expect(readFileSync(filename, "utf8")).not.toContain(sessionToken);
    expect(readFileSync(filename, "utf8")).not.toContain(workspaceToken);

    if (process.platform !== "win32") expect(statSync(filename).mode & 0o777).toBe(0o600);
    const second = new TraceTokenVault(filename);
    expect(second.authenticate(sessionToken)).toEqual(session);
    expect(second.authenticate(workspaceToken)).toEqual(workspace);
    second.revokeSession(sessionId);
    const third = new TraceTokenVault(filename);
    expect(third.authenticate(sessionToken)).toBeNull();
    expect(third.authenticate(workspaceToken)).toEqual(workspace);
    third.revokeWorkspace(workspaceId);
    expect(new TraceTokenVault(filename).authenticate(workspaceToken)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting the private seed invalidates every endpoint on restart", () => {
  const root = mkdtempSync(shortTemp("tf1-token-"));
  const filename = join(root, "tokens.json");

  try {
    const binding = TraceBinding.make({ sessionId, workspaceId, checkout: "/one" });
    const first = new TraceTokenVault(filename).issue(binding);

    if (process.platform !== "win32") expect(statSync(`${filename}.seed`).mode & 0o777).toBe(0o600);
    rmSync(`${filename}.seed`);
    const replacement = new TraceTokenVault(filename);
    expect(replacement.authenticate(first)).toBeNull();
    const next = replacement.issue(binding);
    expect(next).not.toBe(first);
    expect(new TraceTokenVault(filename).authenticate(next)).toEqual(binding);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch endpoints survive reload, reject forged Turns and inherit parent revocation", () => {
  const root = mkdtempSync(shortTemp("p2-token-"));
  const filename = join(root, "tokens.json");

  try {
    const vault = new TraceTokenVault(filename);
    const binding = TraceBinding.make({ sessionId, workspaceId, checkout: "/one" });
    const parent = vault.issue(binding);
    const saved = readFileSync(filename, "utf8");
    const turnId = TurnId.make("turn-2");
    const child = vault.issueLaunch(parent, turnId);

    expect(child).not.toBe(vault.issueLaunch(parent, turnId));
    expect(readFileSync(filename, "utf8")).toBe(saved);

    const reloaded = new TraceTokenVault(filename);

    expect(reloaded.authenticate(child)).toEqual(binding);
    expect(reloaded.launchedTurn(child)).toBe(turnId);

    const [token, payload, signature] = child.split(".");

    const forged = Buffer.from(JSON.stringify({ turnId: "turn-5", nonce: "forged" })).toString(
      "base64url"
    );

    expect(reloaded.authenticate(`${token}.${forged}.${signature}`)).toBeNull();

    const other = reloaded.issue(
      TraceBinding.make({ ...binding, sessionId: SessionId.make("other") })
    );

    expect(reloaded.authenticate(`${other}.${payload}.${signature}`)).toBeNull();
    expect(reloaded.authenticate(`${token}.${"x".repeat(1025)}.${signature}`)).toBeNull();
    expect(reloaded.authenticate(`${child}.extra`)).toBeNull();
    expect(() => reloaded.issueLaunch(child, turnId)).toThrow("Invalid trace launch binding");

    reloaded.revokeSession(sessionId);
    expect(new TraceTokenVault(filename).authenticate(child)).toBeNull();
    reloaded.issue(binding);

    expect(reloaded.authenticate(child)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
