import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Schema } from "effect";
import { SessionId, WorkspaceId } from "@polaris/protocol";

export const TraceBinding = Schema.Struct({
  checkout: Schema.String,
  workspaceId: WorkspaceId,
  sessionId: Schema.NullOr(SessionId),
});

export type TraceBinding = typeof TraceBinding.Type;

const SavedBindings = Schema.Struct({
  bindings: Schema.Record(Schema.String, TraceBinding),
  exported: Schema.Record(Schema.String, Schema.Boolean),
});

const decodeBindings = Schema.decodeUnknownSync(Schema.fromJsonString(SavedBindings));

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

const key = (binding: TraceBinding) => JSON.stringify(binding);

/** Only token hashes reach disk. Old process endpoints survive a Daemon restart until revocation. */
export class TraceTokenVault {
  private saved: {
    bindings: Record<string, TraceBinding>;
    exported: Record<string, boolean>;
  } | null = null;
  private endpoints = new Map<string, string>();

  constructor(readonly filename: string | null) {}

  private load(): Record<string, TraceBinding> {
    if (this.saved === null) {
      const decoded =
        this.filename !== null && existsSync(this.filename)
          ? decodeBindings(readFileSync(this.filename, "utf8"))
          : { bindings: {}, exported: {} };

      this.saved = { bindings: { ...decoded.bindings }, exported: { ...decoded.exported } };
    }

    return this.saved.bindings;
  }

  private save(): void {
    if (this.filename === null) return;
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`;
    this.load();
    writeFileSync(temporary, JSON.stringify(this.saved), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.filename);
  }

  issue(binding: TraceBinding): string {
    const existing = this.endpoints.get(key(binding));

    if (existing !== undefined) return existing;
    const token = randomBytes(32).toString("hex");
    this.load()[hash(token)] = binding;
    this.save();
    this.endpoints.set(key(binding), token);

    return token;
  }

  authenticate(token: string): TraceBinding | null {
    return /^[a-f0-9]{64}$/.test(token) ? (this.load()[hash(token)] ?? null) : null;
  }

  userExported(sessionId: SessionId): boolean | undefined {
    this.load();

    return this.saved!.exported[sessionId];
  }

  markExported(sessionId: SessionId, exported: boolean): boolean {
    this.load();

    if (this.saved!.exported[sessionId] === exported) return false;
    this.saved!.exported[sessionId] = exported;
    this.save();

    return true;
  }

  revokeToken(token: string): void {
    const binding = this.authenticate(token);

    if (binding === null) return;
    delete this.load()[hash(token)];
    this.endpoints.delete(key(binding));
    this.save();
  }

  revokeSession(sessionId: SessionId): void {
    this.revoke((binding) => binding.sessionId === sessionId);
  }

  revokeWorkspace(workspaceId: WorkspaceId): void {
    this.revoke((binding) => binding.sessionId === null && binding.workspaceId === workspaceId);
  }

  private revoke(matches: (binding: TraceBinding) => boolean): void {
    let dirty = false;

    for (const [digest, binding] of Object.entries(this.load())) {
      if (!matches(binding)) continue;
      delete this.load()[digest];
      this.endpoints.delete(key(binding));
      dirty = true;
    }

    if (dirty) this.save();
  }
}
