/**
 * Settings → Constellations (DESIGN.md, SR-04): what a new Constellation's workers start on, per
 * role (spec §4, precedence 3), drawn as a star chart over the role rows; then how many workers
 * each host runs at once, shown here and edited in Hosts; then the permissions workers inherit.
 */
import type { PermissionMode } from "@polaris/protocol";
import {
  hueVar,
  SettingsButton,
  SettingsCard,
  SettingsGrid,
  SettingsHostRow,
  SettingsPage,
  SettingsWell,
} from "@polaris/ui";
import { useCallback, useEffect, useState } from "react";
import type { HostView } from "../../../../shared/api.ts";
import type { RoleDefault } from "../../../../shared/contract.ts";
import { DEFAULT_SESSION_PREFS } from "../../../../shared/sessionPrefs.ts";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { useDefaultsSync } from "../defaultsSync.ts";
import { syncLines } from "../model/constellationDefaults.ts";
import type { WorkerCap } from "../model/resources.ts";
import { harnessName, sameChoice } from "../model/reviewer.ts";
import { sectionInfo } from "../model/sections.ts";
import { useHostResources } from "../resources.ts";
import { setSessionPrefs, useSessionDefault, useSettings } from "../store.ts";
import { ReviewerChoice } from "./ReviewerChoice.tsx";
import { useModelHost } from "./ReviewerPage.tsx";

type Role = keyof typeof DEFAULT_SESSION_PREFS.constellationDefaults;

const ROLES: ReadonlyArray<{
  readonly role: Role;
  readonly title: string;
  readonly caption: string;
}> = [
  {
    role: "backend",
    title: "Backend and infrastructure",
    caption: "Servers, APIs, data, tests and scripts; anything that isn't UI",
  },
  {
    role: "ui",
    title: "Frontend and design",
    caption: "Interfaces, components, styling, mockups and copy",
  },
];

/** A role's two worker stars: lit, and a fainter one behind it (Paper SR-04's hero well). */
const RoleStars = ({ harness, x }: { readonly harness: string; readonly x: number }) => {
  const shade = `color-mix(in srgb, ${hueVar(harness)} 72%, black)`;

  return [28, 92].map((y, i) => (
    <g key={y} style={{ opacity: i === 0 ? 1 : 0.45 }}>
      <path
        d={`M${x - 6} ${y - 6}h12v2h2v8h-2v2h-12v-2h-2v-8h2z`}
        style={{ fill: hueVar(harness) }}
      />
      <path d={`M${x - 14} ${y - 1}h28v2h-28z`} style={{ fill: shade }} />
    </g>
  ));
};

const LABEL = "text-text-subtle absolute top-3.5 font-mono text-[10px] leading-3 tracking-[0.06em]";

/** The lead in the middle, each role's workers out to its side in its harness's hue. */
const StarChart = ({ backend, ui }: { readonly backend: string; readonly ui: string }) => (
  <SettingsWell rows={false} className="relative h-[150px] items-center justify-center">
    <svg
      aria-hidden
      width={560}
      height={120}
      viewBox="0 0 560 120"
      className="pixelated shrink-0"
      data-testid="worker-chart"
    >
      <path
        d="M280 60L120 28M280 60L440 28M280 60L120 92M280 60L440 92"
        strokeDasharray="2 3"
        style={{ stroke: "var(--color-text-faint)", opacity: 0.5 }}
      />
      <path
        d="M276 50h8v4h4v4h4v4h-4v4h-4v4h-8v-4h-4v-4h-4v-4h4v-4h4z"
        style={{ fill: "var(--color-text-strong)" }}
      />
      <path
        d="M279 42h2v6h-2zM279 72h2v6h-2zM262 59h6v2h-6zM292 59h6v2h-6z"
        style={{ fill: "var(--color-text-subtle)" }}
      />
      <RoleStars harness={backend} x={120} />
      <RoleStars harness={ui} x={440} />
      <path
        d="M200 44h2v2h-2zM360 76h2v2h-2zM520 50h2v2h-2zM40 66h2v2h-2zM330 18h2v2h-2z"
        style={{ fill: "var(--color-text-faint)" }}
      />
    </svg>
    <span className={`${LABEL} left-[calc(50%-104px)] -translate-x-full`}>
      BACKEND AND INFRASTRUCTURE
    </span>
    <span className={`${LABEL} left-[calc(50%+104px)]`}>FRONTEND AND DESIGN</span>
    <span className="text-text-strong absolute bottom-3.5 font-mono text-[10px] leading-3 tracking-[0.06em]">
      LEAD
    </span>
  </SettingsWell>
);

/** Once the card is wide enough, the selects line up in columns across rows (SR-04). */
const ROLE_WELL =
  "@min-[640px]/workers:grid @min-[640px]/workers:grid-cols-[minmax(180px,1fr)_auto_auto_auto_auto] @min-[640px]/workers:gap-x-3";

const ROLE_ROW = [
  "px-panel flex flex-wrap items-center gap-3 py-3",
  "@min-[640px]/workers:col-span-full @min-[640px]/workers:grid @min-[640px]/workers:grid-cols-subgrid",
  "@min-[640px]/workers:[&>div:nth-child(2)]:contents",
  "@min-[640px]/workers:[&_[data-slot=select-trigger]]:w-full @min-[640px]/workers:[&_[data-slot=select-trigger]]:justify-start",
  "@min-[640px]/workers:[&_[data-slot=select-trigger]>svg:last-child]:ml-auto",
].join(" ");

const RoleRow = ({
  title,
  caption,
  value,
  fallback,
  onChange,
}: {
  readonly title: string;
  readonly caption: string;
  readonly value: RoleDefault;
  readonly fallback: RoleDefault;
  readonly onChange: (value: RoleDefault) => void;
}) => {
  const modelHost = useModelHost();

  return (
    <div className={ROLE_ROW} data-testid="worker-role">
      <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
        <span className="text-body text-text-default truncate">{title}</span>
        <span className="text-caption text-text-subtle">{caption}</span>
      </div>
      <ReviewerChoice
        value={value}
        onChange={(choice) => {
          if (choice !== null) onChange(choice);
        }}
        modelHost={modelHost}
        allowAuto={false}
      />
      <span className="flex w-11 shrink-0 justify-end">
        {sameChoice(value, fallback) ? null : (
          <SettingsButton variant="quiet" onClick={() => onChange(fallback)}>
            Reset
          </SettingsButton>
        )}
      </span>
    </div>
  );
};

/** Which hosts hold the defaults, as the card's status line: a lead uses its own host's copy. */
const useWhereSaved = () => {
  const sync = useDefaultsSync();
  const hosts = useApp((s) => s.hosts);

  return syncLines(
    hosts.flatMap((h) => {
      const state = sync[h.key];

      return state === undefined || h.status.state !== "connected"
        ? []
        : [{ label: h.label, sync: state }];
    })
  )
    .map((line) => line.replace(/\.$/, ""))
    .join(" · ");
};

const WorkersStartOn = () => {
  const defaults = useSettings((s) => s.sessions.constellationDefaults);
  const fallback = DEFAULT_SESSION_PREFS.constellationDefaults;
  const saved = useWhereSaved();
  const { openSettings } = useShellActions();

  return (
    <SettingsCard
      title="Workers start on"
      aside="By the kind of task · the lead's choice comes first"
      status={saved === "" ? undefined : <span data-testid="defaults-sync">{saved}</span>}
      action={
        <SettingsButton onClick={() => openSettings("usage")}>Spend in Usage…</SettingsButton>
      }
      data-testid="constellation-defaults"
      className="@container/workers"
    >
      <StarChart backend={defaults.backend.harness} ui={defaults.ui.harness} />
      <SettingsWell className={ROLE_WELL}>
        {ROLES.map(({ role, title, caption }) => (
          <RoleRow
            key={role}
            title={title}
            caption={caption}
            value={defaults[role]}
            fallback={fallback[role]}
            onChange={(value) =>
              setSessionPrefs({ constellationDefaults: { ...defaults, [role]: value } })
            }
          />
        ))}
      </SettingsWell>
    </SettingsCard>
  );
};

/** Fits the host row's fact lane in a two-up card. */
const METER = 96;

/** One slot per worker the host runs at once, the working ones lit; wide caps get thinner slots. */
const SlotMeter = ({ cap }: { readonly cap: WorkerCap }) => {
  const slots = Math.max(1, cap.cap);
  const gap = slots > 24 ? 1 : slots > 8 ? 2 : 4;
  const width = Math.max(1, Math.floor((METER - gap * (slots - 1)) / slots));

  return (
    <svg
      aria-hidden
      width={METER}
      height={10}
      viewBox={`0 0 ${METER} 10`}
      className="pixelated block shrink-0"
      data-testid="worker-slots"
      data-working={cap.working}
      data-slots={slots}
    >
      {Array.from({ length: slots }, (_, i) => (
        <rect
          key={i}
          x={i * (width + gap)}
          width={width}
          height={10}
          style={{
            fill: i < cap.working ? "var(--color-text-strong)" : "light-dark(#0000000f, #ffffff12)",
          }}
        />
      ))}
    </svg>
  );
};

const COUNT = "text-text-subtle w-14 text-right font-mono text-[11px] leading-4 tabular";

/** A connected host's slots, read from its daemon; reports its cap up for the footer's totals. */
const HostSlots = ({
  host,
  onCap,
}: {
  readonly host: HostView;
  readonly onCap: (key: string, cap: WorkerCap | null) => void;
}) => {
  const { state } = useHostResources(host.key);
  const cap = state.kind === "loaded" ? state.snapshot.workerCap : null;

  useEffect(() => {
    onCap(host.key, cap);
  }, [host.key, cap, onCap]);

  const fact =
    state.kind === "loading" ? (
      "Reading…"
    ) : cap === null ? (
      "This daemon doesn't run workers"
    ) : (
      <span className="flex items-center gap-3">
        <SlotMeter cap={cap} />
        {cap.waiting === 0 ? null : <span>{cap.waiting} waiting</span>}
      </span>
    );

  return (
    <SettingsHostRow
      name={host.label}
      colour={host.colour ?? "var(--color-text-faint)"}
      fact={fact}
    >
      <span className={COUNT} data-testid="worker-count">
        {cap === null ? "" : `${cap.working} / ${cap.cap}`}
      </span>
    </SettingsHostRow>
  );
};

/** "5 working · 13 free · 1 waiting", over the hosts that answered. */
const capTotals = (caps: ReadonlyArray<WorkerCap>) => {
  const working = caps.reduce((n, c) => n + c.working, 0);
  const free = caps.reduce((n, c) => n + Math.max(0, c.cap - c.working), 0);
  const waiting = caps.reduce((n, c) => n + c.waiting, 0);

  return [
    `${working} working`,
    `${free} free`,
    ...(waiting === 0 ? [] : [`${waiting} waiting`]),
  ].join(" · ");
};

/** Display only: capacity is set per host in Hosts (DESIGN.md, SR-04). */
const WorkersAtOnce = () => {
  const hosts = useApp((s) => s.hosts);
  const { openSettings } = useShellActions();
  const [caps, setCaps] = useState<Readonly<Record<string, WorkerCap | null>>>({});

  const onCap = useCallback(
    (key: string, cap: WorkerCap | null) =>
      setCaps((prev) => (prev[key] === cap ? prev : { ...prev, [key]: cap })),
    []
  );

  const answered = hosts.flatMap((h) => {
    const cap = h.status.state === "connected" ? caps[h.key] : undefined;

    return cap == null ? [] : [cap];
  });

  return (
    <SettingsCard
      title="Workers at once"
      aside="Set per host"
      status={answered.length === 0 ? undefined : capTotals(answered)}
      action={<SettingsButton onClick={() => openSettings("hosts")}>Hosts…</SettingsButton>}
      data-testid="workers-at-once"
    >
      <SettingsWell>
        {hosts.map((host) =>
          host.status.state === "connected" ? (
            <HostSlots key={host.key} host={host} onCap={onCap} />
          ) : (
            <SettingsHostRow
              key={host.key}
              name={host.label}
              colour={host.colour ?? "var(--color-text-faint)"}
              offline
            />
          )
        )}
      </SettingsWell>
    </SettingsCard>
  );
};

const PERMISSION: Readonly<Record<PermissionMode, string>> = {
  plan: "Plan",
  supervised: "Supervised",
  "auto-edits": "Auto edits",
  auto: "Auto",
  "full-access": "Full access",
};

const PermissionRow = ({ harness }: { readonly harness: string }) => {
  const mode = useSessionDefault(harness)?.permissionMode ?? "supervised";

  return (
    <div className="px-panel flex h-12 items-center gap-2.5">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-[2px]"
        style={{ backgroundColor: hueVar(harness) }}
      />
      <span className="text-body text-text-default min-w-0 flex-1 truncate">
        {harnessName(harness)} workers
      </span>
      <span className="text-caption text-text-subtle shrink-0">{PERMISSION[mode]}</span>
    </div>
  );
};

const Permissions = () => {
  const defaults = useSettings((s) => s.sessions.constellationDefaults);
  const { openSettings } = useShellActions();
  const harnesses = [...new Set([defaults.backend.harness, defaults.ui.harness])];

  return (
    <SettingsCard
      title="Permissions"
      aside="From Harnesses"
      action={<SettingsButton onClick={() => openSettings("harnesses")}>Harnesses…</SettingsButton>}
    >
      <SettingsWell>
        {harnesses.map((harness) => (
          <PermissionRow key={harness} harness={harness} />
        ))}
        <p className="px-panel text-caption text-text-subtle flex h-12 items-center">
          You can still change a worker after it starts
        </p>
      </SettingsWell>
    </SettingsCard>
  );
};

const ScreenGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="2" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" />
    <path d="M4 10.5h4" stroke="currentColor" strokeLinecap="round" />
  </svg>
);

export const ConstellationsPage = () => (
  <SettingsPage
    title={sectionInfo("constellations").title}
    blurb="What a lead's workers start on when the lead doesn't say."
    scope="Saved on each host"
    scopeIcon={<ScreenGlyph />}
  >
    <WorkersStartOn />
    <SettingsGrid>
      <WorkersAtOnce />
      <Permissions />
    </SettingsGrid>
  </SettingsPage>
);
