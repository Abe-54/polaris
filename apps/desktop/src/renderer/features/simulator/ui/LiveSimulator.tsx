/**
 * A booted Simulator on screen: `simulator.attach` holds the hub up and gives its port and
 * token; U1's stream draws the frames. Unmounting detaches, so the Daemon can go idle.
 */
import type { SessionId, Simulator } from "@polaris/protocol";
import { type Ref, useEffect, useRef, useState } from "react";
import { polaris } from "../../bridge.ts";
import type { SimulatorStatus } from "../connection.ts";
import { SimulatorStream, type SimulatorStreamHandle } from "../SimulatorStream.tsx";
import { bridgeTransport } from "../transport.ts";
import { EmptyBezel, Failed, Spinner } from "./states.tsx";

/** The bezel's width around a live frame. */
const BEZEL = 8;

type Attach =
  | { readonly kind: "starting" }
  | { readonly kind: "attached"; readonly port: number; readonly token: string }
  | { readonly kind: "failed"; readonly detail: string };

/** Holds the attach open while mounted; a clean end (a dropped connection) attaches again. */
const useAttach = (hostKey: string, sessionId: SessionId, id: string, epoch: number) => {
  const [attach, setAttach] = useState<Attach>({ kind: "starting" });

  useEffect(() => {
    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const open = () => {
      stop = polaris().subscribe(
        "simulator.attach",
        { hostKey, sessionId, id },
        {
          items: (items) => {
            const last = items.at(-1);

            if (last !== undefined)
              setAttach({ kind: "attached", port: last.port, token: last.token });
          },
          end: (error) => {
            if (disposed) return;

            if (error !== undefined && error !== null) {
              setAttach({ kind: "failed", detail: error.message });

              return;
            }

            timer = setTimeout(open, 1000);
          },
        }
      );
    };

    setAttach({ kind: "starting" });
    open();

    return () => {
      disposed = true;
      clearTimeout(timer);
      stop?.();
    };
  }, [hostKey, sessionId, id, epoch]);

  return attach;
};

export interface LiveSimulatorProps {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly hostLabel: string;
  readonly local: boolean;
  readonly device: Simulator;
  /** Bumped by Restart: attach again once the hub is back. */
  readonly epoch: number;
  readonly restarting: boolean;
  readonly onRestart: () => void;
  /** The stream's live state, for the toolbar; false while starting, reconnecting or failed. */
  readonly onLive: (live: boolean) => void;
  /** A fresh `Attached` came: a restart is over. */
  readonly onAttached: () => void;
  readonly streamRef: Ref<SimulatorStreamHandle>;
}

/** Over the dimmed last frame while the stream comes back (DESIGN.md, Streaming, Restarting). */
const Reconnecting = ({ device }: { readonly device: string }) => (
  <div
    className="border-hairline bg-surface-sunken text-caption absolute inset-x-0 top-0 z-10 flex h-7 items-center gap-2 border-b px-3"
    role="status"
    data-testid="simulator-reconnecting"
  >
    <Spinner className="text-text-subtle" />
    <span className="text-text-default truncate">Reconnecting to {device}</span>
    <span className="text-text-subtle shrink-0">It keeps running</span>
  </div>
);

export const LiveSimulator = ({
  hostKey,
  sessionId,
  hostLabel,
  local,
  device,
  epoch,
  restarting,
  onRestart,
  onLive,
  onAttached,
  streamRef,
}: LiveSimulatorProps) => {
  const attach = useAttach(hostKey, sessionId, device.id, epoch);
  const [status, setStatus] = useState<SimulatorStatus | null>(null);
  const transport = useState(() => bridgeTransport(hostKey, local))[0];
  const port = attach.kind === "attached" ? attach.port : null;
  const token = attach.kind === "attached" ? attach.token : null;

  const report = useRef({ onAttached, onLive });

  report.current = { onAttached, onLive };

  // A new port or token is a fresh Attached: the end of a restart.
  useEffect(() => {
    if (port !== null) report.current.onAttached();
  }, [port, token]);

  const live = status?.phase === "live" && !restarting;

  useEffect(() => {
    report.current.onLive(live);
  }, [live]);
  useEffect(() => () => report.current.onLive(false), []);

  if (attach.kind === "failed" || status?.phase === "failed")
    return (
      <Failed
        hostLabel={hostLabel}
        device={device.name}
        detail={attach.kind === "failed" ? attach.detail : (status?.detail ?? "")}
        onRestart={onRestart}
      />
    );

  if (attach.kind === "starting")
    return (
      <EmptyBezel
        busy
        title={`Starting Simulators on ${hostLabel}`}
        fact={`Then connecting to ${device.name}`}
      />
    );

  const painted = status?.screen != null;
  const reconnecting = restarting || (painted && status?.phase === "reconnecting");

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="simulator-live">
      {reconnecting ? <Reconnecting device={device.name} /> : null}
      <div className="relative min-h-0 flex-1 p-4" data-dim={restarting}>
        <div className="h-full w-full data-[dim=true]:opacity-45" data-dim={restarting}>
          <SimulatorStream
            ref={streamRef}
            target={{
              port: attach.port,
              token: attach.token,
              id: device.id,
              platform: device.platform,
            }}
            transport={transport}
            label={device.name}
            bezel={BEZEL}
            onStatus={setStatus}
          />
        </div>
        {painted ? null : (
          <div className="absolute inset-0 flex">
            <EmptyBezel
              busy
              title={`Connecting to ${device.name}`}
              fact={`${device.osVersion} · ${hostLabel}`}
            />
          </div>
        )}
      </div>
    </div>
  );
};
