/**
 * The total `pv.state` kept on the phone (ENG-634): past either cap the least recently written
 * files go first, never the one just written.
 */

/** All Visualizations' saved state together, in bytes. */
export const STATES_MAX_BYTES = 1024 * 1024;

/** Saved Visualizations kept at most. */
export const STATES_MAX_FILES = 256;

export interface SavedFile {
  readonly name: string;
  readonly size: number;
  /** Milliseconds since the epoch; 0 when unknown, so it goes first. */
  readonly modified: number;
}

/** The files to delete so the rest fit both caps, keeping `kept`. */
export const evictions = (files: ReadonlyArray<SavedFile>, kept: string): Array<string> => {
  const oldestFirst = files
    .filter(({ name }) => name !== kept)
    .toSorted((a, b) => a.modified - b.modified);

  let bytes = files.reduce((sum, { size }) => sum + size, 0);
  let count = files.length;
  const evicted: Array<string> = [];

  for (const file of oldestFirst) {
    if (bytes <= STATES_MAX_BYTES && count <= STATES_MAX_FILES) break;
    evicted.push(file.name);
    bytes -= file.size;
    count -= 1;
  }

  return evicted;
};
