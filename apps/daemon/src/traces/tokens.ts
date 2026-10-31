import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

const Entry = Schema.Struct({
  binding: TraceBinding,
  epoch: Schema.Number,
  active: Schema.Boolean,
});

const SavedBindings = Schema.Struct({
  bindings: Schema.Record(Schema.String, Entry),
  exported: Schema.Record(Schema.String, Schema.Boolean),
});

const decodeBindings = Schema.decodeUnknownSync(Schema.fromJsonString(SavedBindings));

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

const key = (binding: TraceBinding) =>
  JSON.stringify([binding.checkout, binding.workspaceId, binding.sessionId]);

const loadSeed = (filename: string) => {
  const existed = existsSync(filename);

  if (!existed) {
    try {
      writeFileSync(filename, randomBytes(32), { mode: 0o600, flag: "wx" });
    } catch (cause) {
      if (!existsSync(filename)) throw cause;
    }
  }

  const seed = readFileSync(filename);

  if (seed.byteLength !== 32) throw new Error("Invalid trace token seed");

  return { seed, existed };
};

/** A private seed derives stable endpoints; persisted epochs fence every revocation. */
export class TraceTokenVault {
  private saved: {
    bindings: Record<string, typeof Entry.Type>;
    exported: Record<string, boolean>;
  } | null = null;
  private seed: Buffer | null = null;
  private lookup = new Map<string, string>();

  constructor(readonly filename: string | null) {}

  private token(bindingKey: string, epoch: number): string {
    return createHmac("sha256", this.seed!)
      .update(JSON.stringify([bindingKey, epoch]))
      .digest("hex");
  }

  private load() {
    if (this.saved !== null) return this.saved;

    if (this.filename === null) {
      this.seed = randomBytes(32);
      this.saved = { bindings: {}, exported: {} };

      return this.saved;
    }

    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    const { seed, existed } = loadSeed(`${this.filename}.seed`);
    this.seed = seed;
    // Losing the seed revokes all previous endpoints, including legacy hash-only bindings.
    this.saved =
      existed && existsSync(this.filename)
        ? decodeBindings(readFileSync(this.filename, "utf8"))
        : { bindings: {}, exported: {} };

    if (!existed && existsSync(this.filename)) this.save();

    for (const [bindingKey, entry] of Object.entries(this.saved.bindings)) {
      if (entry.active) this.lookup.set(hash(this.token(bindingKey, entry.epoch)), bindingKey);
    }

    return this.saved;
  }

  private save(): void {
    if (this.filename === null) return;
    const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.load()), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.filename);
  }

  issue(binding: TraceBinding): string {
    const saved = this.load();
    const bindingKey = key(binding);
    const previous = saved.bindings[bindingKey];

    if (previous?.active) return this.token(bindingKey, previous.epoch);
    const entry = { binding, epoch: previous?.epoch ?? 0, active: true };
    saved.bindings[bindingKey] = entry;
    const token = this.token(bindingKey, entry.epoch);
    this.save();
    this.lookup.set(hash(token), bindingKey);

    return token;
  }

  authenticate(token: string): TraceBinding | null {
    const saved = this.load();

    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const bindingKey = this.lookup.get(hash(token));

    if (bindingKey === undefined) return null;
    const entry = saved.bindings[bindingKey]!;

    return entry.active &&
      timingSafeEqual(
        Buffer.from(token, "hex"),
        Buffer.from(this.token(bindingKey, entry.epoch), "hex")
      )
      ? entry.binding
      : null;
  }

  userExported(sessionId: SessionId): boolean | undefined {
    return this.load().exported[sessionId];
  }

  markExported(sessionId: SessionId, exported: boolean): boolean {
    const saved = this.load();

    if (saved.exported[sessionId] === exported) return false;
    saved.exported[sessionId] = exported;
    this.save();

    return true;
  }

  revokeToken(token: string): void {
    const binding = this.authenticate(token);

    if (binding !== null) this.revoke((candidate) => key(candidate) === key(binding));
  }

  revokeSession(sessionId: SessionId): void {
    const saved = this.load();
    const hadExported = sessionId in saved.exported;
    delete saved.exported[sessionId];
    this.revoke((binding) => binding.sessionId === sessionId, hadExported);
  }

  revokeWorkspace(workspaceId: WorkspaceId): void {
    this.revoke((binding) => binding.workspaceId === workspaceId);
  }

  /** Reconcile once at startup and after lifecycle events, including missed events during downtime. */
  prune(
    activeSession: (id: SessionId) => boolean,
    activeWorkspace: (id: WorkspaceId) => boolean
  ): void {
    const saved = this.load();
    let dirty = false;

    for (const id of Object.keys(saved.exported)) {
      if (!activeSession(SessionId.make(id))) {
        delete saved.exported[id];
        dirty = true;
      }
    }

    this.revoke(
      (binding) =>
        !activeWorkspace(binding.workspaceId) ||
        (binding.sessionId !== null && !activeSession(binding.sessionId)),
      dirty
    );
  }

  private revoke(matches: (binding: TraceBinding) => boolean, dirty = false): void {
    for (const [bindingKey, entry] of Object.entries(this.load().bindings)) {
      if (!entry.active || !matches(entry.binding)) continue;
      this.lookup.delete(hash(this.token(bindingKey, entry.epoch)));
      this.saved!.bindings[bindingKey] = { ...entry, epoch: entry.epoch + 1, active: false };
      dirty = true;
    }

    if (dirty) this.save();
  }
}
