import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import * as P from "@polaris/protocol";
import { Schema } from "effect";
import type { ConnectionState } from "@polaris/protocol";
import type { HostView, IpcError, LanguageApi } from "../../../../shared/api.ts";
import { standInBridge } from "../../bridge.ts";
import { installFakeBridge } from "../../../test/bridge.testing.ts";
import { EditorSettings, type EditorSettingsProps } from "./EditorSettings.tsx";
import { HOST_ID, catalog, hostState } from "./fixture.testing.ts";

const host = (
  key: string,
  label: string,
  state: ConnectionState = "connected",
  capabilities: HostView["status"]["capabilities"] = ["languages"]
): HostView => ({
  key,
  label,
  colour: null,
  alias: key === "local" ? null : key,
  kind: key === "local" ? "local" : "ssh",
  proofHarness: false,
  status: {
    state,
    failure: null,
    attempt: 0,
    since: 0,
    nextAttemptAt: null,
    host:
      state === "connected"
        ? new P.HostInfo({
            hostId: key === "local" ? HOST_ID : P.HostId.make(`${key}-id`),
            hostname: key,
            platform: "darwin-arm64",
            daemonVersion: "0.4.0",
            homeDir: "/Users/me",
            startedAt: "2026-10-07T00:00:00Z",
          })
        : null,
    capabilities,
    epoch: 0,
    latencyMs: null,
    lastSeenAt: null,
  },
});

type SettingsScope = typeof P.LanguageSettingsScope.Type;

type SettingsRecord = typeof P.LanguageSettingsRecord.Type;

/** The fields of the requests these tests send. */
interface Input {
  readonly hostKey: string;
  readonly scope?: SettingsScope;
  readonly expectedRevision?: number;
  readonly settings?: P.LanguageSettingsPatch;
}

interface Call {
  readonly method: string;
  readonly input: Input;
}

type Value = SettingsRecord | P.LanguageCatalog | null;

type Reply =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: IpcError };

const APP = P.LanguageSettingsScope.cases.App.make({});

const CONFLICT: Reply = {
  ok: false,
  error: {
    code: "language",
    message: "conflict",
    languageError: new P.LanguageError({
      reason: "conflict",
      message: "conflict",
      retryable: true,
    }),
  },
};

/** Main's preference store in miniature: records by scope with the revision check. */
const fakeApi = () => {
  const records = new Map<string, SettingsRecord>();
  const calls: Call[] = [];
  let conflictOnce = false;

  const get = (scope: SettingsScope) =>
    records.get(JSON.stringify(scope)) ??
    P.LanguageSettingsRecord.make({ scope, revision: 0, settings: {} });

  const set = (input: Input): Reply => {
    const scope = input.scope ?? APP;
    const previous = get(scope);

    if (conflictOnce) {
      conflictOnce = false;
      records.set(
        JSON.stringify(scope),
        P.LanguageSettingsRecord.make({ ...previous, revision: previous.revision + 1 })
      );

      return CONFLICT;
    }

    if (previous.revision !== input.expectedRevision) return CONFLICT;

    const next = P.LanguageSettingsRecord.make({
      scope,
      revision: previous.revision + 1,
      settings: input.settings ?? {},
    });

    records.set(JSON.stringify(scope), next);

    return { ok: true, value: next };
  };

  const answer = (method: string, input: Input): Reply => {
    if (method === "languages.settings.set") return set(input);

    if (method === "languages.settings.get") return { ok: true, value: get(input.scope ?? APP) };

    return { ok: true, value: method === "languages.catalog" ? catalog : null };
  };

  const request = async (method: string, input: Input) => {
    calls.push({ method, input });

    return answer(method, input);
  };

  const api: LanguageApi = {
    // SAFETY: these tests send only settings and catalog requests, answered in their output shapes.
    request: request as LanguageApi["request"],
    subscribe: (kind, _input, listener) => {
      // SAFETY: only the Host state feed is subscribed here, and it carries LanguageHostState.
      const deliver = listener.items as (items: readonly P.LanguageHostState[]) => void;

      if (kind === "languages.host.state.watch") queueMicrotask(() => deliver([hostState()]));

      return () => undefined;
    },
  };

  return {
    api,
    calls,
    records,
    conflictNext: () => {
      conflictOnce = true;
    },
  };
};

const renderPage = (
  hosts: ReadonlyArray<HostView> = [host("local", "this Mac")],
  fake = fakeApi(),
  extra: Partial<EditorSettingsProps> = {}
) => {
  const refreshed: Array<string | null> = [];

  render(
    <EditorSettings
      api={fake.api}
      hosts={hosts}
      workspacesOf={() => []}
      keys={{
        vim: false,
        autosave: false,
        inlineDiagnostics: true,
        onVim: () => {},
        onAutosave: () => {},
        onInlineDiagnostics: () => {},
      }}
      refreshEditors={(hostKey) => refreshed.push(hostKey)}
      refreshPreviews={() => {}}
      {...extra}
    />
  );

  return { fake, refreshed };
};

const appRecord = (fake: ReturnType<typeof fakeApi>) =>
  fake.records.get(JSON.stringify(P.LanguageSettingsScope.cases.App.make({})));

/** Bound per call: `screen` binds at import, before the DOM registers. */
const page = () => within(document.body);

afterEach(cleanup);

describe("preferences", () => {
  test("format on save writes the App record with its revision and refreshes every editor", async () => {
    const { fake, refreshed } = renderPage();
    const toggle = page().getByRole("switch", { name: "Format on save" });

    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(toggle));

    await waitFor(() => expect(appRecord(fake)?.settings.formatOnSave).toBe(false));
    const set = fake.calls.find((c) => c.method === "languages.settings.set");

    expect(set?.input["expectedRevision"]).toBe(0);
    expect(refreshed).toEqual([null]);
  });

  test("a lost race re-reads and writes once more", async () => {
    const { fake } = renderPage();
    const toggle = page().getByRole("switch", { name: "Download language tools automatically" });

    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fake.conflictNext();
    await act(async () => fireEvent.click(toggle));

    await waitFor(() =>
      expect(appRecord(fake)?.settings.downloadLanguageToolsAutomatically).toBe(false)
    );
    expect(appRecord(fake)?.revision).toBe(2);
  });
});

describe("languages", () => {
  test("each row shows its state; syntax-only languages say they need no server", async () => {
    renderPage();

    await page().findByText("TypeScript and JavaScript");
    expect(
      page().getByText("Ready · uses each project's TypeScript once you trust it")
    ).toBeTruthy();
    expect(page().getByText("Highlighting and preview · no language server needed")).toBeTruthy();
  });

  test("a row opens to its parts and closes again", async () => {
    renderPage();
    const disclosure = (await page().findByText("TypeScript and JavaScript")).closest("button");

    if (disclosure === null) throw new Error("no disclosure");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(page().queryByText("TypeScript 6 and older")).toBeNull();
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(page().getByText("TypeScript 6 and older")).toBeTruthy();
    expect(page().getByText("typescript-go 7.0.2")).toBeTruthy();
    fireEvent.click(disclosure);
    expect(page().queryByText("TypeScript 6 and older")).toBeNull();
  });

  test("switching a row off stores an empty provider list for each of its languages", async () => {
    const { fake } = renderPage();
    const toggle = await page().findByRole("switch", { name: "Rust language tools" });

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(toggle));

    const scope = JSON.stringify(P.LanguageSettingsScope.cases.Language.make({ language: "rust" }));

    await waitFor(() => expect(fake.records.get(scope)?.settings.providers).toEqual([]));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    await act(async () => fireEvent.click(toggle));
    await waitFor(() => expect(fake.records.get(scope)?.settings.providers).toBeUndefined());
  });

  test("the host picker shows the picked host and reads its facts", async () => {
    const { fake } = renderPage([
      host("local", "this Mac"),
      host("pi", "Raspberry Pi 4", "offline"),
    ]);

    expect(page().getByRole("button", { name: "Host: this Mac" })).toBeTruthy();
    await page().findByText("TypeScript and JavaScript");
    expect(
      fake.calls.filter((c) => c.method === "languages.catalog").map((c) => c.input["hostKey"])
    ).toEqual(["local"]);
  });

  test("with no connected host the list says so", () => {
    renderPage([host("pi", "Raspberry Pi 4", "offline")]);

    expect(page().getByText("Pick a connected host to see its languages.")).toBeTruthy();
  });
});

describe("advanced", () => {
  test("is collapsed until opened", async () => {
    renderPage();
    const button = page().getByRole("button", { name: /Advanced/ });

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(page().queryByText("Add server")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(await page().findByText("Add server")).toBeTruthy();
  });

  test("removes a custom server from the host's record and keeps environment private", async () => {
    const fake = fakeApi();
    const scope = P.LanguageSettingsScope.cases.Host.make({ hostId: HOST_ID });

    fake.records.set(
      JSON.stringify(scope),
      P.LanguageSettingsRecord.make({
        scope,
        revision: 3,
        settings: Schema.decodeUnknownSync(P.LanguageSettingsPatch)({
          customServers: [
            {
              id: "zls",
              launch: { executable: "/usr/local/bin/zls", argv: ["--stdio"], environment: {} },
              rootMarkers: [],
              workingDirectory: null,
              filePatterns: [],
              documentLanguageId: "zig",
              initializationOptions: {},
              settings: {},
            },
          ],
        }),
      })
    );
    const { refreshed } = renderPage(undefined, fake);
    fireEvent.click(page().getByRole("button", { name: /Advanced/ }));
    const servers = within(await page().findByRole("region", { name: "Custom language servers" }));

    expect(servers.getByText("/usr/local/bin/zls")).toBeTruthy();
    fireEvent.click(servers.getByRole("button", { name: "Remove" }));
    expect(fake.records.get(JSON.stringify(scope))?.revision).toBe(3);
    await act(async () => fireEvent.click(servers.getByRole("button", { name: "Remove zls" })));

    await waitFor(() => expect(fake.records.get(JSON.stringify(scope))?.revision).toBe(4));
    expect(fake.records.get(JSON.stringify(scope))?.settings.customServers).toBeUndefined();
    expect(refreshed).toEqual(["local"]);
    expect(page().getAllByLabelText("Environment")[0]?.getAttribute("type")).toBe("password");
  });
});

describe("commit messages", () => {
  const repo = { hostKey: "local", cwd: "/Users/me/polaris" };
  const withLog = [host("local", "this Mac", "connected", ["languages", "git.log"])];

  const keys = {
    vim: false,
    autosave: false,
    inlineDiagnostics: true,
    onVim: () => {},
    onAutosave: () => {},
    onInlineDiagnostics: () => {},
    commitMessages: "chips",
  };

  const renderCard = (hosts: ReadonlyArray<HostView>) =>
    renderPage(hosts, fakeApi(), { commitWorkspace: repo, keys });

  const preview = () => page().getByTestId("commit-preview").textContent ?? "";

  afterEach(() => standInBridge(null));

  test("shows the workspace's last commit from git.log", async () => {
    const bridge = installFakeBridge();
    bridge.answerOk("git.log", {
      commits: [
        new P.GitLogCommit({
          sha: "a1b2c3",
          subject: "feat(ui): the Settings kit",
          body: "Cards and wells.",
          author: "Test",
          date: "2026-10-30T09:00:00Z",
        }),
      ],
    });
    renderCard(withLog);

    await waitFor(() => expect(preview()).toContain("feat(ui): the Settings kit"));
    expect(preview()).toContain("Like your last commit");
    expect(preview()).toContain("Cards and wells.");
    expect(bridge.sent("git.log")).toEqual([{ ...repo, limit: 1 }]);
  });

  test.each([
    [
      "an empty log",
      (b: ReturnType<typeof installFakeBridge>) => b.answerOk("git.log", { commits: [] }),
    ],
    [
      "a failed read",
      (b: ReturnType<typeof installFakeBridge>) =>
        b.refuse("git.log", { code: "GitError", message: "not a git repository" }),
    ],
  ])("falls back to the example on %s", async (_, answer) => {
    const bridge = installFakeBridge();
    answer(bridge);
    renderCard(withLog);

    await waitFor(() => expect(bridge.sent("git.log").length).toBe(1));
    await act(async () => {});
    expect(preview()).toContain("A draft looks like");
    expect(preview()).toContain("a cancel reaches queued requests");
  });

  test("a Daemon without git.log isn't asked and shows the example", async () => {
    const bridge = installFakeBridge();
    renderCard([host("local", "this Mac")]);

    await act(async () => {});
    expect(bridge.sent("git.log")).toEqual([]);
    expect(preview()).toContain("A draft looks like");
  });
});
