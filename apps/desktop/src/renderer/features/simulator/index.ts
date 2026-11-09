/** The Simulator's stream view (ENG-829): `SimulatorStream` over a `SimulatorTransport`. */
export {
  SimulatorStream,
  type SimulatorStreamHandle,
  type SimulatorStreamProps,
} from "./SimulatorStream.tsx";

export type { SimulatorStatus, StreamPhase } from "./connection.ts";

export { bridgeTransport, type HubTarget, type SimulatorTransport } from "./transport.ts";

export type { HardwareButton } from "./protocol.ts";
