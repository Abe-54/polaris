/**
 * Traces in place of a trace when there is none to show (DESIGN.md, Traces → Setup; Paper T4):
 * no traces yet with the endpoint and the fixed-exporter change to copy, the receiver unavailable,
 * the app exporting on its own, reading, the Host away, and a failed read.
 */
import { CopyButton, EmptyState, PixelAlertIcon, PlugIcon } from "@polaris/ui";
import { Match } from "effect";
import type { ReactNode } from "react";
import { endpointLine, FIXED_EXPORTER_CHANGE, type SetupState } from "../../model/setup.ts";

const Copyable = ({ text, label }: { readonly text: string; readonly label: string }) => (
  <div className="border-hairline bg-surface-sunken rounded-control flex items-start gap-2 border py-2 pr-2 pl-2.5">
    <code className="text-code-inline text-text-default min-w-0 flex-1 font-mono break-all whitespace-pre-wrap">
      {text}
    </code>
    <CopyButton text={text} label={label} />
  </div>
);

const Section = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h3 className="text-label text-text-strong font-medium">{title}</h3>
    {children}
  </section>
);

const Column = ({
  testId,
  children,
}: {
  readonly testId: string;
  readonly children: ReactNode;
}) => (
  <div className="flex min-h-0 flex-1 overflow-y-auto" data-testid={testId}>
    <div className="m-auto flex w-full max-w-[460px] flex-col gap-6 px-6 py-10">{children}</div>
  </div>
);

const Lead = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <h2 className="text-heading text-text-strong">{title}</h2>
    <div className="text-body text-text-subtle flex flex-col gap-1.5">{children}</div>
  </div>
);

const Empty = ({ endpoint }: { readonly endpoint: string | null }) => (
  <Column testId="traces-setup-empty">
    <Lead title="No traces from this checkout yet">
      <p>
        Commands this agent session runs get Polaris’s endpoint, but nothing they ran has sent a
        trace. An app sends them once it has OpenTelemetry set up.
      </p>
    </Lead>
    {endpoint === null ? null : (
      <Section title="A server you start yourself can send here too">
        <Copyable text={endpointLine(endpoint)} label="Copy" />
      </Section>
    )}
    <Section title="An exporter with its URL fixed in code">
      <p className="text-caption text-text-subtle">
        The environment can’t redirect it. Change its URL to read Polaris’s endpoint, keeping the
        current one as the fallback:
      </p>
      <Copyable text={FIXED_EXPORTER_CHANGE} label="Copy" />
    </Section>
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

const UserExported = () => (
  <Column testId="traces-setup-user-exported">
    <Lead title="This app sends its traces elsewhere">
      <p>
        Its exporter already has an endpoint, so Polaris didn’t add its own to this agent session’s
        commands, and its traces don’t reach Polaris.
      </p>
      <p className="text-text-faint">
        Forwarding a copy of them into Polaris, on their way to where they go now, is a follow-up.
      </p>
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

export const TracesSetup = ({ state }: { readonly state: SetupState }) =>
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
      userExported: () => <UserExported />,
      empty: ({ endpoint }) => <Empty endpoint={endpoint} />,
    })
  );
