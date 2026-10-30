/**
 * Settings → About (DESIGN.md, SR-12): the mark with "Polaris {version}" from the running app,
 * quiet app Updates, the precise per-check privacy fields, and each host's daemon version.
 */
import { Match } from "effect";
import {
  Dither,
  FolderIcon,
  PixelCheckIcon,
  PixelPolarisIcon,
  SettingsButton,
  SettingsCard,
  SettingsGrid,
  SettingsHostRow,
  SettingsToggleRow,
  SettingsWell,
} from "@polaris/ui";
import type { AppUpdateView } from "../../../../shared/appUpdates.ts";
import { clientCopy } from "../../../../shared/clientCopy.ts";
import { clientPlatform, toClientPlatform } from "../../../../shared/platform.ts";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { polaris } from "../../bridge.ts";
import { useSettings } from "../store.ts";
import { appUpdateRow, checkedAt, type AppUpdateRow } from "../updates/model.ts";
import {
  checkForUpdates,
  restartToUpdate,
  setAutomaticUpdates,
  showUpdateInFinder,
  useUpdates,
} from "../updates/store.ts";

const Glyph = ({ kind }: { readonly kind: AppUpdateRow["glyph"] }) => {
  switch (kind) {
    case "working":
      return <Dither hue="starlight" size={16} />;
    case "check":
      return <PixelCheckIcon size={16} className="text-text-subtle" />;
    case "star":
      return <PixelPolarisIcon size={16} className="text-starlight" />;
    case "folder":
      return <FolderIcon size={16} className="text-text-subtle" />;
    case "failed":
      return (
        <span
          aria-hidden
          className="text-caption text-text-subtle grid size-4 place-items-center rounded-full border"
        >
          !
        </span>
      );
    case "off":
      return (
        <span aria-hidden className="border-text-subtle size-4 rounded-full border border-dashed" />
      );
  }
};

const ACTIONS = { check: checkForUpdates, restart: restartToUpdate, finder: showUpdateInFinder };

const releaseNotes = (version: string) =>
  void polaris().request("shell.openExternal", {
    url: `https://github.com/luxdotdev/polaris/releases/tag/v${encodeURIComponent(version)}`,
  });

/** The About header and version row for the platform main reports (the Client's own otherwise). */
const aboutPlatform = (view: AppUpdateView) => {
  const platform = view.platform ?? clientPlatform();
  const { os, machine } = clientCopy(platform);

  return Match.value(toClientPlatform(platform)).pipe(
    Match.when("win32", () => ({
      os,
      device: machine,
      description: `Windows ${view.arch} · experimental`,
    })),
    Match.when("darwin", () => ({
      os,
      device: machine,
      description: view.arch === "arm64" ? "Apple silicon" : view.arch,
    })),
    Match.orElse(() => ({ os, device: machine, description: `Linux ${view.arch}` }))
  );
};

/** Core version parts, so "0.4.2" sorts below "0.5.0"; pre-release tags are ignored here. */
const core = (version: string) => (version.split(/[-+]/)[0] ?? "").split(".").map(Number);

const olderThan = (version: string, than: string) => {
  const [a, b] = [core(version), core(than)];

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);

    if (diff !== 0) return diff < 0;
  }

  return false;
};

/** The mark, then "Polaris {version}" as the running app reports it, never a constant. */
const Header = ({ version, platform }: { readonly version: string; readonly platform: string }) => (
  <header className="flex items-center gap-4 py-2 pb-[calc(var(--spacing-section)-4px)]">
    <div
      aria-hidden
      className="bg-raised grid size-12 shrink-0 place-items-center rounded-[12px] shadow-[inset_0_0_0_1px_var(--color-hairline)]"
    >
      <PixelPolarisIcon size={24} className="text-text-strong" />
    </div>
    <div className="flex min-w-0 flex-col gap-0.5">
      <h1
        className="text-text-strong font-[600] tracking-[-0.01em]"
        style={{
          fontSize: "round(calc(22px * var(--text-scale, 1)), 1px)",
          lineHeight: "round(calc(28px * var(--text-scale, 1)), 1px)",
        }}
        data-testid="about-version"
      >
        Polaris {version}
      </h1>
      <p className="text-body text-text-subtle">{platform} · Apache-2.0</p>
    </div>
  </header>
);

const UpdateRow = ({ view, row }: { readonly view: AppUpdateView; readonly row: AppUpdateRow }) => (
  <div
    className="px-panel gap-gap flex items-center py-[calc(var(--spacing-gap)+4px)]"
    data-testid="app-update"
    data-update={view.phase}
  >
    <span className="shrink-0" aria-hidden>
      <Glyph kind={row.glyph} />
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5" role="status">
      <span className="text-body text-text-default truncate">{row.title}</span>
      <span className="text-caption text-text-subtle truncate">{row.caption}</span>
    </div>
    <div className="gap-gap flex shrink-0 items-center">
      {view.phase === "ready" && view.availableVersion !== null ? (
        <SettingsButton variant="ghost" onClick={() => releaseNotes(view.availableVersion ?? "")}>
          Release notes
        </SettingsButton>
      ) : null}
      {row.action === null ? null : (
        <SettingsButton
          variant={row.action === "restart" ? "primary" : "secondary"}
          disabled={row.action === "check" && !view.supported}
          onClick={() => void ACTIONS[row.action ?? "check"]()}
        >
          {row.actionLabel}
        </SettingsButton>
      )}
    </div>
  </div>
);

const Updates = ({
  view,
  changing,
}: {
  readonly view: AppUpdateView;
  readonly changing: boolean;
}) => {
  const row = appUpdateRow(view);
  const working = view.phase === "checking" || view.phase === "downloading";

  const found = view.availableVersion === null ? "" : ` · found ${view.availableVersion}`;

  const checked =
    view.lastCheckedAt === null ? checkedAt(null) : `Last checked ${checkedAt(view.lastCheckedAt)}`;

  return (
    <SettingsCard
      title="Updates"
      status={`${checked}${found}`}
      action={
        row.action === "check" ? undefined : (
          <SettingsButton
            disabled={working || view.phase === "ready" || !view.supported}
            onClick={() => void checkForUpdates()}
          >
            Check now
          </SettingsButton>
        )
      }
    >
      <SettingsWell>
        <UpdateRow view={view} row={row} />
        <SettingsToggleRow
          title="Check for updates automatically"
          caption={
            view.automatic
              ? "On launch and every 6 hours; downloads in the background"
              : "Off · Polaris checks only when you choose Check now"
          }
          checked={view.automatic}
          disabled={changing || !view.supported}
          onCheckedChange={(enabled) => void setAutomaticUpdates(enabled)}
        />
      </SettingsWell>
    </SettingsCard>
  );
};

const WhatPolarisSends = ({ view }: { readonly view: AppUpdateView }) => {
  const platform = aboutPlatform(view);

  const fields: ReadonlyArray<readonly [string, string]> = [
    [
      "Install ID",
      view.automatic
        ? `${view.installId.slice(0, 4)}…${view.installId.slice(-4)}`
        : "Not sent while automatic checks are off",
    ],
    ["Version", view.version],
    ["Arch", view.arch],
    [platform.os, view.osVersion],
  ];

  return (
    <SettingsCard
      title={
        view.automatic ? "What Polaris sends with each check" : "What Polaris sends when you check"
      }
    >
      <SettingsWell>
        <dl className="divide-hairline flex flex-col divide-y" data-testid="update-fields">
          {fields.map(([label, value]) => (
            <div key={label} className="px-panel flex items-center gap-3 py-2.5">
              <dt className="text-body text-text-default min-w-0 flex-1">{label}</dt>
              <dd
                className="text-text-default font-mono text-[12px] leading-4 break-all"
                title={
                  label === "Install ID" && view.automatic
                    ? `Random, made on ${platform.device}`
                    : undefined
                }
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </SettingsWell>
      <p className="text-caption text-text-subtle pl-gap flex min-h-10 items-center">
        Nothing else: no account, host, workspace or IP.
      </p>
    </SettingsCard>
  );
};

/** Each host's daemon version against this app's; an older one says it can upgrade. */
const Daemons = ({ version }: { readonly version: string }) => {
  const hosts = useApp((s) => s.hosts);
  const { openSettings } = useShellActions();
  const connected = hosts.filter((h) => h.status.state === "connected" && h.status.host !== null);

  const current = connected.filter(
    (h) => !olderThan(h.status.host?.daemonVersion ?? "", version)
  ).length;

  return (
    <SettingsCard
      title="Daemons on your hosts"
      aside={connected.length === 0 ? undefined : `${current} of ${connected.length} current`}
      action={<SettingsButton onClick={() => openSettings("hosts")}>Open hosts</SettingsButton>}
      data-testid="about-daemons"
    >
      <SettingsWell>
        {hosts.map((host) => {
          const daemon = host.status.host?.daemonVersion ?? null;
          const offline = host.status.state !== "connected" || daemon === null;
          const older = daemon !== null && olderThan(daemon, version);

          return (
            <SettingsHostRow
              key={host.key}
              name={host.label}
              colour={host.colour ?? "var(--color-text-faint)"}
              offline={offline}
            >
              <span
                className={`font-mono text-[12px] leading-4 ${older ? "text-text-subtle" : "text-text-default"}`}
                data-testid="daemon-version"
              >
                {older ? `${daemon} · upgrade` : daemon}
              </span>
            </SettingsHostRow>
          );
        })}
        <p className="px-panel text-caption text-text-subtle py-2.5">Daemons upgrade from Hosts</p>
      </SettingsWell>
    </SettingsCard>
  );
};

export const AboutPage = () => {
  const { view, problem, changing } = useUpdates((s) => s);
  const appVersion = useSettings((s) => s.version);

  if (view === null)
    return (
      <div className="mx-auto w-[860px] max-w-[calc(100%-2rem)] py-[calc(var(--spacing-section)+16px)]">
        <p className="text-body text-text-subtle">
          {problem ?? "Reading Polaris's update settings…"}
        </p>
      </div>
    );

  const version = view.version || appVersion;

  return (
    <div className="gap-gap mx-auto flex w-[860px] max-w-[calc(100%-2rem)] flex-col py-[calc(var(--spacing-section)+16px)]">
      <Header version={version} platform={aboutPlatform(view).description} />
      <Updates view={view} changing={changing} />
      {problem === null ? null : (
        <p role="status" className="text-caption text-text-subtle px-panel">
          {problem}
        </p>
      )}
      <SettingsGrid>
        <WhatPolarisSends view={view} />
        <Daemons version={version} />
      </SettingsGrid>
    </div>
  );
};
