/**
 * The host page's Remote access card (Paper HS-D; D2, D2b): one flow-line row per route the
 * host's daemon offers, the Polaris Relay and Tailscale, each off until the user turns it on,
 * and the relay address in the footer. Shown only for a connected host whose daemon offers one.
 */
import { SettingsCard, SettingsWell } from "@polaris/ui";
import type { ReactNode } from "react";
import type { MachineView } from "../../../../shared/api.ts";
import { RelayRouteRow, useRelayRoute } from "../RelayRoute.tsx";
import { RemoteAccess } from "../RemoteAccess.tsx";

/** Which routes a connected host's daemon offers; empty otherwise. */
export const routesOf = (machine: MachineView) => {
  if (machine.status?.state !== "connected") return { relay: false, tailscale: false };
  const capabilities: ReadonlyArray<string> = machine.status.capabilities;

  return {
    relay: capabilities.includes("linked-devices"),
    tailscale: capabilities.includes("remote-access"),
  };
};

const Card = ({ status, children }: { readonly status?: string; readonly children: ReactNode }) => (
  <SettingsCard
    title="Remote access"
    aside="Each route off until you turn it on"
    status={status}
    data-testid="remote-access-card"
  >
    <SettingsWell>{children}</SettingsWell>
  </SettingsCard>
);

/** With the relay: its address, saved or typed, is the footer's mono line. */
const WithRelay = ({
  machine,
  tailscale,
}: {
  readonly machine: MachineView;
  readonly tailscale: boolean;
}) => {
  const relay = useRelayRoute(machine.key);
  const address = relay.route?.url ?? relay.draft.trim();

  return (
    <Card status={address === "" ? "No relay set" : address}>
      <RelayRouteRow hostLabel={machine.label} {...relay} />
      {tailscale ? <RemoteAccess hostKey={machine.key} /> : null}
    </Card>
  );
};

export const RemoteAccessCard = ({ machine }: { readonly machine: MachineView }) => {
  const { relay, tailscale } = routesOf(machine);

  if (relay) return <WithRelay machine={machine} tailscale={tailscale} />;

  return tailscale ? (
    <Card>
      <RemoteAccess hostKey={machine.key} />
    </Card>
  ) : null;
};
