/**
 * Settings → Editor (DESIGN.md, Settings redesign SR-02): Editing beside Commit messages,
 * Tab completion, then Languages on the picked Host, with Advanced opened from its footer.
 */
import { clientCopy } from "../../../../shared/clientCopy.ts";
import * as P from "@polaris/protocol";
import { SettingsButton, SettingsGrid, SettingsPage } from "@polaris/ui";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { HostView, LanguageApi } from "../../../../shared/api.ts";
import { hostInSentence } from "../../../shell/hostCopy.ts";
import { Advanced } from "./Advanced.tsx";
import { useHostLanguages, useLanguageRecords, useRecord } from "./hooks.ts";
import { HostPicker, pickable } from "./HostPicker.tsx";
import { CommitMessagesCard, type CommitSource, useLastCommit } from "./CommitMessages.tsx";
import { LanguagesCard, readySummary } from "./Languages.tsx";
import type { PolicyWorkspace } from "./MarkdownImages.tsx";
import { languageRows, rowEnabled, syntaxOnly, syntaxOnlyLine } from "./model.ts";
import { Preferences, type EditorKeys } from "./Preferences.tsx";
import { APP_SCOPE, type SettingsScope, withKey } from "./records.ts";

export interface EditorSettingsProps {
  readonly tabCompletion?: ReactNode;
  readonly api: LanguageApi | undefined;
  readonly hosts: ReadonlyArray<HostView>;
  readonly workspacesOf: (hostKey: string) => ReadonlyArray<PolicyWorkspace>;
  readonly keys: EditorKeys;
  /** Open editors re-read their settings: every Host's when `hostKey` is null. */
  readonly refreshEditors: (hostKey: string | null) => void;
  readonly refreshPreviews: (hostKey: string, workspaceId: P.WorkspaceId) => void;
  /** The git checkout whose last commit the Commit messages preview shows; null shows the example. */
  readonly commitWorkspace?: CommitSource | null;
}

const ScreenGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="2" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" />
    <path d="M4 10.5h4" stroke="currentColor" strokeLinecap="round" />
  </svg>
);

const firstPickable = (hosts: ReadonlyArray<HostView>) =>
  (hosts.find((h) => pickable(h) && h.kind === "local") ?? hosts.find(pickable))?.key ?? null;

const notice = (
  api: LanguageApi | undefined,
  picked: HostView | undefined,
  failed: boolean,
  loaded: boolean
) => {
  if (!api)
    return `Language tools need a newer Polaris on ${clientCopy().machine}. Syntax highlighting still works.`;

  if (picked === undefined || !pickable(picked))
    return "Pick a connected host to see its languages.";

  if (failed)
    return `Couldn't read the languages on ${hostInSentence(picked)}. Try again in a moment.`;

  return loaded ? null : `Checking ${hostInSentence(picked)}…`;
};

/** Only a connected Daemon with `git.log` is asked; any other shows the example. */
const commitSource = (hosts: ReadonlyArray<HostView>, workspace: CommitSource | null) => {
  const host = workspace === null ? undefined : hosts.find((h) => h.key === workspace.hostKey);

  return host?.status.state === "connected" && host.status.capabilities.includes("git.log")
    ? workspace
    : null;
};

const NO_LANGUAGES: ReadonlyArray<P.LanguageSyntaxId> = [];

export const EditorSettings = ({
  tabCompletion,
  api,
  hosts,
  workspacesOf,
  keys,
  refreshEditors,
  refreshPreviews,
  commitWorkspace = null,
}: EditorSettingsProps) => {
  const [chosen, setChosen] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const hostKey = chosen ?? firstPickable(hosts);
  const picked = hosts.find((h) => h.key === hostKey);
  const live = picked !== undefined && pickable(picked) ? picked.key : null;

  const committed = useCallback(
    (scope: SettingsScope) =>
      refreshEditors(
        P.LanguageSettingsScope.match(scope, {
          App: () => null,
          Language: () => null,
          Host: () => live,
          Workspace: () => live,
        })
      ),
    [refreshEditors, live]
  );

  const lastCommit = useLastCommit(commitSource(hosts, commitWorkspace));

  const app = useRecord(api, hosts[0]?.key ?? "local", APP_SCOPE, committed);

  const facts = useHostLanguages(api, live);

  const rows = useMemo(
    () =>
      facts.catalog === null
        ? []
        : languageRows(facts.catalog, facts.availability, {
            host: hostInSentence(picked),
            downloadAutomatically: app.record?.settings.downloadLanguageToolsAutomatically ?? true,
          }),
    [facts, picked, app.record]
  );

  const languages = useMemo(
    () => (rows.length === 0 ? NO_LANGUAGES : [...new Set(rows.flatMap((r) => r.syntaxIds))]),
    [rows]
  );

  const switches = useLanguageRecords(api, hosts[0]?.key ?? null, languages, committed);

  const settingsOf = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(switches.records).map(([language, record]) => [language, record?.settings])
      ),
    [switches.records]
  );

  const identity = picked?.status.host ?? null;

  const languagesNotice = notice(api, picked, facts.failed, facts.catalog !== null);

  return (
    <SettingsPage
      title="Editor"
      blurb="How code reads and behaves in Edit. Language tools run on each host."
      scope={`${clientCopy().localHost} · language tools per host`}
      scopeIcon={<ScreenGlyph />}
    >
      <SettingsGrid>
        <Preferences
          record={app.record}
          failed={app.failed}
          onChange={(change) => void app.update(change)}
          keys={keys}
        />
        {keys.commitMessages === undefined ? null : (
          <CommitMessagesCard lastCommit={lastCommit} chooser={keys.commitMessages} />
        )}
      </SettingsGrid>
      {tabCompletion}
      <LanguagesCard
        rows={rows}
        enabled={(row) => rowEnabled(row, settingsOf)}
        onToggle={(row, on) => void switches.toggle(row.syntaxIds, on)}
        footLine={facts.catalog === null ? null : syntaxOnlyLine(syntaxOnly(facts.catalog))}
        notice={languagesNotice}
        summary={
          languagesNotice === null && picked !== undefined ? readySummary(rows, picked.label) : null
        }
        picker={<HostPicker hosts={hosts} value={hostKey} onChange={setChosen} />}
        download={{
          checked: app.record?.settings.downloadLanguageToolsAutomatically ?? true,
          disabled: app.record === null,
          onChange: (on) => void app.update(withKey("downloadLanguageToolsAutomatically", on)),
        }}
        action={
          <SettingsButton aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
            Advanced…
          </SettingsButton>
        }
      />
      {advanced ? (
        <Advanced
          api={api}
          host={
            live !== null && identity !== null && picked !== undefined
              ? { key: live, id: identity.hostId, label: picked.label }
              : null
          }
          providers={facts.catalog?.integrations.flatMap((i) => i.providers.map((p) => p.id)) ?? []}
          workspaces={live === null ? [] : workspacesOf(live)}
          committed={committed}
          onPolicySaved={(workspaceId) => live !== null && refreshPreviews(live, workspaceId)}
        />
      ) : null}
    </SettingsPage>
  );
};
