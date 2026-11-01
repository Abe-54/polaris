import type { DataEngine, ServerDataEngine } from "@polaris/protocol";

/**
 * The engine of a source this server-only path drives. SQLite reads branch off before it
 * (`sqlite/`), and its writes are refused in `writeQueries.ts` (ENG-720).
 */
export const serverEngine = (engine: DataEngine): ServerDataEngine => {
  if (engine === "sqlite") throw new Error("SQLite Data Sources are not supported on this path");

  return engine;
};
