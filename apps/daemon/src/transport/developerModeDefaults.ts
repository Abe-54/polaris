import {
  DaemonRpcs,
  DeveloperModeRpcs,
  SelfTraceRpcs,
  SimulatorRpcs,
  Unsupported,
} from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";

const request = (capability: string) => () => Effect.fail(new Unsupported({ capability }));

const feed = (capability: string) => () => Stream.fail(new Unsupported({ capability }));

/** The tags these stubs serve, which `defaultHandlers` leaves to this layer. */
export const DEVELOPER_MODE_DEFAULT_TAGS = [
  "developerMode.get",
  "developerMode.set",
  "developerMode.setWorkspace",
  "developerMode.lease",
  "developerMode.watch",
  "traces.ingestSelf",
  "data.source.saveFile",
  "simulator.watch",
  "simulator.boot",
  "simulator.shutdown",
  "simulator.restart",
  "simulator.attach",
  "simulator.sessionFeed",
] as const;

/** Stubs until ENG-708's tasks S (Developer Mode), DT (Self-Traces) and SQ (SQLite) land. */
export const developerModeDefaults = Layer.mergeAll(
  DeveloperModeRpcs.merge(SelfTraceRpcs).toLayer({
    "developerMode.get": request("developer-mode"),
    "developerMode.set": request("developer-mode"),
    "developerMode.setWorkspace": request("developer-mode"),
    "developerMode.lease": feed("developer-mode"),
    "developerMode.watch": feed("developer-mode"),
    "traces.ingestSelf": request("traces.self"),
  }),
  DaemonRpcs.toLayerHandler("data.source.saveFile", request("data.sqlite")),
  /** For Daemons without `SimulatorRpcHandlers` (serve.ts mounts them over these). */
  SimulatorRpcs.toLayer({
    "simulator.watch": feed("simulator"),
    "simulator.boot": request("simulator"),
    "simulator.shutdown": request("simulator"),
    "simulator.restart": request("simulator"),
    "simulator.attach": feed("simulator"),
    "simulator.sessionFeed": feed("simulator"),
  })
);
