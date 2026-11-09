/**
 * Requests while its Host isn't connected, as Traces says it (DESIGN.md, Requests → States): only
 * Reconnecting promises to come back by itself. What Requests already read stays readable.
 */
import type { ConnectionState } from "@polaris/protocol";
import { EmptyState, PixelAlertIcon, PlugIcon } from "@polaris/ui";
import { useApp } from "../../../../shell/hooks.ts";

type Away = Exclude<ConnectionState, "connected">;

const COPY: Readonly<Record<Away, (host: string) => { title: string; fact: string }>> = {
  reconnecting: (host) => ({
    title: `Reconnecting to ${host}…`,
    fact: "Requests send again once its daemon answers",
  }),
  offline: (host) => ({
    title: `${host} is offline`,
    fact: "Polaris keeps trying; requests send again once its daemon answers",
  }),
  "needs-attention": (host) => ({
    title: `${host} needs attention`,
    fact: "Settings → Hosts says what happened; requests send once it's connected",
  }),
};

/** The Host's state while it is away; null while connected. */
export const useHostAway = (hostKey: string): { state: Away; host: string } | null => {
  const host = useApp((s) => s.hosts.find((h) => h.key === hostKey));
  const state = host?.status.state;

  return host === undefined || state === undefined || state === "connected"
    ? null
    : { state, host: host.label };
};

export const HostAway = ({ state, host }: { readonly state: Away; readonly host: string }) => {
  const { title, fact } = COPY[state](host);

  return (
    <div className="grid flex-1 place-items-center" data-testid={`requests-host-${state}`}>
      <EmptyState
        icon={
          state === "needs-attention" ? (
            <PixelAlertIcon size={24} className="text-text-strong" />
          ) : (
            <PlugIcon size={20} className="text-text-strong" />
          )
        }
        title={title}
        fact={fact}
      />
    </div>
  );
};
