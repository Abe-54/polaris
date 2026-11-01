import type { DataEngine, ServerDataEngine } from "@polaris/protocol";

/**
 * The engine of a source this server-only path drives. No SQLite source reaches it yet:
 * discovery finds none and `data.source.saveFile` is unsupported until ENG-708's SQ task.
 */
export const serverEngine = (engine: DataEngine): ServerDataEngine => {
  if (engine === "sqlite") throw new Error("SQLite Data Sources are not supported on this path");

  return engine;
};
