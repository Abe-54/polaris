/**
 * Which Simulators Polaris booted, kept across Daemon restarts in one small JSON file: only
 * these are shut down when the hub idles out, or by `simulator.shutdown` without `force`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Option, Schema } from "effect";

const BootedFile = Schema.fromJsonString(Schema.Struct({ ids: Schema.Array(Schema.String) }));

const decode = Schema.decodeUnknownOption(BootedFile);

export class BootedStore {
  private readonly ids: Set<string>;

  constructor(private readonly path: string) {
    let text: string | null = null;

    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = null;
    }

    const file = text === null ? null : Option.getOrNull(decode(text));
    this.ids = new Set(file?.ids ?? []);
  }

  get all(): ReadonlySet<string> {
    return this.ids;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.save();
  }

  delete(id: string): void {
    if (this.ids.delete(id)) this.save();
  }

  /** Forgets every id `shutDown` holds: once shut down, a later boot is someone else's. */
  forgetShutDown(shutDown: Iterable<string>): void {
    let changed = false;

    for (const id of shutDown) changed = this.ids.delete(id) || changed;

    if (changed) this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const staging = `${this.path}.tmp`;
    writeFileSync(staging, JSON.stringify({ ids: [...this.ids] }), { mode: 0o600 });
    renameSync(staging, this.path);
  }
}
