/** SR-02's Editing card: Vim, autosave, format on save and inline diagnostics behind one switch each. */
import { clientCopy } from "../../../../shared/clientCopy.ts";
import * as P from "@polaris/protocol";
import { SettingsCard, SettingsToggleRow, SettingsWell } from "@polaris/ui";
import { currentKeyPlatform, shortcutLabel } from "../../../../shared/chord.ts";
import { commandShortcut, digitChord } from "../../../../shared/keymap.ts";
import type { ReactNode } from "react";
import { withKey, type SettingsRecord } from "./records.ts";

const vimCaption = () => {
  const chip = shortcutLabel(digitChord(0, currentKeyPlatform()) ?? "Ctrl+1");

  return `:w, :q, :wq, :e · ${commandShortcut("editor.findFile")} and ${chip}…9 still work`;
};

type Change = (settings: P.LanguageSettingsPatch) => P.LanguageSettingsPatch;

export interface EditorKeys {
  readonly vim: boolean;
  readonly autosave: boolean;
  readonly onVim: (on: boolean) => void;
  readonly onAutosave: (on: boolean) => void;
  readonly inlineDiagnostics: boolean;
  readonly onInlineDiagnostics: (on: boolean) => void;
  /** The commit messages' Harness and Model chips; absent in tests. */
  readonly commitMessages?: ReactNode;
}

export const Preferences = ({
  record,
  failed,
  onChange,
  keys,
}: {
  /** The App-scope language settings record; null while it loads. */
  readonly record: SettingsRecord | null;
  readonly failed: boolean;
  readonly onChange: (change: Change) => void;
  readonly keys: EditorKeys;
}) => {
  const formatOnSave = record?.settings.formatOnSave ?? true;
  const on = [keys.vim, keys.autosave, formatOnSave, keys.inlineDiagnostics].filter(Boolean).length;

  return (
    <SettingsCard
      title="Editing"
      aside={`${on} of 4 on`}
      status={
        failed
          ? "Couldn't read or save these preferences · try again"
          : `Unsaved edits stay on ${clientCopy().machine} either way`
      }
    >
      <SettingsWell>
        <SettingsToggleRow
          title="Vim mode"
          caption={vimCaption()}
          checked={keys.vim}
          onCheckedChange={keys.onVim}
        />
        <SettingsToggleRow
          title="Autosave after a short pause"
          caption="Never overwrites a newer version on disk"
          checked={keys.autosave}
          onCheckedChange={keys.onAutosave}
        />
        <SettingsToggleRow
          title="Format on save"
          caption="Each language's formatter, with the project's config"
          disabled={record === null}
          checked={formatOnSave}
          onCheckedChange={(next) => onChange(withKey("formatOnSave", next))}
        />
        <SettingsToggleRow
          title="Inline diagnostics"
          caption="Each line's worst problem at its end"
          checked={keys.inlineDiagnostics}
          onCheckedChange={keys.onInlineDiagnostics}
        />
      </SettingsWell>
    </SettingsCard>
  );
};
