/**
 * Settings → Harnesses (DESIGN.md, Settings redesign SR-03): a readiness matrix of harness ×
 * host, then each harness's defaults for new sessions in its own card. Polaris never installs
 * a harness: a missing one links its setup guide, and sign-in runs the harness's own command.
 */
import type { PermissionMode } from "@polaris/protocol";
import {
  cn,
  Dither,
  Kicker,
  SettingsButton,
  SettingsCard,
  SettingsGrid,
  SettingsPage,
  SettingsSelectRow,
  SettingsWell,
  Tile,
} from "@polaris/ui";
import { useState } from "react";
import type { SessionDefault } from "../../../../shared/api.ts";
import { slots } from "../../../app/slots.tsx";
import { useApp } from "../../../shell/hooks.ts";
import { ColourSquare } from "../../machines/page/parts.tsx";
import { choose, type ModelData, shortlist, useHarnessModels } from "../../harness/index.ts";
import {
  type HarnessGroup,
  harnessGroups,
  type HostRow,
  type ProbedHost,
} from "../model/harnesses.ts";
import { sectionInfo } from "../model/sections.ts";
import { setSessionDefault, useSessionDefault } from "../store.ts";
import { GLYPHS } from "./harnessRow.tsx";
import { useHostProbes } from "./hostProbes.ts";

// ── The matrix as data ──────────────────────────────────────────────────────

/** A harness that needs signing in on a host, and the command that does it. */
export interface SignIn {
  readonly harness: string;
  readonly name: string;
  readonly hostKey: string;
  readonly hostLabel: string;
  readonly argv: ReadonlyArray<string>;
}

/** "7 of 20 ready · 1 needs sign-in", the matrix's aside. */
export const readiness = (groups: ReadonlyArray<HarnessGroup>): string => {
  const rows = groups.flatMap((group) => group.rows);
  const ready = rows.filter((row) => row.ready).length;
  const signIn = rows.filter((row) => row.glyph === "sign-in").length;

  return `${ready} of ${rows.length} ready${signIn === 0 ? "" : ` · ${signIn} ${signIn === 1 ? "needs" : "need"} sign-in`}`;
};

/** A cell's sign-in, when its harness needs one on that host. */
const signInOf = (group: HarnessGroup, row: HostRow): SignIn | undefined =>
  row.action?.kind === "sign-in"
    ? {
        harness: group.kind,
        name: group.name,
        hostKey: row.hostKey,
        hostLabel: row.hostLabel,
        argv: row.action.argv,
      }
    : undefined;

/** The sign-in kinds the hosts report ("Claude Max"), each once. */
export const signInKinds = (
  hosts: ReadonlyArray<ProbedHost>,
  harness?: string
): ReadonlyArray<string> => [
  ...new Set(
    hosts.flatMap((host) =>
      host.probe.kind === "reported"
        ? host.probe.report.harnesses.flatMap((h) =>
            h.signInKind && (harness === undefined || h.harness === harness) ? [h.signInKind] : []
          )
        : []
    )
  ),
];

/** On some host already: it gets a defaults card; the rest share one "not installed" card. */
export const installedSomewhere = (group: HarnessGroup) =>
  group.rows.some((row) => row.ready || row.version !== null);

// ── Readiness ───────────────────────────────────────────────────────────────

const Mark = ({ kind, size = 20 }: { readonly kind: string; readonly size?: 18 | 20 | 24 }) => (
  <Tile hue={kind} size={size}>
    <Dither hue={kind} size={size === 24 ? 12 : 10} />
  </Tile>
);

/** One cell: the version when ready, else the state in words; an unreported host stays quiet. */
const Cell = ({ row, away }: { readonly row: HostRow; readonly away: boolean }) => {
  if (away) return <span className="text-caption text-text-subtle truncate">{row.text}</span>;

  return (
    <span className="flex min-w-0 items-center gap-1.5" title={row.note ?? row.text}>
      <span className="text-text-subtle flex w-3.5 shrink-0 justify-center [&_svg]:size-3">
        {GLYPHS[row.glyph]}
      </span>
      {row.ready && row.version !== null ? (
        <span className="text-text-default truncate font-mono text-[11px] leading-4">
          {row.version}
        </span>
      ) : (
        <span className="text-caption text-text-default truncate">{row.text}</span>
      )}
      {row.note === null ? null : (
        <span className="text-caption text-text-subtle shrink-0">· older</span>
      )}
    </span>
  );
};

const HARNESS_LANE = "w-[200px] shrink-0";

const Matrix = ({
  groups,
  hosts,
  colours,
  signingIn,
  onSignIn,
}: {
  readonly groups: ReadonlyArray<HarnessGroup>;
  readonly hosts: ReadonlyArray<ProbedHost>;
  readonly colours: Readonly<Record<string, string | null>>;
  readonly signingIn: SignIn | null;
  readonly onSignIn: (signIn: SignIn) => void;
}) => {
  const away = new Set(
    hosts
      .filter((h) => h.probe.kind !== "reported" && h.probe.kind !== "checking")
      .map((h) => h.hostKey)
  );

  return (
    <SettingsWell role="table" aria-label="Readiness" className="overflow-x-auto">
      <div role="row" className="px-panel flex items-center gap-3 py-2.5">
        <Kicker role="columnheader" className={cn(HARNESS_LANE, "text-text-subtle")}>
          Harness
        </Kicker>
        {hosts.map((host) => (
          <span
            key={host.hostKey}
            role="columnheader"
            className={cn(
              "flex min-w-[110px] flex-1 items-center gap-1.5",
              away.has(host.hostKey) && "opacity-(--opacity-dimmed)"
            )}
          >
            <ColourSquare colour={colours[host.hostKey] ?? null} size={8} />
            <Kicker className="text-text-subtle truncate">{host.label}</Kicker>
          </span>
        ))}
      </div>
      {groups.map((group) => (
        <div
          key={group.kind}
          role="row"
          data-testid="harness-row"
          className={cn(
            "px-panel flex items-center gap-3 py-[calc(var(--spacing-gap)+4px)]",
            !installedSomewhere(group) && "text-text-subtle"
          )}
        >
          <span role="rowheader" className={cn(HARNESS_LANE, "flex items-center gap-2.5")}>
            <Mark kind={group.kind} size={18} />
            <span className="text-body truncate">{group.name}</span>
          </span>
          {group.rows.map((row) => {
            const signIn = away.has(row.hostKey) ? undefined : signInOf(group, row);

            return (
              <span
                key={row.hostKey}
                role="cell"
                className="flex min-w-[110px] flex-1 items-center gap-2"
                aria-label={`${group.name} on ${row.hostLabel}: ${row.version ?? row.text}`}
              >
                {signIn === undefined ? (
                  <Cell row={row} away={away.has(row.hostKey)} />
                ) : (
                  <SettingsButton
                    variant="ghost"
                    aria-label={`Sign in to ${group.name} on ${row.hostLabel}`}
                    aria-pressed={
                      signingIn?.harness === signIn.harness && signingIn.hostKey === signIn.hostKey
                    }
                    onClick={() => onSignIn(signIn)}
                  >
                    Sign in
                  </SettingsButton>
                )}
              </span>
            );
          })}
        </div>
      ))}
    </SettingsWell>
  );
};

/** The matrix, each cell needing sign-in with its own button; the terminal opens under it. */
export const ReadinessCard = ({
  groups,
  hosts,
  colours,
  refresh,
}: {
  readonly groups: ReadonlyArray<HarnessGroup>;
  readonly hosts: ReadonlyArray<ProbedHost>;
  readonly colours: Readonly<Record<string, string | null>>;
  readonly refresh: (hostKey: string) => void;
}) => {
  const [signingIn, setSigningIn] = useState<SignIn | null>(null);

  return (
    <SettingsCard
      title="Readiness"
      aside={readiness(groups)}
      status={[...signInKinds(hosts), "Polaris never reads your keys"].join(" · ")}
    >
      <Matrix
        groups={groups}
        hosts={hosts}
        colours={colours}
        signingIn={signingIn}
        onSignIn={setSigningIn}
      />
      {signingIn === null ? null : (
        <SettingsWell
          key={`${signingIn.harness}@${signingIn.hostKey}`}
          rows={false}
          aria-label={`Sign in to ${signingIn.name} on ${signingIn.hostLabel}`}
        >
          <slots.HarnessTerminal
            hostKey={signingIn.hostKey}
            argv={signingIn.argv}
            onExit={() => refresh(signingIn.hostKey)}
            onClose={() => {
              setSigningIn(null);
              refresh(signingIn.hostKey);
            }}
          />
        </SettingsWell>
      )}
    </SettingsCard>
  );
};

// ── Defaults per harness ────────────────────────────────────────────────────

/** The select value meaning "the harness's own default" (null). */
const DEFAULT = "default";

const PERMISSIONS: ReadonlyArray<{ readonly value: PermissionMode; readonly label: string }> = [
  { value: "plan", label: "Plan" },
  { value: "supervised", label: "Supervised" },
  { value: "auto-edits", label: "Auto edits" },
  { value: "auto", label: "Auto" },
  { value: "full-access", label: "Full access" },
];

const NONE: SessionDefault = { model: null, effort: null, permissionMode: "supervised" };

/** The picker's models (shared cache); Claude Code's `default` row is our Default already. */
const useModels = (hostKey: string | null, harness: string): ReadonlyArray<ModelData> =>
  useHarnessModels(hostKey ?? "", harness, hostKey !== null).models.filter((m) => m.id !== DEFAULT);

/** Model, effort and permissions new sessions start with, saved for the new-session page. */
const Defaults = ({
  harness,
  modelHost,
}: {
  readonly harness: string;
  /** A host where the harness is ready, to list its models; null leaves Default only. */
  readonly modelHost: string | null;
}) => {
  const current = useSessionDefault(harness) ?? NONE;
  const models = useModels(modelHost, harness);
  const model = models.find((m) => m.id === current.model);
  const efforts = model?.efforts ?? [];

  const save = (patch: Partial<SessionDefault>) =>
    setSessionDefault(harness, { ...current, ...patch });

  // The picker's shortlist (its newest four); a saved model outside it stays shown.
  const { top } = shortlist(harness, models);
  const saved = top.some((m) => m.id === current.model) ? null : current.model;

  const modelOptions = [
    { value: DEFAULT, label: "Default" },
    ...top.map((m) => ({ value: m.id, label: m.name })),
    ...(saved === null ? [] : [{ value: saved, label: model?.name ?? saved }]),
  ];

  return (
    <SettingsWell>
      <Kicker className="px-panel text-text-subtle pt-2.5 pb-1">New sessions start with</Kicker>
      <SettingsSelectRow
        title="Model"
        value={current.model ?? DEFAULT}
        options={modelOptions}
        onChange={(v) => {
          const next = models.find((m) => m.id === v);

          save(next === undefined ? { model: null, effort: null } : choose(next));
        }}
      />
      <SettingsSelectRow
        title="Effort"
        value={current.effort ?? DEFAULT}
        disabled={efforts.length === 0}
        options={[
          { value: DEFAULT, label: "Default" },
          ...efforts.map((e) => ({ value: e, label: e })),
        ]}
        onChange={(v) => save({ effort: v === DEFAULT ? null : v })}
      />
      <SettingsSelectRow
        title="Permissions"
        value={current.permissionMode}
        options={PERMISSIONS}
        onChange={(permissionMode) => save({ permissionMode })}
      />
    </SettingsWell>
  );
};

const openGuide = (url: string) => void window.polaris.request("shell.openExternal", { url });

/** The setup guide a host's row links to, when it needs installing or updating. */
const guideOf = (group: HarnessGroup) =>
  group.rows.flatMap((row) => (row.action?.kind === "setup-guide" ? [row.action.url] : []))[0];

const HarnessCard = ({
  group,
  hosts,
}: {
  readonly group: HarnessGroup;
  readonly hosts: ReadonlyArray<ProbedHost>;
}) => {
  const guide = guideOf(group);
  const older = group.rows.find((row) => row.note !== null);

  return (
    <SettingsCard
      aria-label={group.name}
      data-testid="harness-card"
      title={
        <span className="flex items-center gap-2.5">
          <Mark kind={group.kind} size={24} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{group.name}</span>
            <span className="text-caption text-text-subtle font-normal whitespace-normal">
              {group.caption}
            </span>
          </span>
        </span>
      }
      aside={group.summary}
      status={[
        ...signInKinds(hosts, group.kind),
        ...(older === undefined ? [] : [`${older.hostLabel} ${older.note}`]),
      ].join(" · ")}
      action={
        guide === undefined ? undefined : (
          <SettingsButton onClick={() => openGuide(guide)}>Open setup guide</SettingsButton>
        )
      }
    >
      <Defaults harness={group.kind} modelHost={group.rows.find((r) => r.ready)?.hostKey ?? null} />
    </SettingsCard>
  );
};

/** Harnesses on no host yet: one row each, with its setup guide. */
const NotInstalledCard = ({ groups }: { readonly groups: ReadonlyArray<HarnessGroup> }) => (
  <SettingsCard title="Not on any host" aside="Polaris never installs a harness">
    <SettingsWell>
      {groups.map((group) => {
        const guide = guideOf(group);

        return (
          <div
            key={group.kind}
            className="px-panel flex items-center gap-3 py-[calc(var(--spacing-gap)+4px)]"
          >
            <Mark kind={group.kind} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-body text-text-default truncate">{group.name}</span>
              <span className="text-caption text-text-subtle truncate">{group.summary}</span>
            </span>
            {guide === undefined ? null : (
              <SettingsButton
                variant="ghost"
                aria-label={`Open ${group.name}'s setup guide`}
                onClick={() => openGuide(guide)}
              >
                Open setup guide
              </SettingsButton>
            )}
          </div>
        );
      })}
    </SettingsWell>
  </SettingsCard>
);

const ScreenGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="2" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" />
    <path d="M4 10.5h4" stroke="currentColor" strokeLinecap="round" />
  </svg>
);

export const HarnessesPage = () => {
  const { hosts, refresh } = useHostProbes();
  const views = useApp((s) => s.hosts);
  const info = sectionInfo("harnesses");
  const groups = harnessGroups(hosts);
  const installed = groups.filter(installedSomewhere);
  const missing = groups.filter((group) => !installedSomewhere(group));
  const colours = Object.fromEntries(views.map((view) => [view.key, view.colour]));

  return (
    <SettingsPage
      title={info.title}
      blurb="The agent programs Polaris drives on each host. Each keeps its own sign-in."
      scope="Each host"
      scopeIcon={<ScreenGlyph />}
    >
      <ReadinessCard groups={groups} hosts={hosts} colours={colours} refresh={refresh} />
      {installed.length === 0 ? null : (
        <SettingsGrid>
          {installed.map((group) => (
            <HarnessCard key={group.kind} group={group} hosts={hosts} />
          ))}
        </SettingsGrid>
      )}
      {missing.length === 0 ? null : <NotInstalledCard groups={missing} />}
    </SettingsPage>
  );
};
