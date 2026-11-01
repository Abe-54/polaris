import type { DataSource } from "@polaris/protocol";

/** SQLite sources never open approvals (ENG-720): Local files read, other files are agent-denied. */
export const filePolicy = (source: DataSource): Pick<DataSource, "access" | "writes"> => ({
  access: source.locality === "local" ? "read" : "denied",
  writes: "off",
});
