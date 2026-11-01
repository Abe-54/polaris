import type { DataSource } from "@polaris/protocol";
import { daemonPolicy, isDaemonSource } from "../daemonSources.ts";

/** SQLite sources never open approvals (ENG-720): Local files read, other files are agent-denied. */
export const filePolicy = (source: DataSource): Pick<DataSource, "access" | "writes"> =>
  isDaemonSource(source)
    ? daemonPolicy(source.access === "read")
    : { access: source.locality === "local" ? "read" : "denied", writes: "off" };
