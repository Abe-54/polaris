import "../../test/dom.testing.ts";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  ResolvedSuggestedReplyFallback,
  SuggestedReplySettings,
  type Capability,
} from "@polaris/protocol";
import { createStore } from "zustand/vanilla";
import type { HostView } from "../../../shared/api.ts";
import type { SuggestedRepliesPref } from "../../../shared/contract.ts";
import { DEFAULT_SESSION_PREFS } from "../../../shared/sessionPrefs.ts";
import { createCommandRegistry } from "../../routes/commands.ts";
import { hostView } from "../../routes/fixtures.testing.ts";
import { createNavigation } from "../../routes/navigation.ts";
import { AppProvider } from "../../shell/hooks.ts";
import { type AppState, initialState } from "../../store/store.ts";
import { type FakeBridge, installFakeBridge } from "../../test/bridge.testing.ts";
import { settingsStore } from "./store.ts";
import {
  resetSuggestedRepliesSync,
  SUGGESTED_REPLIES_CAPABILITY,
  SuggestedRepliesPublisher,
} from "./suggestedRepliesSync.ts";

let fake: FakeBridge;

/** Each fake Daemon's stored preference, by Host key. */
let stored: Record<string, SuggestedRepliesPref>;

beforeEach(() => {
  resetSuggestedRepliesSync();
  stored = {};
  fake = installFakeBridge();
  fake.answer("sessions.suggestedReplies", ({ hostKey }) => ({
    ok: true,
    value: {
      settings: SuggestedReplySettings.make(stored[hostKey] ?? {}),
      resolved: ResolvedSuggestedReplyFallback.make({ choice: null, source: "auto" }),
    },
  }));
  fake.answer("sessions.setSuggestedReplies", ({ hostKey, settings }) => {
    stored[hostKey] = settings;

    return { ok: true, value: null };
  });
});

afterEach(cleanup);

const host = (key: string, capabilities: ReadonlyArray<Capability>, epoch = 1): HostView => {
  const base = hostView(key);

  return { ...base, status: { ...base.status, capabilities: [...capabilities], epoch } };
};

const capable = (key: string, epoch = 1) => host(key, [SUGGESTED_REPLIES_CAPABILITY], epoch);

const offline = (key: string): HostView => {
  const base = capable(key);

  return { ...base, status: { ...base.status, state: "offline" } };
};

const setUser = (suggestedReplies: SuggestedRepliesPref) =>
  settingsStore.setState({
    sessions: { ...DEFAULT_SESSION_PREFS, suggestedReplies },
    version: "0.9.0",
  });

const publish = (hosts: ReadonlyArray<HostView>) => {
  const store = createStore<AppState>(() => ({ ...initialState, hosts }));

  render(
    <AppProvider
      value={{
        connection: {
          store,
          openSession: () => () => undefined,
          setDensity: () => undefined,
          setAppearance: () => undefined,
        },
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <SuggestedRepliesPublisher />
    </AppProvider>
  );

  return (next: ReadonlyArray<HostView>) => act(() => store.setState({ hosts: next }));
};

const ON = { enabled: true, fallback: null } as const;

test("turning it on writes to every connected Host that has suggested replies", async () => {
  setUser({ enabled: false, fallback: null });
  publish([capable("studio"), capable("pi"), offline("vm")]);

  act(() => setUser(ON));

  await waitFor(() => expect(stored).toEqual({ studio: ON, pi: ON }));
});

test("a Host connecting later gets the user's value, and a reconnect re-checks it", async () => {
  const picked = {
    enabled: true,
    fallback: { harness: "codex", model: "gpt-6-luna", effort: "low" },
  };

  setUser(picked);
  const setHosts = publish([capable("studio")]);

  await waitFor(() => expect(stored.studio).toEqual(picked));
  setHosts([capable("studio"), capable("pi")]);
  await waitFor(() => expect(stored.pi).toEqual(picked));

  // The pi's Daemon lost it; its reconnect (a new epoch) writes it again.
  delete stored.pi;
  setHosts([capable("studio"), capable("pi", 2)]);
  await waitFor(() => expect(stored.pi).toEqual(picked));
});

test("a Host whose value already matches is read, not written", async () => {
  stored.studio = ON;
  setUser(ON);
  publish([capable("studio")]);

  await waitFor(() => expect(fake.sent("sessions.suggestedReplies")).toHaveLength(1));
  expect(fake.sent("sessions.setSuggestedReplies")).toEqual([]);
});

test("a Host without the capability is skipped silently", async () => {
  setUser(ON);
  publish([host("old", ["sessions.visuals"]), capable("studio")]);

  await waitFor(() => expect(stored.studio).toEqual(ON));

  const asked = [
    ...fake.sent("sessions.suggestedReplies"),
    ...fake.sent("sessions.setSuggestedReplies"),
  ].map((input) => input.hostKey);

  expect(asked).not.toContain("old");
});
