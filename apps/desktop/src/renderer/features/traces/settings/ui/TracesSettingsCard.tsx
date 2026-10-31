/**
 * One Workspace's Traces settings (DESIGN.md, Traces → Setup; Paper T4, right): copy into
 * Polaris, forward to the detected collector (header names only), automatic instrumentation with
 * its override, and what is kept. Gated on `traces.settings` by the page.
 */
import type {
  TraceAutoInstrument,
  WorkspaceTracesSettings,
  WorkspaceTracesSettingsUpdate,
} from "@polaris/protocol";
import {
  Input,
  SettingsButton,
  type SettingsOption,
  SettingsRow,
  SettingsSelectRow,
  SettingsToggleRow,
  SettingsWell,
} from "@polaris/ui";
import { useState } from "react";
import {
  checkForwardUrl,
  forwardCaption,
  headersLine,
  instrumentCaption,
  KEEP_LINE,
} from "../model.ts";

const INSTRUMENT: ReadonlyArray<SettingsOption<TraceAutoInstrument>> = [
  { value: "off", label: "Off" },
  { value: "node", label: "Node" },
  { value: "deno", label: "Deno" },
];

type Save = (patch: WorkspaceTracesSettingsUpdate) => void;

/** The collector's URL, saved on ↵ or Save; a URL the Daemon would refuse says why and keeps the old one. */
const ForwardUrl = ({
  settings,
  disabled,
  save,
}: {
  readonly settings: WorkspaceTracesSettings;
  readonly disabled: boolean;
  readonly save: Save;
}) => {
  const current = settings.forwardTo?.url ?? "";
  const [draft, setDraft] = useState(current);
  const check = checkForwardUrl(draft);
  const changed = draft.trim() !== current;
  const headers = settings.forwardTo?.headerNames ?? [];

  const commit = () => {
    if (!check.ok || !changed) return;
    save({ forwardTo: { url: check.url, headerNames: headers } });
  };

  return (
    <SettingsRow
      nested
      dimmed={!settings.forwarding}
      title={
        <Input
          aria-label="Collector URL"
          aria-invalid={changed && !check.ok}
          className="text-code-inline h-[26px] font-mono"
          value={draft}
          placeholder="https://collector.example.com/v1/traces"
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      }
      caption={changed && !check.ok ? check.reason : headersLine(headers)}
    >
      <SettingsButton variant="ghost" disabled={disabled || !changed || !check.ok} onClick={commit}>
        Save
      </SettingsButton>
    </SettingsRow>
  );
};

export const TracesSettingsCard = ({
  settings,
  disabled,
  save,
}: {
  readonly settings: WorkspaceTracesSettings;
  readonly disabled: boolean;
  readonly save: Save;
}) => (
  <SettingsWell data-testid="settings-traces-card">
    <SettingsToggleRow
      title="Copy traces into Polaris"
      caption="Commands agents and Polaris terminals run here send to Polaris first."
      checked={settings.enabled}
      disabled={disabled}
      onCheckedChange={(enabled) => save({ enabled })}
    />
    <SettingsToggleRow
      title="Forward traces to"
      caption={forwardCaption(settings)}
      checked={settings.forwarding}
      disabled={disabled || settings.forwardTo === null}
      onCheckedChange={(forwarding) => save({ forwarding })}
    />
    <ForwardUrl
      key={settings.forwardTo?.url ?? ""}
      settings={settings}
      disabled={disabled}
      save={save}
    />
    <SettingsSelectRow
      title="Instrument automatically"
      caption={instrumentCaption(settings)}
      value={settings.autoInstrument}
      options={INSTRUMENT}
      disabled={disabled}
      onChange={(autoInstrument) => save({ autoInstrument })}
    />
    {settings.autoInstrument !== "node" ? null : (
      <SettingsToggleRow
        nested
        title="Instrument even when the app sets up OpenTelemetry"
        caption="Skips the SDK check only. Bun and untrusted workspaces still aren't instrumented."
        checked={settings.autoInstrumentOverride}
        disabled={disabled}
        onCheckedChange={(autoInstrumentOverride) => save({ autoInstrumentOverride })}
      />
    )}
    <SettingsRow title="Keep" caption="Per checkout, on this host">
      <span className="text-code-inline text-text-subtle font-mono">{KEEP_LINE}</span>
    </SettingsRow>
  </SettingsWell>
);
