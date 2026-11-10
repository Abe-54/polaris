/**
 * Keeps every connected Host's Suggested Replies preference equal to the user's (Settings →
 * Sessions, ENG-887): written to each Host with the capability when it changes and when it
 * connects, after reading the Host's copy. Hosts without the capability are skipped.
 */
import type { SuggestedReplyFallback } from "@polaris/protocol";
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { SuggestedRepliesPref } from "../../../shared/contract.ts";
import { useApp } from "../../shell/hooks.ts";
import { polaris } from "../bridge.ts";
import { useSettings } from "./store.ts";

export const SUGGESTED_REPLIES_CAPABILITY = "sessions.suggested-replies";

/** The fallback each Host resolves to now, by Host key; null when no Harness for it is ready. */
export const resolvedFallbacks = createStore<
  Readonly<Record<string, SuggestedReplyFallback | null>>
>(() => ({}));

export const useResolvedFallbacks = () => useStore(resolvedFallbacks, (s) => s);

/** What was last written per Host and connection, so a re-render doesn't write again. */
const written = new Map<string, string>();

const sameFallback = (
  host: SuggestedRepliesPref["fallback"],
  user: SuggestedRepliesPref["fallback"]
) =>
  host === null || user === null
    ? host === user
    : host.harness === user.harness && host.model === user.model && host.effort === user.effort;

const sameSetting = (host: SuggestedRepliesPref, user: SuggestedRepliesPref) =>
  host.enabled === user.enabled && sameFallback(host.fallback, user.fallback);

/** True when the Host holds `user` afterwards. */
export const syncHostSuggestedReplies = async (
  hostKey: string,
  user: SuggestedRepliesPref
): Promise<boolean> => {
  const current = await polaris().request("sessions.suggestedReplies", { hostKey });

  if (current.ok) {
    resolvedFallbacks.setState((s) => ({ ...s, [hostKey]: current.value.resolved.choice }));

    if (sameSetting(current.value.settings, user)) return true;
  }

  const set = await polaris().request("sessions.setSuggestedReplies", { hostKey, settings: user });

  if (set.ok && user.fallback !== null)
    resolvedFallbacks.setState((s) => ({ ...s, [hostKey]: user.fallback }));

  return set.ok;
};

/** Mounted once in the app; idle unless the user's setting or the connected Hosts change. */
export const SuggestedRepliesPublisher = () => {
  const hosts = useApp((s) => s.hosts);
  const user = useSettings((s) => s.sessions.suggestedReplies);
  // Empty until main has answered: the setting before that is the built-in one, not the user's.
  const loaded = useSettings((s) => s.version !== "");

  useEffect(() => {
    if (!loaded) return;
    const wanted = JSON.stringify(user);

    for (const host of hosts) {
      if (host.status.state !== "connected") continue;

      if (!host.status.capabilities.includes(SUGGESTED_REPLIES_CAPABILITY)) continue;
      const key = `${host.key}\u0000${host.status.epoch}`;

      if (written.get(key) === wanted) continue;
      written.set(key, wanted);
      // Tried again on the next change or connection.
      void syncHostSuggestedReplies(host.key, user).then((ok) => ok || written.delete(key));
    }
  }, [hosts, user, loaded]);

  return null;
};

/** Forgets what was written, so a test starts from no Host. */
export const resetSuggestedRepliesSync = () => {
  written.clear();
  resolvedFallbacks.setState({}, true);
};
