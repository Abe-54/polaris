import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConstellationId, DomainEvent, SessionId, WorkspaceId } from "@polaris/protocol";
import { McpBinding } from "./binding.ts";
import { revokeMcpBindings } from "./revoke.ts";
import { Effect } from "effect";
import { McpTokens } from "./tokens.ts";
import { leadBinding, workerBinding } from "./testing.ts";

test("only token hashes persist; restart keeps credentials and revocation", async () => {
  const root = newTempDir("polaris-mcp-", { short: true });
  const path = join(root, "tokens.sqlite");

  const plainBinding = McpBinding.cases.Plain.make({
    sessionId: SessionId.make("plain"),
    constellationId: leadBinding.constellationId,
    workspaceId: WorkspaceId.make("workspace"),
  });

  try {
    const issued = await Effect.runPromise(
      Effect.gen(function* () {
        const tokens = yield* McpTokens;
        const worker = yield* tokens.issue(workerBinding);
        const lead = yield* tokens.issue(leadBinding);
        const plain = yield* tokens.issue(plainBinding);
        expect(worker).toMatch(/^[a-f0-9]{64}$/);
        expect(yield* tokens.authenticate(worker)).toEqual(workerBinding);
        expect(yield* tokens.authenticate("bad-token")).toBeNull();
        expect(yield* tokens.authenticate("0".repeat(64))).toBeNull();

        return { worker, lead, plain };
      }).pipe(Effect.provide(McpTokens.layer(path)))
    );

    const disk = readFileSync(path);
    expect(disk.includes(Buffer.from(issued.worker))).toBe(false);
    expect(disk.includes(Buffer.from(issued.lead))).toBe(false);
    expect(disk.includes(Buffer.from(issued.plain))).toBe(false);

    // Windows has no mode bits; the file's ACL is ENG-314's.
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    await Effect.runPromise(
      Effect.gen(function* () {
        const tokens = yield* McpTokens;
        expect(yield* tokens.authenticate(issued.worker)).toEqual(workerBinding);
        yield* tokens.revokeAttempt(workerBinding.attemptId);
        expect(yield* tokens.authenticate(issued.worker)).toBeNull();
        expect(yield* tokens.authenticate(issued.lead)).toEqual(leadBinding);
        expect(yield* tokens.authenticate(issued.plain)).toEqual(plainBinding);
        yield* tokens.revokeSession(leadBinding.sessionId);
        yield* tokens.revokeSession(plainBinding.sessionId);
      }).pipe(Effect.provide(McpTokens.layer(path)))
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const tokens = yield* McpTokens;
        expect(yield* tokens.authenticate(issued.lead)).toBeNull();
        expect(yield* tokens.authenticate(issued.worker)).toBeNull();
        expect(yield* tokens.authenticate(issued.plain)).toBeNull();
      }).pipe(Effect.provide(McpTokens.layer(path)))
    );
  } finally {
    removeTempDir(root);
  }
});

test("committed lifecycle events revoke only matching bindings, keep a closed Lead and replay safely", async () => {
  const root = newTempDir("polaris-mcp-events-", { short: true });

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const tokens = yield* McpTokens;
        const worker = yield* tokens.issue(workerBinding);
        const lead = yield* tokens.issue(leadBinding);

        const settled = DomainEvent.cases.AttemptSettled.make({
          constellationId: workerBinding.constellationId,
          attemptId: workerBinding.attemptId,
          attemptRevision: 2,
          revision: 4,
          outcome: "failed",
          reason: "Harness failed",
        });

        yield* revokeMcpBindings(settled);
        yield* revokeMcpBindings(settled);
        expect(yield* tokens.authenticate(worker)).toBeNull();
        expect(yield* tokens.authenticate(lead)).toEqual(leadBinding);
        yield* revokeMcpBindings(
          DomainEvent.cases.LeadChanged.make({
            constellationId: leadBinding.constellationId,
            revision: 5,
            from: leadBinding.sessionId,
            to: SessionId.make("new-lead"),
            summary: "Continue",
          })
        );
        expect(yield* tokens.authenticate(lead)).toBeNull();
        const archived = yield* tokens.issue(workerBinding);
        yield* revokeMcpBindings(
          DomainEvent.cases.SessionStateChanged.make({
            sessionId: workerBinding.sessionId,
            state: "archived",
            reason: null,
          })
        );
        expect(yield* tokens.authenticate(archived)).toBeNull();
        const archivedLead = yield* tokens.issue(leadBinding);
        const archivedWorker = yield* tokens.issue(workerBinding);

        const archive = DomainEvent.cases.ConstellationStateChanged.make({
          constellationId: leadBinding.constellationId,
          revision: 6,
          state: "archived",
        });

        yield* revokeMcpBindings(archive);
        expect(yield* tokens.authenticate(archivedWorker)).toBeNull();

        const closed = yield* tokens.authenticate(archivedLead);

        const next = ConstellationId.make(
          closed !== null && McpBinding.isAnyOf(["Lead"])(closed) ? (closed.next ?? "") : ""
        );

        expect(next).not.toBe(leadBinding.constellationId);
        expect(closed).toEqual(McpBinding.cases.Lead.make({ ...leadBinding, next }));
        yield* revokeMcpBindings(archive);
        expect(yield* tokens.authenticate(archivedLead)).toEqual(closed);
        yield* tokens.advanceLeads(leadBinding.sessionId, ConstellationId.make("other"));
        expect(yield* tokens.authenticate(archivedLead)).toEqual(closed);
        yield* tokens.advanceLeads(leadBinding.sessionId, next);
        expect(yield* tokens.authenticate(archivedLead)).toEqual(
          McpBinding.cases.Lead.make({
            sessionId: leadBinding.sessionId,
            constellationId: next,
          })
        );
      }).pipe(Effect.provide(McpTokens.layer(join(root, "tokens.sqlite"))))
    );
  } finally {
    removeTempDir(root);
  }
});
