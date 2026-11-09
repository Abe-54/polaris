import { expect, test } from "bun:test";
import { DaemonRpcs, LANGUAGE_RPC_CAPABILITIES, rpcAllowed } from "@polaris/protocol";
import { daemonCapabilities } from "./serve.ts";

test("this Daemon announces the capability of every RPC it serves, so no Client guard refuses it", () => {
  const refused = [...DaemonRpcs.requests.values()].flatMap(({ _tag: tag }) =>
    Object.hasOwn(LANGUAGE_RPC_CAPABILITIES, tag) || rpcAllowed(tag, daemonCapabilities)
      ? []
      : [tag]
  );

  expect(refused).toEqual([]);
});
