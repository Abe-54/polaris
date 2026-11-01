/** A new session's calls and Hosts over the app's HostConnections (src/runtime/hostConnection.ts). */
import type { Workspace } from "@polaris/protocol";
import type { HostConnection } from "../runtime/hostConnection.ts";
import { tracedDispatch } from "../selfTraces/index.ts";
import type { NewSessionApi } from "./api.ts";
import type { SessionUse, SheetHost } from "./model.ts";

/** One Host's workspaces and sessions, as the home feed has them. */
export interface HostFeed {
  readonly workspaces: ReadonlyArray<Workspace>;
  readonly sessions: ReadonlyArray<SessionUse>;
}

const connectionOf = (hosts: ReadonlyArray<HostConnection>, hostId: string): HostConnection => {
  const connection = hosts.find((h) => h.hostId === hostId);

  if (connection === undefined) throw new Error(`No connection to ${hostId}`);

  return connection;
};

export const newSessionApi = (hosts: ReadonlyArray<HostConnection>): NewSessionApi => ({
  availability: (hostId, refresh = false) =>
    connectionOf(hosts, hostId).run((client) => client["harness.availability"]({ refresh })),
  models: (hostId, harness) =>
    connectionOf(hosts, hostId).run((client) =>
      client["harness.models"]({ harness, refresh: false })
    ),
  dispatch: async (hostId, commandId, command) => {
    await connectionOf(hosts, hostId).run((client) =>
      tracedDispatch(command, commandId, client.dispatch({ commandId, command }))
    );
  },
});

/** A Host as a new session sees it: the name the user gave it, its route and its feed. */
export const sheetHost = (connection: HostConnection, feed: HostFeed | null): SheetHost => {
  const status = connection.status();

  return {
    hostId: connection.hostId,
    hostName: connection.name,
    connected: status.state === "connected",
    state: status.state,
    latencyMs: status.latencyMs,
    route: connection.route === "relay" ? "relay" : "network",
    homeDir: status.host?.homeDir ?? null,
    workspaces: feed?.workspaces ?? [],
    sessions: feed?.sessions ?? [],
    capabilities: status.capabilities,
  };
};
