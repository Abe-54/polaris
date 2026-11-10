import { expect, test } from "bun:test";
import {
  type Capability,
  DaemonRpcs,
  LANGUAGE_RPC_CAPABILITIES,
  RPC_CAPABILITIES,
  rpcAllowed,
} from "@polaris/protocol";
import { hostPlatform } from "../platform/index.ts";
import { simulatorCapable } from "../simulator/service.ts";
import { daemonCapabilities, LANGUAGE_CAPABILITIES } from "./serve.ts";

const languageCapabilities = new Set<Capability>(LANGUAGE_CAPABILITIES);

/** Served by the lazy language handlers, announced only where a language artifact runs. */
const languageServed = new Set<string>([
  ...Object.keys(LANGUAGE_RPC_CAPABILITIES),
  ...Object.entries(RPC_CAPABILITIES).flatMap(([tag, need]) =>
    [need].flat().some((c) => c !== null && languageCapabilities.has(c)) ? [tag] : []
  ),
]);

/** On a Host that can't run Simulators, `simulator.*` answers Unsupported and isn't announced. */
const simulatorServed = new Set<string>(
  simulatorCapable(hostPlatform())
    ? []
    : Object.entries(RPC_CAPABILITIES).flatMap(([tag, need]) => (need === "simulator" ? [tag] : []))
);

test("this Daemon announces the capability of every RPC it serves, so no Client guard refuses it", () => {
  const refused = [...DaemonRpcs.requests.values()].flatMap(({ _tag: tag }) =>
    languageServed.has(tag) || simulatorServed.has(tag) || rpcAllowed(tag, daemonCapabilities)
      ? []
      : [tag]
  );

  expect(refused).toEqual([]);
});
