/**
 * Settings → Voice (DESIGN.md, Settings redesign SR-09; ENG-404, ADR 0077): one Deepgram key
 * card with a row per Host, then the Extensions allowed voice. A key goes to its Host and is
 * never read back, so a row only says whether one is set and where it is kept.
 */
import type { Pairing } from "@polaris/protocol";
import {
  cn,
  Input,
  SettingsButton,
  SettingsCard,
  SettingsConfirmRow,
  SettingsEmpty,
  SettingsPage,
  SettingsWell,
} from "@polaris/ui";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { HostView, IpcError, Plain } from "../../../../shared/api.ts";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { useNow } from "../../../shell/useNow.ts";
import { polaris } from "../../bridge.ts";
import { livePairings, usedLine } from "../../extensions/model.ts";
import {
  CLI_HINT,
  keyCaption,
  keyToSave,
  unavailableLine,
  type VoiceKeyState,
} from "../model/voice.ts";
import { sectionInfo } from "../model/sections.ts";
import { hostColour } from "./AutoArchive.tsx";
import { useVoiceKeys } from "./useVoiceKey.ts";

type SetKey = (key: string | null) => Promise<IpcError | null>;

const ScreenGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="2.5" width="9" height="6" rx="1" fill="none" stroke="currentColor" />
    <path d="M4 10.5h4" stroke="currentColor" />
  </svg>
);

const HostSquare = ({ host }: { readonly host: HostView }) => (
  <span
    aria-hidden
    className="size-2.5 shrink-0 rounded-[3px]"
    style={{ backgroundColor: hostColour(host) }}
  />
);

/** A host's row: its colour square, name and one caption line, its actions trailing. */
const HostRow = ({
  host,
  caption,
  dimmed = false,
  actions,
  children,
}: {
  readonly host: HostView;
  readonly caption: string;
  readonly dimmed?: boolean;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}) => (
  <div
    data-testid="voice-host"
    data-host={host.key}
    className={cn(
      "px-panel flex flex-col gap-2 py-[calc(var(--spacing-gap)+4px)]",
      dimmed && "opacity-(--opacity-dimmed)"
    )}
  >
    <div className="flex items-center gap-3">
      <HostSquare host={host} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body text-text-default truncate">{host.label}</span>
        <span className="text-caption text-text-subtle truncate" data-testid="voice-key-state">
          {caption}
        </span>
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
    {children === undefined ? null : <div className="pl-[22px]">{children}</div>}
  </div>
);

const KeyField = ({
  host,
  replacing,
  setKey,
  onDone,
}: {
  readonly host: HostView;
  readonly replacing: boolean;
  readonly setKey: SetKey;
  readonly onDone: () => void;
}) => {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `voice-key-${host.key}`;
  const errorId = `${id}-error`;
  const key = keyToSave(draft);

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (key === null || busy) return;
    setBusy(true);

    const refused = await setKey(key);

    setBusy(false);
    setError(refused?.message ?? null);

    if (refused === null) {
      setDraft("");
      onDone();
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          Deepgram key
        </label>
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus={replacing}
          value={draft}
          placeholder={replacing ? "Paste a new key to replace it" : "Paste an API key"}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : errorId}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          className="text-code-inline h-[26px] font-mono"
        />
        <SettingsButton
          type="submit"
          variant={key === null ? "secondary" : "primary"}
          disabled={key === null || busy}
        >
          Save
        </SettingsButton>
        {replacing ? (
          <SettingsButton variant="ghost" onClick={onDone}>
            Cancel
          </SettingsButton>
        ) : null}
      </div>
      {error === null ? null : (
        <p id={errorId} role="alert" className="text-caption text-text-subtle">
          {error}
        </p>
      )}
    </form>
  );
};

const KeyRow = ({
  host,
  state,
  setKey,
}: {
  readonly host: HostView;
  readonly state: VoiceKeyState;
  readonly setKey: SetKey;
}) => {
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const unavailable = unavailableLine(host);

  if (unavailable !== null) {
    const offline = host.status.state !== "connected";

    return (
      <HostRow
        host={host}
        caption={unavailable}
        dimmed={offline}
        actions={offline ? <NotConnected /> : undefined}
      />
    );
  }

  if (state.kind !== "ready") {
    return (
      <HostRow
        host={host}
        caption={state.kind === "loading" ? `Asking ${host.label}…` : state.message}
      />
    );
  }

  const { settings } = state;

  const remove = async () => {
    setBusy(true);
    await setKey(null);
    setBusy(false);
  };

  if (settings.keySet && !replacing)
    return (
      <div data-testid="voice-host" data-host={host.key}>
        <SettingsConfirmRow
          leading={<HostSquare host={host} />}
          title={host.label}
          caption={<span data-testid="voice-key-state">{keyCaption(settings, host.label)}</span>}
          action="Remove key"
          actionVariant="secondary"
          consequence={`Removing it stops voice on ${host.label}: extensions can't transcribe there until you paste a key again.`}
          confirm={`Remove the key on ${host.label}`}
          onConfirm={() => void remove()}
          {...(busy ? { disabledReason: "Removing…" } : {})}
        >
          <SettingsButton variant="ghost" onClick={() => setReplacing(true)}>
            Replace
          </SettingsButton>
        </SettingsConfirmRow>
      </div>
    );

  return (
    <HostRow host={host} caption={keyCaption(settings, host.label)}>
      <KeyField
        host={host}
        replacing={settings.keySet}
        setKey={setKey}
        onDone={() => setReplacing(false)}
      />
    </HostRow>
  );
};

const NotConnected = () => (
  <span className="text-caption text-text-subtle flex h-[26px] items-center rounded-[8px] border border-dashed border-[light-dark(#00000026,#ffffff2e)] px-2.5">
    Not connected
  </span>
);

const keySetOn = (hosts: ReadonlyArray<HostView>, stateOf: (key: string) => VoiceKeyState) =>
  hosts.filter((host) => {
    const state = stateOf(host.key);

    return state.kind === "ready" && state.settings.keySet;
  });

const setOnLine = (set: number, of: number) =>
  of === 1 ? (set === 1 ? "Set" : "Not set") : `Set on ${set} of ${of} hosts`;

/** Hosts that can answer for their voice key, or their pairings, now. */
const answering = (hosts: ReadonlyArray<HostView>, capability: string) =>
  hosts.filter(
    (host) =>
      host.status.state === "connected" && host.status.capabilities.some((c) => c === capability)
  );

interface VoicePairing {
  readonly pairing: Plain<Pairing>;
  readonly host: HostView;
}

/** Live pairings granted voice, on every connected Host that lists extensions. */
const useVoicePairings = (hosts: ReadonlyArray<HostView>) => {
  const [byHost, setByHost] = useState<Readonly<Record<string, ReadonlyArray<Plain<Pairing>>>>>({});

  const asked = answering(hosts, "extensions");
  const askedKey = asked.map((h) => h.key).join("\n");

  useEffect(() => {
    for (const hostKey of askedKey === "" ? [] : askedKey.split("\n")) {
      void polaris()
        .request("extensions.list", { hostKey })
        .then((result) => {
          if (result.ok) setByHost((previous) => ({ ...previous, [hostKey]: result.value }));
        });
    }
  }, [askedKey]);

  return asked.flatMap((host): ReadonlyArray<VoicePairing> =>
    livePairings(byHost[host.key] ?? [])
      .filter((pairing) => pairing.grant.includes("voice"))
      .map((pairing) => ({ pairing, host }))
  );
};

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const VoiceExtensions = ({
  hosts,
  ready,
}: {
  readonly hosts: ReadonlyArray<HostView>;
  readonly ready: ReadonlySet<string>;
}) => {
  const { openSettings } = useShellActions();
  const now = useNow();
  const pairings = useVoicePairings(hosts);

  const readyHosts = new Set(
    pairings.flatMap(({ host }) => (ready.has(host.key) ? [host.key] : []))
  );

  return (
    <SettingsCard
      title="Extensions allowed voice"
      aside="Granted when they were paired"
      status={`${count(pairings.length, "extension")} · ${count(readyHosts.size, "host")} ready`}
      action={
        <SettingsButton onClick={() => openSettings("extensions")}>Open extensions</SettingsButton>
      }
    >
      {pairings.length === 0 ? (
        <SettingsEmpty>No extension is allowed voice; grant Voice when you pair one</SettingsEmpty>
      ) : (
        <SettingsWell aria-label="Extensions allowed voice">
          {pairings.map(({ pairing, host }) => (
            <div
              key={`${host.key}/${pairing.id}`}
              data-testid="voice-extension"
              className="px-panel flex items-center gap-3 py-[calc(var(--spacing-gap)+4px)]"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body text-text-default truncate">{pairing.name}</span>
                <span className="text-caption text-text-subtle truncate">
                  Paired with {host.label} · {usedLine(pairing, now)}
                </span>
              </div>
              <span className="text-caption text-text-subtle shrink-0">
                {ready.has(host.key) ? "Ready" : `No key on ${host.label}`}
              </span>
            </div>
          ))}
        </SettingsWell>
      )}
    </SettingsCard>
  );
};

export const VoicePage = () => {
  const hosts = useApp((s) => s.hosts);
  const info = sectionInfo("voice");
  const { stateOf, setKey } = useVoiceKeys(answering(hosts, "voice").map((h) => h.key));
  const ready = new Set(keySetOn(hosts, stateOf).map((h) => h.key));

  return (
    <SettingsPage
      title={info.title}
      blurb="Listening extensions send audio to a host, which transcribes it with its own Deepgram key."
      scope="Each host"
      scopeIcon={<ScreenGlyph />}
    >
      <SettingsCard title="Deepgram key" aside={setOnLine(ready.size, hosts.length)}>
        <SettingsWell aria-label="Deepgram key on each host">
          {hosts.map((host) => (
            <KeyRow
              key={host.key}
              host={host}
              state={stateOf(host.key)}
              setKey={(key) => setKey(host.key, key)}
            />
          ))}
        </SettingsWell>
        <p className="text-caption text-text-subtle px-gap pb-[calc(var(--spacing-gap)+4px)]">
          Or run <span className="text-text-default font-mono">{CLI_HINT}</span> on a host; it reads
          the key without showing it.
        </p>
      </SettingsCard>
      <VoiceExtensions hosts={hosts} ready={ready} />
    </SettingsPage>
  );
};
