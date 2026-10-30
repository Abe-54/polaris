/**
 * Settings → Attachments (DESIGN.md, Settings redesign SR-06; ENG-180): a card per Host with
 * its disk use by Workspace, when staged attachments are deleted (a default and per-Workspace
 * overrides), and Clear now, confirming in place. Each Host keeps its own settings.
 */
import type { AttachmentCleanup, Workspace, WorkspaceId } from "@polaris/protocol";
import {
  cn,
  SettingsButton,
  SettingsCard,
  SettingsConfirmRow,
  SettingsEmpty,
  type SettingsOption,
  SettingsOverrideRow,
  SettingsPage,
  SettingsSelectRow,
  SettingsWell,
} from "@polaris/ui";
import { type ReactNode, useState } from "react";
import type { HostView } from "../../../../shared/api.ts";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { emptyHostModel } from "../../../store/hostModel.ts";
import { sectionInfo } from "../../settings/model/sections.ts";
import {
  amountLine,
  type CleanupSettings,
  filesLine,
  policyChoices,
  policyKey,
  policyLabel,
  policyOf,
  policyShort,
  usageSegments,
  withDefault,
  withWorkspace,
} from "../cleanup.ts";
import { formatSize } from "../model.ts";
import { type CleanupState, useCleanup } from "../useCleanup.ts";

const CAPABILITY = "attachments.settings";

const ScreenGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="2.5" width="9" height="6" rx="1" fill="none" stroke="currentColor" />
    <path d="M4 10.5h4" stroke="currentColor" />
  </svg>
);

/** Neutral steps, largest first: a share of disk, never a signal (rule/colour-means-something). */
const TONES = ["bg-text-strong", "bg-text-subtle", "bg-text-faint", "bg-hairline"];

const options = (current: AttachmentCleanup): ReadonlyArray<SettingsOption<string>> =>
  policyChoices(current).map((p) => ({
    value: policyKey(p),
    label: policyLabel(p),
    short: policyShort(p),
  }));

const HostName = ({ host }: { readonly host: HostView }) => (
  <span className="flex items-center gap-2">
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-[3px]"
      style={{ backgroundColor: host.colour ?? "var(--color-text-subtle)" }}
    />
    {host.label}
  </span>
);

const DiskUse = ({
  workspaces,
  usage,
}: {
  readonly workspaces: ReadonlyArray<Workspace>;
  readonly usage: Extract<CleanupState, { kind: "ready" }>["data"]["usage"];
}) => {
  const segments = usageSegments(workspaces, usage);
  const empty = workspaces.filter((w) => (usage.workspaces[w.id]?.files ?? 0) === 0);

  return (
    <div
      className="px-panel flex flex-col gap-2 py-[calc(var(--spacing-gap)+6px)]"
      data-testid="disk-use"
    >
      <div className="bg-hairline flex h-1.5 gap-0.5 overflow-hidden" aria-hidden>
        {segments.map((s, i) => (
          <span key={s.key} className={cn("min-w-0.5", TONES[i])} style={{ flexGrow: s.bytes }} />
        ))}
      </div>
      <div className="text-caption text-text-subtle flex flex-wrap gap-x-3 gap-y-1">
        {segments.map((s, i) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2 shrink-0", TONES[i])} />
            {s.label} {formatSize(s.bytes)}
          </span>
        ))}
        {empty.length === 0 ? null : (
          <span>{`${empty.map((w) => w.name).join(", ")} · Nothing staged`}</span>
        )}
      </div>
    </div>
  );
};

const ClearRow = ({
  host,
  files,
  amount,
  onClear,
}: {
  readonly host: HostView;
  readonly files: number;
  readonly amount: string;
  readonly onClear: () => Promise<void>;
}) => {
  const [busy, setBusy] = useState(false);

  return (
    <SettingsConfirmRow
      title={`Clear every attachment on ${host.label}`}
      caption={`${amount}, whatever the policy`}
      action="Clear now"
      consequence={`Deletes them from ${host.label} now, unsent drafts' files too. Sent images show "No preview", and agents can't open them again.`}
      confirm={`Delete ${filesLine(files)}`}
      onConfirm={() => {
        setBusy(true);
        void onClear().finally(() => setBusy(false));
      }}
      {...(busy ? { disabledReason: "Clearing…" } : {})}
    />
  );
};

const count = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

const overrideLine = (workspaces: number, overrides: number) =>
  `${count(workspaces, "workspace")} · ${overrides === 0 ? "no overrides" : count(overrides, "override")}`;

const ReadyCard = ({
  host,
  data,
  workspaces,
  save,
  clear,
}: {
  readonly host: HostView;
  readonly data: Extract<CleanupState, { kind: "ready" }>["data"];
  readonly workspaces: ReadonlyArray<Workspace>;
  readonly save: (settings: CleanupSettings) => Promise<void>;
  readonly clear: (workspaceId: WorkspaceId | null) => Promise<void>;
}) => {
  const { settings, usage } = data;
  const overrides = workspaces.filter((w) => settings.workspaces[w.id] !== undefined).length;

  return (
    <SettingsCard
      title={<HostName host={host} />}
      aside={<span data-testid="staged-total">{amountLine(usage.total)}</span>}
      status={overrideLine(workspaces.length, overrides)}
      data-testid="attachments-host"
      data-host={host.key}
    >
      <SettingsWell>
        {usage.total.files === 0 ? null : <DiskUse workspaces={workspaces} usage={usage} />}
        <SettingsSelectRow
          title="Delete attachments"
          caption={`The default for every workspace on ${host.label}`}
          value={policyKey(settings.default)}
          options={options(settings.default)}
          onChange={(key) => {
            const policy = policyOf(key);

            if (policy !== null) void save(withDefault(settings, policy));
          }}
        />
        {workspaces.map((w) => {
          const override = settings.workspaces[w.id] ?? null;

          return (
            <SettingsOverrideRow
              key={w.id}
              name={w.name}
              caption={amountLine(usage.workspaces[w.id])}
              value={override === null ? null : policyKey(override)}
              options={options(override ?? settings.default)}
              defaultLabel={policyShort(settings.default).toLowerCase()}
              onChange={(key) =>
                void save(withWorkspace(settings, w.id, key === null ? null : policyOf(key)))
              }
            />
          );
        })}
        {usage.total.files === 0 ? null : (
          <ClearRow
            host={host}
            files={usage.total.files}
            amount={amountLine(usage.total)}
            onClear={() => clear(null)}
          />
        )}
      </SettingsWell>
    </SettingsCard>
  );
};

/** A Host whose settings can't show: one line, and at most one way forward. */
const LineCard = ({
  host,
  line,
  offline = false,
  action,
}: {
  readonly host: HostView;
  readonly line: string;
  readonly offline?: boolean;
  readonly action?: ReactNode;
}) => (
  <SettingsCard
    title={<HostName host={host} />}
    aside={offline ? "Not connected" : undefined}
    action={action}
    className={cn(offline && "opacity-(--opacity-dimmed)")}
    data-testid="attachments-host"
    data-host={host.key}
  >
    <SettingsEmpty>{line}</SettingsEmpty>
  </SettingsCard>
);

const HostCard = ({ host }: { readonly host: HostView }) => {
  const connected = host.status.state === "connected";
  const supported = host.status.capabilities.includes(CAPABILITY);
  const { state, save, clear } = useCleanup(host.key, connected && supported);
  const { openSettings } = useShellActions();
  const model = useApp((s) => s.hostModels[host.key]) ?? emptyHostModel;

  const workspaces = [...model.workspaces.values()].sort((a, b) =>
    a.registeredAt.localeCompare(b.registeredAt)
  );

  if (!connected)
    return (
      <LineCard
        host={host}
        offline
        line={`${host.label} isn't connected; its settings show once it is`}
      />
    );

  if (!supported)
    return (
      <LineCard
        host={host}
        line={`The daemon on ${host.label} is too old to manage attachments`}
        action={<SettingsButton onClick={() => openSettings("hosts")}>Open hosts</SettingsButton>}
      />
    );

  if (state.kind === "loading") return <LineCard host={host} line={`Asking ${host.label}…`} />;

  if (state.kind === "failed") return <LineCard host={host} line={state.message} />;

  return (
    <ReadyCard host={host} data={state.data} workspaces={workspaces} save={save} clear={clear} />
  );
};

export const AttachmentsPage = () => {
  const hosts = useApp((s) => s.hosts);
  const info = sectionInfo("attachments");

  return (
    <SettingsPage
      title={info.title}
      blurb="Pasted and dropped files, staged on the host that runs the session."
      scope="Each host"
      scopeIcon={<ScreenGlyph />}
    >
      {hosts.map((host) => (
        <HostCard key={host.key} host={host} />
      ))}
    </SettingsPage>
  );
};
