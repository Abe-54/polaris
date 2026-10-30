/**
 * Settings → GitHub accounts' "Account per owner" (DESIGN.md, Settings redesign SR-11): a
 * table of an account per owner or org, "Choose account" dashed until set, each owner's
 * access problem with its one fix, "Everyone else" on the default, and the workspaces that
 * override their owner, edited in place.
 */
import {
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Kicker,
  SettingsButton,
  SettingsCard,
  type SettingsOption,
  SettingsOverrideRow,
  SettingsRow,
  SettingsSelect,
  SettingsWell,
} from "@polaris/ui";
import { type ReactNode, useState } from "react";
import type { GitHubAccountsView, PullListView } from "../../../../shared/github.ts";
import { useApp } from "../../../shell/hooks.ts";
import { polaris } from "../../bridge.ts";
import { type OwnerRow, ownerTable, workspaceOverrides } from "../model/github.ts";
import type { WorkspaceOption } from "../model/workspaces.ts";
import { overrideCount, useWorkspaceOptions } from "./WorkspaceOverrides.tsx";

/** Moves `id` to the front: the default is the first account. */
export const setDefaultAccount = (view: GitHubAccountsView, id: number) =>
  void polaris().request("github.accounts.reorder", {
    accountIds: [id, ...view.accounts.map((a) => a.id).filter((a) => a !== id)],
  });

/** The Select value that clears a mapping (the default account answers). */
const DEFAULT = "default";

const accountOptions = (view: GitHubAccountsView): ReadonlyArray<SettingsOption<string>> =>
  view.accounts.map((a) => ({ value: String(a.id), label: a.login }));

const recheck = (repo: string) => {
  const [owner = "", name = ""] = repo.split("/");

  void polaris().request("github.recheck", { repo: { owner, name } });
};

const openExternal = (url: string) => void polaris().request("shell.openExternal", { url });

/** The owner's access problem, neutral (DESIGN.md: a notice, never a signal colour). */
const AccessLine = ({ row }: { readonly row: OwnerRow }) => {
  const { access } = row;

  if (access.kind === "ok") return null;

  if (access.kind === "not-found") {
    return (
      <span className="text-caption text-text-subtle">
        No account here can see {access.repo}. Choose one that can, or add it.
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-caption text-text-subtle min-w-0 flex-1 truncate">
        {row.owner} hasn&apos;t approved Polaris, so {access.repo} is hidden
      </span>
      {/* One action per row (DESIGN.md, Settings); its menu holds the three ways in. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SettingsButton variant="ghost">
            Get access
            <ChevronDownIcon size={10} />
          </SettingsButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {access.approvalUrl === null ? null : (
            <DropdownMenuItem onSelect={() => openExternal(access.approvalUrl ?? "")}>
              Request access from {row.owner}
            </DropdownMenuItem>
          )}
          {access.ssoUrl === null ? null : (
            <DropdownMenuItem onSelect={() => openExternal(access.ssoUrl ?? "")}>
              Sign in with SSO
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => recheck(access.repo)}>Check again</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

/** The table's lanes: owner, its workspaces, then the account. */
const Lanes = ({
  owner,
  workspaces,
  account,
}: {
  readonly owner: ReactNode;
  readonly workspaces: ReactNode;
  readonly account: ReactNode;
}) => (
  <div className="flex items-center gap-3">
    <span className="min-w-0 flex-1 truncate">{owner}</span>
    <span className="text-caption text-text-subtle w-[200px] shrink-0 truncate">{workspaces}</span>
    <span className="flex w-[200px] shrink-0 justify-end">{account}</span>
  </div>
);

const ROW = "px-panel flex flex-col gap-1.5 py-[calc(var(--spacing-gap)+3px)]";

const Owner = ({ row, view }: { readonly row: OwnerRow; readonly view: GitHubAccountsView }) => (
  <div className={ROW} data-testid="github-owner">
    <Lanes
      owner={<span className="text-body text-text-default font-mono">{row.owner}</span>}
      workspaces={row.workspaces}
      account={
        <SettingsSelect
          label={`Account for ${row.owner}`}
          value={row.accountId === null ? undefined : String(row.accountId)}
          placeholder="Choose account"
          options={[
            ...accountOptions(view),
            ...(row.accountId === null ? [] : [{ value: DEFAULT, label: "Use the default" }]),
          ]}
          onChange={(v) =>
            void polaris().request("github.routing.setOwner", {
              owner: row.owner,
              accountId: v === DEFAULT ? null : Number(v),
            })
          }
        />
      }
    />
    <AccessLine row={row} />
  </div>
);

const EveryoneElse = ({
  view,
  workspaces,
}: {
  readonly view: GitHubAccountsView;
  readonly workspaces: string;
}) => {
  const fallback = view.accounts[0];

  return (
    <div className={ROW}>
      <Lanes
        owner={<span className="text-body text-text-subtle">Everyone else</span>}
        workspaces={workspaces}
        account={
          <SettingsSelect
            label="Default account, for everyone else"
            value={fallback === undefined ? undefined : String(fallback.id)}
            options={view.accounts.map((a) => ({
              value: String(a.id),
              label: a.login,
              short: `Default · ${a.login}`,
            }))}
            onChange={(v) => setDefaultAccount(view, Number(v))}
          />
        }
      />
    </div>
  );
};

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

/** The workspaces whose account isn't their owner's, each under its owner's account. */
const OverridesWell = ({
  view,
  overrides,
  options,
}: {
  readonly view: GitHubAccountsView;
  readonly overrides: ReturnType<typeof workspaceOverrides>;
  readonly options: ReadonlyArray<WorkspaceOption>;
}) => {
  const login = (id: number | null) =>
    view.accounts.find((a) => a.id === id)?.login ?? view.accounts[0]?.login ?? "the default";

  const set = (key: string, accountId: number | null) => {
    const option = options.find((o) => o.key === key);

    const [hostKey = "", workspaceId = ""] =
      option === undefined ? key.split("/") : [option.hostKey, option.workspaceId];

    void polaris().request("github.routing.setWorkspace", {
      workspace: { hostKey, workspaceId },
      accountId,
    });
  };

  const keys = overrides.map((o) => o.key);

  return (
    <SettingsWell aria-label="Workspace accounts">
      {overrides.map(({ key, accountId, insteadOf }) => {
        const option = options.find((o) => o.key === key);
        const name = option?.name ?? key;

        return (
          <SettingsOverrideRow
            key={key}
            name={name}
            caption={`${option?.hostLabel ?? "Not on any connected host"} · overrides its owner`}
            value={String(accountId)}
            options={accountOptions(view)}
            defaultLabel={login(insteadOf)}
            parent="its owner"
            clearLabel={`Remove the override for ${name}`}
            onChange={(next) => set(key, next === null ? null : Number(next))}
          />
        );
      })}
      <SettingsRow
        title={keys.length === 0 ? "Every workspace uses its owner's account" : "Another workspace"}
        caption="A workspace can use another account than its owner's"
      >
        <AddWorkspace
          options={options.filter((o) => !keys.includes(o.key))}
          onAdd={(key) => set(key, view.accounts[0]?.id ?? null)}
        />
      </SettingsRow>
    </SettingsWell>
  );
};

export const OwnerTable = ({
  view,
  pulls,
}: {
  readonly view: GitHubAccountsView;
  readonly pulls: PullListView | null;
}) => {
  const hosts = useApp((s) => s.hosts);
  const hostLabel = (key: string) => hosts.find((h) => h.key === key)?.label ?? key;
  const table = ownerTable(view, pulls, hostLabel);
  const options = useWorkspaceOptions().filter((o) => o.isGitRepo);
  const overrides = workspaceOverrides(view, pulls);
  const [editing, setEditing] = useState(false);

  return (
    <SettingsCard
      title="Account per owner"
      aside="Matched by each workspace's git remote"
      status={overrideCount(overrides.length, "its owner's account")}
      action={
        <SettingsButton aria-expanded={editing} onClick={() => setEditing(!editing)}>
          {editing ? "Done" : "Edit overrides"}
        </SettingsButton>
      }
    >
      <SettingsWell aria-label="Account per owner">
        <div className="px-panel pt-[calc(var(--spacing-gap)+2px)] pb-1.5">
          <Lanes
            owner={<Kicker>Owner</Kicker>}
            workspaces={<Kicker>Workspaces</Kicker>}
            account={<Kicker>Account</Kicker>}
          />
        </div>
        {table.rows.map((row) => (
          <Owner key={row.owner} row={row} view={view} />
        ))}
        <EveryoneElse view={view} workspaces={table.everyoneElse} />
      </SettingsWell>
      {editing ? <OverridesWell view={view} overrides={overrides} options={options} /> : null}
    </SettingsCard>
  );
};
