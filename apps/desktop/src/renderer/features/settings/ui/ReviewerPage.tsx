/**
 * Settings → Reviewer (DESIGN.md, Settings redesign SR-10; ENG-222): the reviewer every host
 * runs, drawn as the automatic chain or as its harness, model and effort; its readiness per
 * host; the walkthrough and the workspace overrides; when it runs beside what it checks
 * against. Settings live on each host; a change goes to all of them.
 */
import { HARNESS_CATALOGUE } from "@polaris/protocol";
import {
  CloseIcon,
  Dither,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Kicker,
  SettingsButton,
  SettingsCard,
  SettingsGrid,
  SettingsHostRow,
  type SettingsOption,
  SettingsPage,
  SettingsRow,
  SettingsSelect,
  SettingsWell,
  Tile,
} from "@polaris/ui";
import { Fragment, useState } from "react";
import type { HostView } from "../../../../shared/api.ts";
import { slots } from "../../../app/slots.tsx";
import { useApp } from "../../../shell/hooks.ts";
import { harnessGroups, type RowAction } from "../model/harnesses.ts";
import {
  AUTO_CHAIN,
  type Choice,
  chainLabel,
  choiceLabel,
  harnessName,
  type HostReviewer,
  overridesOf,
  readySummary,
  type ReviewerHostRow,
  reviewerHostRows,
  reviewerTitle,
  type Settings,
  sharedDefault,
  sharedPolicy,
  sharedWalkthrough,
  SOL,
  withDefault,
  withOverride,
  withPolicy,
  withWalkthrough,
} from "../model/reviewer.ts";
import { sectionInfo } from "../model/sections.ts";
import type { WorkspaceOption } from "../model/workspaces.ts";
import { hostColour } from "./AutoArchive.tsx";
import { useHostProbes } from "./hostProbes.ts";
import { ModelChips, ReviewerChoice, useModelName } from "./ReviewerChoice.tsx";
import { ChecksAgainst, UsageLine, WhenItRuns } from "./ReviewerRuns.tsx";
import { useReviewers } from "./useReviewers.ts";
import { overrideCount, useWorkspaceOptions } from "./WorkspaceOverrides.tsx";

type Reviewers = Readonly<Record<string, HostReviewer>>;

const ScreenGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="2.5" width="9" height="6" rx="1" fill="none" stroke="currentColor" />
    <path d="M4 10.5h4" stroke="currentColor" />
  </svg>
);

/** A Host where the Harness is ready, to list its Models. */
export const useModelHost = () => {
  const { hosts } = useHostProbes();
  const groups = harnessGroups(hosts);

  return (harness: string) =>
    groups.find((g) => g.kind === harness)?.rows.find((r) => r.ready)?.hostKey ?? null;
};

const AUTO = "auto";

const HARNESS_OPTIONS: ReadonlyArray<SettingsOption<string>> = [
  { value: AUTO, label: "Automatic" },
  ...HARNESS_CATALOGUE.map((h) => ({ value: h.kind, label: h.name })),
];

const HueSquare = ({ harness }: { readonly harness: string }) => (
  <Tile hue={harness} size={20} className="size-2.5 rounded-[3px]">
    <Dither hue={harness} size={10} />
  </Tile>
);

/** One link of the chain, named as the Harness lists the Model where it can. */
const ChainLink = ({
  choice,
  modelHost,
}: {
  readonly choice: Choice;
  readonly modelHost: (harness: string) => string | null;
}) => {
  const modelName = useModelName(modelHost(choice.harness), choice.harness);

  return (
    <span className="text-caption text-text-default flex h-[26px] items-center gap-1.5 rounded-[8px] border border-[light-dark(#00000014,#ffffff14)] px-2.5">
      <HueSquare harness={choice.harness} />
      {chainLabel(choice, modelName)}
    </span>
  );
};

/** Automatic, drawn as what it tries on each host, best first. */
const Chain = ({ modelHost }: { readonly modelHost: (harness: string) => string | null }) => (
  <ol aria-label="Automatic picks" className="flex flex-wrap items-center gap-2">
    {AUTO_CHAIN.map((choice) => (
      <Fragment key={choice.harness}>
        <li className="contents">
          <ChainLink choice={choice} modelHost={modelHost} />
        </li>
        <Kicker aria-hidden>else</Kicker>
      </Fragment>
    ))}
    <li className="text-caption text-text-subtle flex h-[26px] items-center rounded-[8px] border border-dashed border-[light-dark(#00000026,#ffffff2e)] px-2.5">
      Rules only
    </li>
  </ol>
);

const ChoiceRows = ({
  choice,
  differs,
  modelHost,
  onChange,
}: {
  readonly choice: Choice | null;
  readonly differs: boolean;
  readonly modelHost: (harness: string) => string | null;
  readonly onChange: (choice: Choice | null) => void;
}) => {
  const modelName = useModelName(modelHost(choice?.harness ?? ""), choice?.harness ?? "");

  return (
    <div className="px-panel flex flex-col gap-2.5 py-[calc(var(--spacing-gap)+4px)]">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-body text-text-default truncate" data-testid="reviewer-title">
            {reviewerTitle(choice, modelName)}
          </span>
          {differs ? (
            <span className="text-caption text-text-subtle truncate">
              Your hosts have different reviewers; a change here applies to all of them.
            </span>
          ) : null}
        </div>
        <SettingsSelect
          label="Harness"
          value={choice?.harness ?? AUTO}
          options={HARNESS_OPTIONS}
          onChange={(v) => onChange(v === AUTO ? null : { harness: v, model: null, effort: null })}
        />
      </div>
      {choice === null ? (
        <Chain modelHost={modelHost} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <ModelChips
            choice={choice}
            modelHost={modelHost(choice.harness)}
            onChange={onChange}
            modelOnly={false}
          />
        </div>
      )}
    </div>
  );
};

const RowActionButton = ({
  action,
  onSignIn,
}: {
  readonly action: RowAction;
  readonly onSignIn: () => void;
}) =>
  action.kind === "sign-in" ? (
    <SettingsButton onClick={onSignIn}>Sign in in terminal</SettingsButton>
  ) : (
    <SettingsButton
      variant="ghost"
      onClick={() => void window.polaris.request("shell.openExternal", { url: action.url })}
    >
      Open setup guide
    </SettingsButton>
  );

/** What a host's row says at its end: the Harness and its checkouts, or why it runs rules. */
const rowEnd = (row: ReviewerHostRow) =>
  row.caption ?? (row.harness === null ? row.aside : `${harnessName(row.harness)} · ${row.aside}`);

const HostLine = ({
  row,
  host,
  signingIn,
  onSignIn,
  onDone,
}: {
  readonly row: ReviewerHostRow;
  readonly host: HostView | undefined;
  readonly signingIn: boolean;
  readonly onSignIn: () => void;
  readonly onDone: () => void;
}) => {
  const action = row.row?.ready === true ? null : (row.row?.action ?? null);

  return (
    <div data-testid="reviewer-host" data-host={row.hostKey}>
      <SettingsHostRow
        name={row.hostLabel}
        colour={host === undefined ? "var(--color-text-subtle)" : hostColour(host)}
        fact={row.text}
        offline={host !== undefined && host.status.state !== "connected"}
      >
        {action === null ? (
          <span className="text-caption text-text-subtle max-w-[260px] truncate">
            {rowEnd(row)}
          </span>
        ) : (
          <RowActionButton action={action} onSignIn={onSignIn} />
        )}
      </SettingsHostRow>
      {signingIn && action?.kind === "sign-in" ? (
        <slots.HarnessTerminal
          hostKey={row.hostKey}
          argv={action.argv}
          onExit={onDone}
          onClose={onDone}
        />
      ) : null}
    </div>
  );
};

const SAME = "same";

const OWN = "own";

const WALKTHROUGH_OPTIONS: ReadonlyArray<SettingsOption<string>> = [
  { value: SAME, label: "Same as the reviewer" },
  { value: OWN, label: "Its own harness and model" },
];

/** "Walkthrough": the reviewer's harness, model and effort, or its own. */
const WalkthroughRows = ({
  value,
  fallback,
  onChange,
  modelHost,
}: {
  readonly value: Choice | null;
  readonly fallback: Choice;
  readonly onChange: (choice: Choice | null) => void;
  readonly modelHost: (harness: string) => string | null;
}) => (
  <div data-testid="walkthrough-model">
    <SettingsRow
      title="Walkthrough"
      caption={
        value === null
          ? "Uses the reviewer's harness, model and effort"
          : `Written with ${choiceLabel(value)}`
      }
    >
      <SettingsSelect
        label="Walkthrough model"
        value={value === null ? SAME : OWN}
        options={WALKTHROUGH_OPTIONS}
        onChange={(v) => onChange(v === SAME ? null : fallback)}
      />
    </SettingsRow>
    {value === null ? null : (
      <div className="px-panel pb-[calc(var(--spacing-gap)+4px)] pl-[calc(var(--spacing-panel)+24px)]">
        <ReviewerChoice value={value} onChange={onChange} modelHost={modelHost} allowAuto={false} />
      </div>
    )}
  </div>
);

const AddWorkspace = ({
  options,
  onAdd,
}: {
  readonly options: ReadonlyArray<WorkspaceOption>;
  readonly onAdd: (key: string) => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild disabled={options.length === 0}>
      <SettingsButton variant="ghost">Add a workspace…</SettingsButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {options.map((o) => (
        <DropdownMenuItem key={o.key} onSelect={() => onAdd(o.key)}>
          {o.name} · {o.hostLabel}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

/** The workspaces that review with their own reviewer, kept on their host. */
const OverridesWell = ({
  reviewers,
  save,
}: {
  readonly reviewers: Reviewers;
  readonly save: (hostKey: string, settings: Settings) => void;
}) => {
  const options = useWorkspaceOptions().filter(
    (o) => o.isGitRepo && reviewers[o.hostKey]?.kind === "loaded"
  );

  const overrides = overridesOf(reviewers);
  const modelHost = useModelHost();
  const { choice } = sharedDefault(Object.values(reviewers));
  const keys = Object.keys(overrides).toSorted();

  const set = (key: string, next: Choice | null) => {
    const option = options.find((o) => o.key === key);

    const [hostKey = "", workspaceId = ""] =
      option === undefined ? key.split("/") : [option.hostKey, option.workspaceId];

    const reviewer = reviewers[hostKey];

    if (reviewer?.kind === "loaded")
      save(hostKey, withOverride(reviewer.settings, workspaceId, next));
  };

  return (
    <SettingsWell aria-label="Workspace reviewers">
      {keys.map((key) => {
        const option = options.find((o) => o.key === key);
        const name = option?.name ?? key;

        return (
          <div
            key={key}
            data-testid="override"
            className="px-panel flex flex-col gap-2 py-[calc(var(--spacing-gap)+4px)]"
          >
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body text-text-default truncate">{name}</span>
                <span className="text-caption text-text-subtle truncate">
                  {option?.hostLabel ?? "Not on any connected host"} · overrides
                </span>
              </div>
              <IconButton
                label={`Remove the override for ${name}`}
                icon={<CloseIcon size={12} />}
                onClick={() => set(key, null)}
              />
            </div>
            <ReviewerChoice
              value={overrides[key] ?? null}
              onChange={(next) => set(key, next)}
              modelHost={modelHost}
              allowAuto={false}
            />
          </div>
        );
      })}
      <SettingsRow
        title={keys.length === 0 ? "No workspace has its own reviewer" : "Another workspace"}
        caption="A workspace can use its own reviewer, kept on its host"
      >
        <AddWorkspace
          options={options.filter((o) => !keys.includes(o.key))}
          onAdd={(key) => set(key, choice ?? SOL)}
        />
      </SettingsRow>
    </SettingsWell>
  );
};

const ReviewerCard = ({
  reviewers,
  save,
  saveAll,
  onWalkthrough,
}: {
  readonly reviewers: Reviewers;
  readonly save: (hostKey: string, settings: Settings) => void;
  readonly saveAll: (choice: Choice | null) => void;
  readonly onWalkthrough: (choice: Choice | null) => void;
}) => {
  const { hosts, refresh } = useHostProbes();
  const views = useApp((s) => s.hosts);
  const models = useApp((s) => s.hostModels);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const modelHost = useModelHost();
  const { choice, differs } = sharedDefault(Object.values(reviewers));
  const walkthrough = sharedWalkthrough(Object.values(reviewers));
  const overrides = Object.keys(overridesOf(reviewers)).length;

  const checkouts = Object.fromEntries(
    Object.entries(models).map(([key, m]) => [key, m.reviewCheckouts.size] as const)
  );

  const rows = reviewerHostRows(hosts, reviewers, checkouts);

  return (
    <SettingsCard
      title="Reviewer"
      aside={readySummary(rows)}
      status={overrideCount(overrides, "the reviewer")}
      action={
        <SettingsButton aria-expanded={editing} onClick={() => setEditing(!editing)}>
          {editing ? "Done" : "Edit overrides"}
        </SettingsButton>
      }
      data-testid="reviewer-card"
    >
      <SettingsWell>
        <ChoiceRows choice={choice} differs={differs} modelHost={modelHost} onChange={saveAll} />
        {rows.map((row) => (
          <HostLine
            key={row.hostKey}
            row={row}
            host={views.find((h) => h.key === row.hostKey)}
            signingIn={signingIn === row.hostKey}
            onSignIn={() => setSigningIn(row.hostKey)}
            onDone={() => {
              setSigningIn(null);
              refresh(row.hostKey);
            }}
          />
        ))}
        {walkthrough.enabled ? (
          <WalkthroughRows
            value={walkthrough.choice}
            fallback={choice ?? SOL}
            onChange={onWalkthrough}
            modelHost={modelHost}
          />
        ) : null}
      </SettingsWell>
      {editing ? <OverridesWell reviewers={reviewers} save={save} /> : null}
    </SettingsCard>
  );
};

export const ReviewerPage = () => {
  const info = sectionInfo("reviewer");
  const { reviewers, save } = useReviewers();

  /** Host-wide settings go to every Host that has a Reviewer. */
  const saveAll = (change: (settings: Settings) => Settings) => {
    for (const [hostKey, reviewer] of Object.entries(reviewers)) {
      if (reviewer.kind === "loaded") save(hostKey, change(reviewer.settings));
    }
  };

  return (
    <SettingsPage
      title={info.title}
      blurb="The read-only agent that writes its part of every risk summary."
      scope="Saved on each host"
      scopeIcon={<ScreenGlyph />}
    >
      <ReviewerCard
        reviewers={reviewers}
        save={save}
        saveAll={(choice) => saveAll((settings) => withDefault(settings, choice))}
        onWalkthrough={(choice) => saveAll((settings) => withWalkthrough(settings, { choice }))}
      />
      <SettingsGrid>
        <WhenItRuns
          policy={sharedPolicy(Object.values(reviewers))}
          walkthrough={sharedWalkthrough(Object.values(reviewers)).enabled}
          onWalkthrough={(enabled) => saveAll((settings) => withWalkthrough(settings, { enabled }))}
          onChange={(patch) => saveAll((settings) => withPolicy(settings, patch))}
        />
        <ChecksAgainst />
      </SettingsGrid>
      <UsageLine />
    </SettingsPage>
  );
};
