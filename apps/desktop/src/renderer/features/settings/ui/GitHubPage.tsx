/**
 * Settings → GitHub accounts (DESIGN.md, Settings redesign SR-11): the accounts in routing
 * order (the first is the default), adding one through the device flow, which account each
 * owner uses, the workspaces that override their owner, then GitHub Enterprise.
 */
import { clientCopy } from "../../../../shared/clientCopy.ts";
import {
  Badge,
  Button,
  cn,
  DotsIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SettingsButton,
  SettingsCard,
  SettingsEmpty,
  SettingsPage,
  SettingsWell,
} from "@polaris/ui";
import { useEffect, useRef } from "react";
import type { GitHubAccountsView, PullListView } from "../../../../shared/github.ts";
import { useApp } from "../../../shell/hooks.ts";
import { useNow } from "../../../shell/useNow.ts";
import { polaris } from "../../bridge.ts";
import { AccountMark, usePulls } from "../../pulls/index.ts";
import { type AccountRow, accountRows } from "../model/github.ts";
import { sectionInfo } from "../model/sections.ts";
import { AddGitHubAccount } from "./AddGitHubAccount.tsx";
import { GitHubEnterprise } from "./GitHubEnterprise.tsx";
import { setDefaultAccount, OwnerTable } from "./GitHubOwners.tsx";

const startSignIn = (host?: string) =>
  void polaris().request("github.signIn.start", host === undefined ? {} : { host });

const openExternal = (url: string) => void polaris().request("shell.openExternal", { url });

const KeyGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <circle cx="4" cy="6" r="2.25" fill="none" stroke="currentColor" />
    <path d="M6.25 6h4.25M9 6v1.75" stroke="currentColor" strokeLinecap="round" />
  </svg>
);

const AccountMenu = ({
  row,
  view,
}: {
  readonly row: AccountRow;
  readonly view: GitHubAccountsView;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" aria-label={`More for ${row.login}`}>
        <DotsIcon />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {row.isDefault ? null : (
        <DropdownMenuItem onSelect={() => setDefaultAccount(view, row.id)}>
          Make default
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={() => startSignIn(row.host)}>Sign in again</DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() =>
          openExternal(view.hosts?.find((h) => h.host === row.host)?.manageUrl ?? view.manageUrl)
        }
      >
        Manage Polaris on GitHub
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="text-failed-text"
        onSelect={() => void polaris().request("github.accounts.remove", { accountId: row.id })}
      >
        Remove {row.login} from {clientCopy().machine}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

/** Paper S5's small neutral triangle before a signed-out caption (never a signal colour). */
const WarnGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="shrink-0">
    <path
      d="M8 2.5l6 10.5H2z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
    <path d="M8 7v2.5M8 11.2v.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const Account = ({
  row,
  view,
}: {
  readonly row: AccountRow;
  readonly view: GitHubAccountsView;
}) => (
  <div
    className="px-panel flex items-center gap-3 py-[calc(var(--spacing-gap)+4px)]"
    data-testid="github-account"
  >
    <AccountMark
      index={row.index}
      size={null}
      className={cn("size-[26px]", row.signedOut && "opacity-(--opacity-dimmed)")}
    />
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex items-center gap-2">
        <span className="text-body text-text-default truncate">{row.login}</span>
        {row.isDefault ? <Badge className="h-[18px] text-[11px]">Default</Badge> : null}
      </span>
      <span className="text-caption text-text-subtle flex min-w-0 items-center gap-1.5">
        {row.signedOut ? <WarnGlyph /> : null}
        <span className="truncate">
          {row.since === null ? row.caption : `${row.caption} · ${row.since}`}
        </span>
      </span>
    </span>
    {row.signedOut ? (
      <SettingsButton variant="ghost" onClick={() => startSignIn(row.host)}>
        Sign in again
      </SettingsButton>
    ) : null}
    <AccountMenu row={row} view={view} />
  </div>
);

const summary = (rows: ReadonlyArray<AccountRow>) => {
  const out = rows.filter((r) => r.signedOut).length;
  const signedIn = `${rows.length - out} signed in`;

  return out === 0 ? signedIn : `${signedIn} · ${out} signed out`;
};

const AccountsCard = ({ view }: { readonly view: GitHubAccountsView }) => {
  const now = useNow();
  const rows = accountRows(view, now);

  return (
    <SettingsCard
      title="Accounts"
      aside={rows.length === 0 ? undefined : summary(rows)}
      status={
        view.storageAvailable
          ? "Signs in through github.com with a one-time code"
          : clientCopy().noTokenStore
      }
      action={
        <SettingsButton
          variant="primary"
          disabled={!view.storageAvailable || view.signIn !== null}
          onClick={() => startSignIn()}
        >
          Add account
        </SettingsButton>
      }
    >
      {rows.length === 0 ? (
        <SettingsEmpty>No GitHub account on {clientCopy().machine} yet</SettingsEmpty>
      ) : (
        <SettingsWell aria-label="Accounts">
          {rows.map((row) => (
            <Account key={row.id} row={row} view={view} />
          ))}
        </SettingsWell>
      )}
    </SettingsCard>
  );
};

/** What the device flow asks GitHub to grant, and how to add a second account. */
const ScopeNote = ({ host }: { readonly host: string | undefined }) => (
  <div className="text-caption text-text-subtle px-gap flex flex-col gap-1.5 leading-[18px] text-pretty">
    <p>
      GitHub asks you to grant <code className="font-mono">repo</code>, full read and write access
      to every repository the account can reach (GitHub has no read-only scope for private
      repositories), and <code className="font-mono">read:org</code>. Polaris uses it to list pull
      requests, send your reviews and open pull requests you accept; hosts push code with their own
      git credentials.
    </p>
    <p>
      Already signed in to {host ?? "github.com"} as another account? Open the link in a private
      window, or switch accounts on {host ?? "GitHub"} first. Next you choose which owners use the
      new account.
    </p>
  </div>
);

/** Settings → GitHub accounts opened to add one (the K menu, the PR list): start at once. */
const useStartWhenAdding = (adding: boolean, view: GitHubAccountsView | null) => {
  const started = useRef(false);

  useEffect(() => {
    if (!adding || started.current || view === null) return;
    started.current = true;

    if (view.signIn === null && view.storageAvailable) startSignIn();
  }, [adding, view]);
};

const Body = ({
  view,
  pulls,
}: {
  readonly view: GitHubAccountsView;
  readonly pulls: PullListView | null;
}) => (
  <>
    <AccountsCard view={view} />
    {view.signIn === null ? null : <AddGitHubAccount flow={view.signIn} />}
    {view.signIn === null || view.signIn.userCode === null ? null : (
      <ScopeNote host={view.signIn.host} />
    )}
    {view.accounts.length === 0 ? null : <OwnerTable view={view} pulls={pulls} />}
    <GitHubEnterprise view={view} />
  </>
);

export const GitHubPage = ({ adding }: { readonly adding: boolean }) => {
  const view = usePulls((s) => s.accounts);
  const pulls = usePulls((s) => s.list);
  const info = sectionInfo("github");
  const hosts = useApp((s) => s.hosts.length);

  useStartWhenAdding(adding, view);

  return (
    <SettingsPage
      title={info.title}
      blurb={`Accounts ${clientCopy().machine} uses to list pull requests and send reviews.`}
      scope={clientCopy().localHost}
      scopeIcon={<KeyGlyph />}
    >
      {view === null ? (
        <p className="text-caption text-text-subtle px-gap">Loading accounts…</p>
      ) : (
        <Body view={view} pulls={hosts === 0 ? null : pulls} />
      )}
    </SettingsPage>
  );
};
