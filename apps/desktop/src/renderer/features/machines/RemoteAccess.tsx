/**
 * The host page's Tailscale route (ENG-400): `tailscale serve`
 * on that host, through its own Daemon, so a remote host's works over its existing link.
 */
import type { RemoteAccessStatus } from "@polaris/protocol";
import { Switch } from "@polaris/ui";
import { useEffect, useState } from "react";
import type { Plain } from "../../store/plain.ts";
import { polaris } from "../bridge.ts";
import { call } from "./hooks.tsx";
import { FlowLine } from "./page/FlowLine.tsx";

type Status = Plain<RemoteAccessStatus>;

/** The phone's side, which the host can't check: said whenever the switch can be used. */
export const TAILNET_NOTE =
  "Your other devices need Tailscale connected, and your tailnet's access rules must let them reach this host on port 443.";

const REASONS: Record<NonNullable<Status["reason"]>, string> = {
  "not-installed": "Install Tailscale on this host to turn it on.",
  "not-running": "Start Tailscale on this host to turn it on.",
  "not-logged-in": "Log in to Tailscale on this host to turn it on.",
  "port-in-use":
    "Tailscale already uses port 443 on this host for something else. Stop it before turning on remote access.",
  "funnel-on":
    "Tailscale Funnel is on for port 443 on this host. Turning on remote access would turn it off, so Polaris leaves it alone.",
  "https-disabled": "Enable HTTPS certificates for your tailnet in the Tailscale admin console.",
  "needs-operator": "Run `sudo tailscale set --operator=$USER` on this host once.",
  "gateway-not-running": "The gateway isn't running on this host. Restart its daemon.",
  "serving-elsewhere":
    "Tailscale serves /polaris to something other than this host's gateway. Turn it off, or on again.",
  failed: "Tailscale didn't answer as expected.",
};

/** What the row says under its label, line by line. */
export const remoteAccessLines = (status: Status | null): ReadonlyArray<string> => {
  if (status === null) return ["Extensions on your other devices reach this host over Tailscale."];

  if (status.reason !== null) return [REASONS[status.reason]];

  if (status.state === "unavailable") return [REASONS.failed];

  return status.state === "on"
    ? [`Extensions connect to ${status.url ?? ""}`, TAILNET_NOTE]
    : ["Extensions on your other devices reach this host over Tailscale.", TAILNET_NOTE];
};

/** On can always be turned off, even when it serves the wrong thing; off needs nothing missing. */
const switchable = (status: Status): boolean =>
  status.state === "on" || (status.state === "off" && status.reason === null);

export interface RemoteAccessRowProps {
  readonly status: Status | null;
  readonly busy: boolean;
  readonly onChange: (on: boolean) => void;
}

/** "ON · FOR EXTENSIONS", in the row's mono line. */
const stateLine = (status: Status | null) => {
  if (status === null) return "Checking…";

  return status.state === "unavailable" ? "Unavailable" : `${status.state} · for extensions`;
};

/** Paper HS-D's row: the flow line, "Tailscale" over its mono state, the switch; then any note. */
export const RemoteAccessRow = ({ status, busy, onChange }: RemoteAccessRowProps) => {
  const on = status?.state === "on";
  const quiet = status === null || (status.state === "off" && status.reason === null);

  return (
    <div className="flex flex-col gap-1.5 px-4 py-3.5" data-testid="remote-access">
      <div className="flex items-center gap-2.5" title={remoteAccessLines(status).join(" ")}>
        <FlowLine flow={on && status.reason === null ? "live" : "off"} via="direct" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-body text-text-default">Tailscale</span>
          <span className="text-text-subtle truncate font-mono text-[10px] leading-[14px] uppercase">
            {stateLine(status)}
          </span>
        </div>
        <Switch
          aria-label="Tailscale"
          checked={on}
          disabled={busy || status === null || !switchable(status)}
          onCheckedChange={onChange}
        />
      </div>
      {quiet
        ? null
        : remoteAccessLines(status).map((line) => (
            <span key={line} className="text-caption text-text-subtle pl-[130px] break-words">
              {line}
            </span>
          ))}
    </div>
  );
};

/** Read when shown; a failed switch keeps the last answer and toasts. */
export const useRemoteAccess = (hostKey: string) => {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;

    setStatus(null);
    void polaris()
      .request("remoteAccess.status", { hostKey })
      .then((result) => {
        if (active && result.ok) setStatus(result.value);
      });

    return () => {
      active = false;
    };
  }, [hostKey]);

  const change = async (on: boolean) => {
    setBusy(true);

    try {
      const next = await call(on ? "remoteAccess.enable" : "remoteAccess.disable", { hostKey });

      if (next !== null) setStatus(next);
    } finally {
      setBusy(false);
    }
  };

  return { status, busy, onChange: (on: boolean) => void change(on) };
};

export const RemoteAccess = ({ hostKey }: { readonly hostKey: string }) => (
  <RemoteAccessRow {...useRemoteAccess(hostKey)} />
);
