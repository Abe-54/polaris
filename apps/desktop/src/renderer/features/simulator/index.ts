/** The Simulator (ENG-829): Output's Simulator pane, its stores and feeds, and U1's `SimulatorStream`. */
export {
  SimulatorStream,
  type SimulatorStreamHandle,
  type SimulatorStreamProps,
} from "./SimulatorStream.tsx";

export type { SimulatorStatus, StreamPhase } from "./connection.ts";

export { bridgeTransport, type HubTarget, type SimulatorTransport } from "./transport.ts";

export type { HardwareButton } from "./protocol.ts";

export { tabVisible } from "./model.ts";

export { useHostSimulators, type HostSimulators } from "./hostSimulators.ts";

export { useSimulatorFeed } from "./feed.ts";

export { markSimulatorActivity, setSimulatorShown, simulatorUi, useSimulatorUi } from "./state.ts";

export { SimulatorPane, type SimulatorPaneProps } from "./ui/SimulatorPane.tsx";
