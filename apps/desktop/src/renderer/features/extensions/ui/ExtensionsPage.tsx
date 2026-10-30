/**
 * Settings → Extensions (DESIGN.md, Settings redesign SR-07; ENG-401): a card per host with its
 * pairings, their Grant and last use, Revoke in place, and Pair an extension in that card,
 * whose token shows once as a QR code and a pairing string.
 */
import type { Grant, PairingId } from "@polaris/protocol";
import {
  cn,
  SettingsButton,
  SettingsCard,
  SettingsEmpty,
  SettingsPage,
  SettingsWell,
} from "@polaris/ui";
import { Match } from "effect";
import { type ReactNode, useState } from "react";
import type { HostView } from "../../../../shared/api.ts";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { useNow } from "../../../shell/useNow.ts";
import { sectionInfo } from "../../settings/model/sections.ts";
import { livePairings } from "../model.ts";
import { type Paired, useExtensions } from "../useExtensions.ts";
import { PairForm } from "./PairForm.tsx";
import { PairingRow } from "./PairingRow.tsx";
import { Reveal } from "./Reveal.tsx";

const CAPABILITY = "extensions";

const FALLBACK_COLOUR = "var(--color-text-subtle)";

type Panel =
  | { readonly kind: "closed" }
  | { readonly kind: "form" }
  | { readonly kind: "paired"; readonly paired: Paired };

const ScreenGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="2.5" width="9" height="6" rx="1" fill="none" stroke="currentColor" />
    <path d="M4 10.5h4" stroke="currentColor" />
  </svg>
);

const HostName = ({ label, colour }: { readonly label: string; readonly colour: string }) => (
  <span className="flex items-center gap-2">
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-[3px]"
      style={{ backgroundColor: colour }}
    />
    {label}
  </span>
);

const PairButton = ({ onClick }: { readonly onClick: () => void }) => (
  <SettingsButton onClick={onClick}>Pair an extension</SettingsButton>
);

/** A host whose pairings can't show: one line, and at most one way forward. */
const LineCard = ({
  label,
  colour,
  line,
  offline = false,
  action,
}: {
  readonly label: string;
  readonly colour: string;
  readonly line: string;
  readonly offline?: boolean;
  readonly action?: ReactNode;
}) => (
  <SettingsCard
    title={<HostName label={label} colour={colour} />}
    aside={offline ? "Not connected" : undefined}
    action={action}
    className={cn(offline && "opacity-(--opacity-dimmed)")}
  >
    <SettingsEmpty>{line}</SettingsEmpty>
  </SettingsCard>
);

/** One connected host's card: its pairings, the inline pair form and the one-time reveal. */
export const HostPairings = ({
  hostKey,
  label,
  colour = FALLBACK_COLOUR,
}: {
  readonly hostKey: string;
  readonly label: string;
  readonly colour?: string;
}) => {
  const { state, pair, revoke } = useExtensions(hostKey, true);
  const [panel, setPanel] = useState<Panel>({ kind: "closed" });
  const now = useNow();

  if (state.kind !== "ready")
    return (
      <LineCard
        label={label}
        colour={colour}
        line={state.kind === "loading" ? `Asking ${label}…` : state.message}
      />
    );

  const pairings = livePairings(state.pairings);
  const open = () => setPanel({ kind: "form" });
  const close = () => setPanel({ kind: "closed" });

  const onPair = async (name: string, grant: Grant) => {
    const paired = await pair(name, grant);

    if (paired !== null) setPanel({ kind: "paired", paired });
  };

  const onRevoke = async (id: PairingId) => {
    if (await revoke(id)) {
      setPanel((current) =>
        current.kind === "paired" && current.paired.pairing.id === id ? { kind: "closed" } : current
      );
    }
  };

  if (pairings.length === 0 && panel.kind === "closed")
    return (
      <SettingsCard
        title={
          <span className="flex items-center gap-3">
            <HostName label={label} colour={colour} />
            <span className="text-caption text-text-subtle truncate">
              No extensions paired with {label}
            </span>
          </span>
        }
        aside={<PairButton onClick={open} />}
        className="pb-[calc(var(--spacing-gap)+4px)]"
      >
        {null}
      </SettingsCard>
    );

  const form = panel.kind === "form";

  return (
    <SettingsCard
      title={<HostName label={label} colour={colour} />}
      aside={form ? "Pairing" : `${pairings.length} paired`}
      status={form ? undefined : "Grants are fixed at pairing"}
      action={panel.kind === "closed" ? <PairButton onClick={open} /> : undefined}
    >
      {pairings.length === 0 ? null : (
        <SettingsWell aria-label={`Extensions paired with ${label}`}>
          {pairings.map((p) => (
            <PairingRow key={p.id} pairing={p} now={now} onRevoke={() => onRevoke(p.id)} />
          ))}
        </SettingsWell>
      )}
      {Match.value(panel).pipe(
        Match.discriminatorsExhaustive("kind")({
          closed: () => null,
          form: () => (
            <PairForm hostKey={hostKey} hostLabel={label} onCancel={close} onPair={onPair} />
          ),
          paired: ({ paired }) => <Reveal paired={paired} hostLabel={label} onDone={close} />,
        })
      )}
    </SettingsCard>
  );
};

const HostSection = ({ host }: { readonly host: HostView }) => {
  const { openSettings } = useShellActions();
  const colour = host.colour ?? FALLBACK_COLOUR;

  if (host.status.state !== "connected")
    return (
      <LineCard
        label={host.label}
        colour={colour}
        offline
        line={`${host.label} isn't connected; its extensions show once it is`}
      />
    );

  if (!host.status.capabilities.includes(CAPABILITY))
    return (
      <LineCard
        label={host.label}
        colour={colour}
        line={`The daemon on ${host.label} is too old to pair extensions`}
        action={<SettingsButton onClick={() => openSettings("hosts")}>Open hosts</SettingsButton>}
      />
    );

  return <HostPairings hostKey={host.key} label={host.label} colour={colour} />;
};

export const ExtensionsPage = () => {
  const hosts = useApp((s) => s.hosts);
  const info = sectionInfo("extensions");

  return (
    <SettingsPage
      title={info.title}
      blurb="Apps and devices that act on a host for you, with only what you grant."
      scope="Each host"
      scopeIcon={<ScreenGlyph />}
    >
      {hosts.map((host) => (
        <div key={host.key} data-testid="extensions-host" data-host={host.key} className="contents">
          <HostSection host={host} />
        </div>
      ))}
    </SettingsPage>
  );
};
