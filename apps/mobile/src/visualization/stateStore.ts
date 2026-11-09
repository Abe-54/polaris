/**
 * Each Visualization's `pv.state`, on this phone only (ADR 0101), as JSON in the document
 * directory, keyed by Visualization id; read synchronously so a frame's document carries it.
 */
import type { FrameMessage } from "@polaris/visualization";
import { Option, Schema } from "effect";
import { Directory, File, Paths } from "expo-file-system";
import { evictions, type SavedFile } from "./stateBudget.ts";

/** The frame's opaque envelope, stored as it sent it and handed back as `options.state`. */
export type SavedState = Extract<FrameMessage, { readonly type: "pv:state" }>["state"];

export interface VisualizationStateStore {
  /** The saved state, or undefined when there is none. */
  readonly read: (id: string) => SavedState;
  readonly write: (id: string, state: SavedState) => void;
}

const directory = () => new Directory(Paths.document, "visualizations");

/** Ids are the Daemon's `viz_<uuid>`; anything else is made filename-safe. */
const fileOf = (id: string) =>
  new File(directory(), `${id.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 120)}.json`);

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Deletes the least recently written states past the total budget, keeping `kept`. */
const prune = (folder: Directory, kept: File) => {
  const files = folder.list().filter((entry): entry is File => entry instanceof File);

  const saved: Array<SavedFile> = files.map((file) => ({
    name: file.name,
    size: file.size,
    modified: file.modificationTime ?? 0,
  }));

  const evicted = new Set(evictions(saved, kept.name));

  for (const file of files) if (evicted.has(file.name)) file.delete();
};

export const fileStateStore: VisualizationStateStore = {
  read: (id) => {
    try {
      const file = fileOf(id);

      return file.exists ? Option.getOrUndefined(decode(file.textSync())) : undefined;
    } catch {
      return undefined;
    }
  },
  write: (id, state) => {
    try {
      const folder = directory();

      if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
      const file = fileOf(id);

      file.writeSync(JSON.stringify(state));
      prune(folder, file);
    } catch {
      // Best effort: the frame keeps its state for as long as it's open either way.
    }
  },
};
