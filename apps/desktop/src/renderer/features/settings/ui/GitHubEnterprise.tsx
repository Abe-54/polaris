/**
 * Settings → GitHub accounts → GitHub Enterprise (SR-11): the servers accounts can sign in to
 * besides github.com, adding one with its OAuth App's client ID, and an account per
 * server. UI copy says "server": "Host" is a machine running a Daemon (CONTEXT.md).
 */
import { clientCopy } from "../../../../shared/clientCopy.ts";
import {
  Button,
  DotsIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  SettingsButton,
  SettingsCard,
  SettingsWell,
} from "@polaris/ui";
import { useState } from "react";
import {
  GITHUB_HOST,
  type GitHubAccountsView,
  type GitHubHostView,
} from "../../../../shared/github.ts";
import { polaris } from "../../bridge.ts";

const startSignIn = (host: string) => void polaris().request("github.signIn.start", { host });

const accountCount = (view: GitHubAccountsView, host: string) => {
  const count = view.accounts.filter((a) => (a.host ?? GITHUB_HOST) === host).length;

  return count === 1 ? "1 account" : `${count === 0 ? "No" : count} accounts`;
};

const ServerMenu = ({ server }: { readonly server: GitHubHostView }) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" aria-label={`More for ${server.host}`}>
        <DotsIcon />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem
        onSelect={() => void polaris().request("shell.openExternal", { url: server.manageUrl })}
      >
        Manage Polaris on {server.host}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="text-failed-text"
        onSelect={() => void polaris().request("github.hosts.remove", { host: server.host })}
      >
        Remove {server.host} and its accounts from {clientCopy().machine}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

const Server = ({
  server,
  view,
}: {
  readonly server: GitHubHostView;
  readonly view: GitHubAccountsView;
}) => (
  <div
    className="px-panel flex items-center gap-3 py-[calc(var(--spacing-gap)+4px)]"
    data-testid="github-server"
  >
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-body text-text-default truncate">{server.host}</span>
      <span className="text-caption text-text-subtle truncate">
        {accountCount(view, server.host)} · OAuth App{" "}
        <span className="font-mono">{server.clientId}</span>
      </span>
    </span>
    <SettingsButton
      variant="ghost"
      disabled={!view.storageAvailable || view.signIn !== null}
      onClick={() => startSignIn(server.host)}
    >
      Add account
    </SettingsButton>
    <ServerMenu server={server} />
  </div>
);

const AddServerForm = ({ onDone }: { readonly onDone: () => void }) => {
  const [host, setHost] = useState("");
  const [clientId, setClientId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    void polaris()
      .request("github.hosts.add", { host, clientId })
      .then((result) => {
        if (result.ok) onDone();
        else setError(result.error.message);
      });
  };

  return (
    <form
      aria-label="Add a GitHub Enterprise server"
      className="px-panel flex flex-col gap-3 py-[calc(var(--spacing-gap)+4px)]"
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[200px] flex-1 flex-col gap-1">
          <span className="text-caption text-text-subtle">Server</span>
          <Input
            value={host}
            placeholder="github.acme.com"
            spellCheck={false}
            autoFocus
            onChange={(event) => setHost(event.target.value)}
          />
        </label>
        <label className="flex min-w-[200px] flex-1 flex-col gap-1">
          <span className="text-caption text-text-subtle">Client ID</span>
          <Input
            className="font-mono"
            value={clientId}
            placeholder="OAuth App client ID"
            spellCheck={false}
            aria-invalid={error !== null}
            onChange={(event) => setClientId(event.target.value)}
          />
        </label>
        <SettingsButton
          type="submit"
          variant="primary"
          disabled={host.trim() === "" || clientId.trim() === ""}
        >
          Add server
        </SettingsButton>
        <SettingsButton variant="ghost" onClick={onDone}>
          Cancel
        </SettingsButton>
      </div>
      <span
        role={error === null ? undefined : "alert"}
        className={
          error === null ? "text-caption text-text-subtle" : "text-caption text-failed-text"
        }
      >
        {error ??
          "An admin of the server registers an OAuth App there with Device Flow on, and shares its client ID."}
      </span>
    </form>
  );
};

/** A dashed line until there is a server or the user asks to add one: most use github.com. */
export const GitHubEnterprise = ({ view }: { readonly view: GitHubAccountsView }) => {
  const [adding, setAdding] = useState(false);
  const servers = (view.hosts ?? []).filter((h) => h.removable);

  if (servers.length === 0 && !adding) {
    return (
      <div className="px-panel flex min-h-11 items-center gap-3 rounded-[16px] border border-dashed border-[light-dark(#00000026,#ffffff2e)] py-1.5">
        <span className="text-caption text-text-subtle flex-1">
          Using GitHub Enterprise Server?
        </span>
        <SettingsButton onClick={() => setAdding(true)}>
          Add a GitHub Enterprise server
        </SettingsButton>
      </div>
    );
  }

  return (
    <SettingsCard
      title="GitHub Enterprise"
      aside={servers.length === 1 ? "1 server" : `${servers.length} servers`}
      {...(adding
        ? {}
        : {
            action: <SettingsButton onClick={() => setAdding(true)}>Add a server</SettingsButton>,
          })}
      status={adding ? undefined : "Each server signs in with its own OAuth App"}
    >
      <SettingsWell aria-label="GitHub Enterprise servers">
        {servers.map((server) => (
          <Server key={server.host} server={server} view={view} />
        ))}
        {adding ? <AddServerForm onDone={() => setAdding(false)} /> : null}
      </SettingsWell>
    </SettingsCard>
  );
};
