import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { SessionId, WorkspaceId } from "@polaris/protocol";
import { TraceBinding, TraceTokenVault } from "./tokens.ts";

const sessionId = SessionId.make("one");

const workspaceId = WorkspaceId.make("workspace");

test("saved token hashes survive reload; session revocation does not revoke Workspace authority", () => {
  const root = mkdtempSync("/tmp/t1-token-");
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
  const root = mkdtempSync("/tmp/tf1-token-");
  const filename = join(root, "tokens.json");

  try {
    const binding = TraceBinding.make({ sessionId, workspaceId, checkout: "/one" });
    const first = new TraceTokenVault(filename).issue(binding);
    expect(statSync(`${filename}.seed`).mode & 0o777).toBe(0o600);
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
