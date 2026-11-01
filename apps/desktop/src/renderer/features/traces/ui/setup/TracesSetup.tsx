/**
 * Traces in place of a trace when there is none to show (DESIGN.md, Traces → Setup; Paper T4):
 * no traces yet with "Set up tracing", the endpoint and the fixed-exporter card, the receiver
 * unavailable, the app exporting on its own, reading, the Host away, and a failed read.
 */
import { Button, EmptyState, PixelAlertIcon, PlugIcon } from "@polaris/ui";
import { Match } from "effect";
import type { ReactNode } from "react";
import { endpointLine, FIXED_EXPORTER_CHANGE, type SetupState } from "../../model/setup.ts";
import { FixedExporterCard } from "./FixedExporterCard.tsx";
import { Column, Copyable, Lead, Section } from "./parts.tsx";
import { SetUpWithAgent } from "./SetUpWithAgent.tsx";
import type { SetupPlaceView } from "./useSetupPlace.ts";

const Fixed = ({ place }: { readonly place: SetupPlaceView }) => (
  <FixedExporterCard
    hostKey={place.hostKey}
    workspaceId={place.workspaceId}
    workspaceName={place.workspaceName}
    session={place.session}
    placement={place.placement}
    exporters={place.fixed}
    forwardingTo={place.forwardingTo}
    onSettings={place.openSettings ?? (() => undefined)}
    onDismiss={place.dismiss}
  />
);

const Empty = ({
  endpoint,
  place,
}: {
  readonly endpoint: string | null;
  readonly place: SetupPlaceView;
}) => (
  <Column testId="traces-setup-empty">
    <Lead title="No traces from this checkout yet">
      <p>
        Commands this agent session runs get Polaris’s endpoint, but nothing they ran has sent a
        trace. An app sends them once it has OpenTelemetry set up.
      </p>
    </Lead>
    <SetUpWithAgent
      hostKey={place.hostKey}
      workspaceId={place.workspaceId}
      session={place.session}
      placement={place.placement}
      onInstrument={place.openSettings}
    />
    {endpoint === null ? null : (
      <Section title="A server you start yourself can send here too">
        <Copyable text={endpointLine(endpoint)} label="Copy" />
      </Section>
    )}
    {place.fixed.length > 0 ? (
      <Fixed place={place} />
    ) : (
      <Section title="An exporter with its URL fixed in code">
        <p className="text-caption text-text-subtle">
          The environment can’t redirect it. Change its URL to read Polaris’s endpoint, keeping the
          current one as the fallback:
        </p>
        <Copyable text={FIXED_EXPORTER_CHANGE} label="Copy" />
      </Section>
    )}
  </Column>
);

const Unavailable = ({
  code,
  message,
  owner,
}: {
  readonly code: string;
  readonly message: string;
  readonly owner: string | null;
}) => (
  <Column testId="traces-setup-unavailable">
    <Lead title="Polaris can’t receive traces on this host">
      <p>{message}</p>
      {owner === null ? null : (
        <p>
          In use by <span className="text-text-default font-mono">{owner}</span>
        </p>
      )}
    </Lead>
    <p className="text-code-inline text-text-faint font-mono">{code}</p>
  </Column>
);

/** The Daemon injects no endpoint here, so the fixed-exporter change can't help: no card. */
const UserExported = ({ place }: { readonly place: SetupPlaceView }) => (
  <Column testId="traces-setup-user-exported">
    <Lead title="This app sends its traces elsewhere">
      <p>
        Its exporter is set up with an endpoint of its own, so its traces go there and don’t reach
        Polaris.
      </p>
      {place.openSettings === null ? (
        <p className="text-text-faint">
          Forwarding a copy of them into Polaris needs a newer daemon on this host.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1">
            Polaris can take a copy on their way: forward to the collector in Settings → Traces.
          </p>
          <Button variant="ghost" className="border-hairline border" onClick={place.openSettings}>
            Traces settings
          </Button>
        </div>
      )}
    </Lead>
  </Column>
);

const Centered = ({
  testId,
  children,
}: {
  readonly testId: string;
  readonly children: ReactNode;
}) => (
  <div className="grid min-h-0 flex-1 place-items-center" data-testid={testId}>
    {children}
  </div>
);

export const TracesSetup = ({
  state,
  place,
}: {
  readonly state: SetupState;
  readonly place: SetupPlaceView;
}) =>
  Match.value(state).pipe(
    Match.discriminatorsExhaustive("kind")({
      loading: () => (
        <Centered testId="traces-setup-loading">
          <p className="text-caption text-text-subtle">Reading this checkout’s traces…</p>
        </Centered>
      ),
      reconnecting: ({ host }) => (
        <Centered testId="traces-setup-reconnecting">
          <EmptyState
            icon={<PlugIcon size={20} className="text-text-strong" />}
            title={`Reconnecting to ${host}…`}
            fact="Traces show again once its daemon answers"
          />
        </Centered>
      ),
      offline: ({ host }) => (
        <Centered testId="traces-setup-offline">
          <EmptyState
            icon={<PlugIcon size={20} className="text-text-strong" />}
            title={`${host} is offline`}
            fact="Polaris keeps trying; its traces show again once its daemon answers"
          />
        </Centered>
      ),
      needsAttention: ({ host }) => (
        <Centered testId="traces-setup-needs-attention">
          <EmptyState
            icon={<PixelAlertIcon size={24} className="text-text-strong" />}
            title={`${host} needs attention`}
            fact="Settings → Hosts says what happened; its traces show once it's connected"
          />
        </Centered>
      ),
      failed: ({ error }) => (
        <Centered testId="traces-setup-failed">
          <EmptyState
            icon={<PixelAlertIcon size={24} className="text-text-strong" />}
            title="Couldn’t read this checkout’s traces"
            fact={
              <>
                {error.message}
                <span className="font-mono"> · {error.code}</span>
                {error.fix === undefined ? null : <span className="block">{error.fix}</span>}
              </>
            }
          />
        </Centered>
      ),
      unavailable: (u) => <Unavailable code={u.code} message={u.message} owner={u.owner} />,
      userExported: () => <UserExported place={place} />,
      empty: ({ endpoint }) => <Empty endpoint={endpoint} place={place} />,
    })
  );
