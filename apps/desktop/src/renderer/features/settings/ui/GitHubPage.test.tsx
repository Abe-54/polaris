import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@polaris/ui";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import type { GitHubAccountView, GitHubAccountsView } from "../../../../shared/github.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { pullList } from "../../../test/github.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { pullsStore } from "../../pulls/index.ts";
import { GitHubPage } from "./GitHubPage.tsx";

let fake: FakeBridge;

beforeEach(() => {
  fake = installFakeBridge();
});

afterEach(() => {
  cleanup();
  standInBridge(null);
  pullsStore.setState({ list: null, accounts: null });
});

const account = (id: number, login: string, extra: Partial<GitHubAccountView> = {}) => ({
  id,
  login,
  name: null,
  avatarUrl: "",
  scopes: ["repo", "read:org"],
  missingScopes: [],
  state: "ok" as const,
  signedInAt: null,
  signedOutAt: null,
  ...extra,
});

const view = (extra: Partial<GitHubAccountsView> = {}): GitHubAccountsView => ({
  accounts: [account(1, "lucasdoell"), account(2, "lucas-work", { state: "signed-out" })],
  signIn: null,
  owners: { "work-org": 2 },
  workspaces: {},
  storageAvailable: true,
  manageUrl: "https://github.com/settings/applications",
  ...extra,
});

/** A pull list whose only repo belongs to an owner no account can see. */
const pulls = pullList(
  [],
  [
    {
      repo: "acme-corp/api",
      state: "not-found",
      accountId: null,
      login: null,
      permission: null,
      approvalUrl: null,
      ssoUrl: null,
      workspaces: [{ hostKey: "mac", workspaceId: "api" }],
    },
  ]
);

const mount = (accounts: GitHubAccountsView) => {
  pullsStore.setState({ accounts, list: pulls });

  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [{ ...hostView("mac"), label: "Mac Studio" }],
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  render(
    <AppProvider
      value={{
        connection,
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TooltipProvider>
        <GitHubPage adding={false} />
      </TooltipProvider>
    </AppProvider>
  );
};

const card = (title: string) => {
  const found = screen.getAllByRole("heading").find((h) => h.textContent === title);
  const section = found?.closest("section");

  if (section == null) throw new Error(`no card ${title}`);

  return within(section);
};

test("a signed-out account offers Sign in again on its own server, and Add account starts a sign-in", () => {
  mount(view());
  const accounts = card("Accounts");

  expect(accounts.getByText("1 signed in · 1 signed out")).not.toBeNull();
  const [first, second] = accounts.getAllByTestId("github-account");

  expect(within(first ?? document.body).getByText("Default")).not.toBeNull();
  act(() => {
    fireEvent.click(within(second ?? document.body).getByRole("button", { name: "Sign in again" }));
  });
  act(() => {
    fireEvent.click(accounts.getByRole("button", { name: "Add account" }));
  });

  expect(fake.sent("github.signIn.start")).toEqual([{ host: "github.com" }, {}]);
});

test("without a token store, Add account is off and the footer says why", () => {
  mount(view({ storageAvailable: false }));
  const accounts = card("Accounts");

  expect(accounts.getByRole("button", { name: "Add account" }).hasAttribute("disabled")).toBeTrue();
  expect(
    accounts.getByText("This Mac has no keychain to keep tokens in, so Polaris can't sign in")
  ).not.toBeNull();
});

test("an owner without an account reads Choose account, dashed; a mapped one shows its account", () => {
  mount(view());
  const owners = card("Account per owner");

  const acme = owners.getByRole("combobox", { name: "Account for acme-corp" });
  const work = owners.getByRole("combobox", { name: "Account for work-org" });

  expect(acme.textContent).toBe("Choose account");
  expect(acme.className).toContain("border-dashed");
  expect(work.textContent).toBe("lucas-work");
  expect(
    owners.getByRole("combobox", { name: "Default account, for everyone else" }).textContent
  ).toBe("Default · lucasdoell");
});

test("with no account yet, the page says so and has no owner table", () => {
  mount(view({ accounts: [], owners: {} }));

  expect(card("Accounts").getByText("No GitHub account on this Mac yet")).not.toBeNull();
  expect(screen.queryByRole("heading", { name: "Account per owner" })).toBeNull();
});

test("Enterprise stays one dashed line until asked, then opens the server form", () => {
  mount(view());

  expect(screen.queryByRole("form", { name: "Add a GitHub Enterprise server" })).toBeNull();
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Add a GitHub Enterprise server" }));
  });

  expect(screen.getByRole("form", { name: "Add a GitHub Enterprise server" })).not.toBeNull();
});
