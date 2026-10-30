/**
 * The Hosts preview's fakes for the host page's Harnesses and Capacity cards: the store's
 * hosts from the fake machines, one availability report for every host, and a resources fake.
 */
import { HARNESS_CATALOGUE, type HarnessStatus } from "@polaris/protocol";
import type { HostView, MachineView } from "../../../../shared/api.ts";

const STATUS = new Map<string, readonly [HarnessStatus, string | null]>([
  ["claude", ["ready", "2.4.1"]],
  ["codex", ["ready", "0.81.0"]],
  ["opencode", ["needs-sign-in", "1.2.0"]],
]);

/** Claude Code and Codex ready, OpenCode waiting for its sign-in, the rest not installed. */
export const availability = () => ({
  harnesses: HARNESS_CATALOGUE.map((entry) => {
    const [status, version] = STATUS.get(entry.kind) ?? ["not-installed", null];

    return {
      harness: entry.kind,
      status,
      version,
      minVersion: entry.minVersion,
      signInKind: entry.kind === "claude" ? "Claude Max" : null,
      detail: null,
      signInArgv: status === "not-installed" ? null : [...entry.setup.signInCommand],
    };
  }),
  checkedAt: "2026-09-30T00:00:00.000Z",
});

/** The store's hosts: each enabled machine with its Connection State. */
export const hostViews = (machines: ReadonlyArray<MachineView>): ReadonlyArray<HostView> =>
  machines.flatMap((m) =>
    m.status === null
      ? []
      : [
          {
            key: m.key,
            label: m.label,
            colour: m.colour,
            alias: m.alias,
            kind: m.kind,
            proofHarness: false,
            status: m.status,
          },
        ]
  );
