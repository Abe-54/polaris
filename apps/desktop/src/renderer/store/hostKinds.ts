/**
 * Each Host's kind and name by key, as the last Host list said, for helpers that work from a
 * Host key alone (Reveal in Finder, a refusal's copy). The store updates it with every list.
 */
import { clientCopy } from "../../shared/clientCopy.ts";
import type { HostKind, HostView } from "../../shared/api.ts";

let kinds: ReadonlyMap<string, HostKind> = new Map();

let labels: ReadonlyMap<string, string> = new Map();

export const noteHostKinds = (
  hosts: ReadonlyArray<Pick<HostView, "key" | "kind"> & Partial<Pick<HostView, "label">>>
) => {
  kinds = new Map(hosts.map((host) => [host.key, host.kind]));
  labels = new Map(
    hosts.flatMap((host) => (host.label === undefined ? [] : [[host.key, host.label]]))
  );
};

export const hostKindOf = (hostKey: string): HostKind | undefined => kinds.get(hostKey);

/** A Host's name in running text: "this Mac" for the local Host, else its label. */
export const hostTextOf = (hostKey: string | undefined): string => {
  if (hostKey === undefined) return "this host";

  if (kinds.get(hostKey) === "local") return clientCopy().machine;

  return labels.get(hostKey) ?? "this host";
};
