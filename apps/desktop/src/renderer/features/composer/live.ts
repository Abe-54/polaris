/**
 * A Harness's Skills and Slash Commands in a directory, from the Host
 * (`harness.commands`). Asked when the composer is first focused, not before,
 * and kept per Host, Harness and directory; the Daemon caches them too.
 */
import type { HarnessKind } from "@polaris/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import { polaris } from "../bridge.ts";
import type { CommandOption } from "./model/commands.ts";

interface Listing {
  readonly options: ReadonlyArray<CommandOption>;
  readonly loading: boolean;
}

const NONE: Listing = { options: [], loading: false };

const known = new Map<string, ReadonlyArray<CommandOption>>();

const listeners = new Set<() => void>();

const keyOf = (hostKey: string, harness: HarnessKind, cwd: string) =>
  `${hostKey}\u0000${harness}\u0000${cwd}`;

const NO_OPTIONS: ReadonlyArray<CommandOption> = [];

/** Asks the Host; a failure keeps what was known (the menu just offers less). */
const ask = (hostKey: string, harness: HarnessKind, cwd: string) =>
  polaris()
    .request("harness.commands", { hostKey, harness, cwd, refresh: false })
    .then((result) => {
      const key = keyOf(hostKey, harness, cwd);

      if (result.ok) {
        known.set(key, result.value.commands);

        for (const listener of listeners) listener();
      }

      return known.get(key) ?? [];
    });

/**
 * The session's commands once `wanted` (the composer was focused). Unset
 * `cwd` or a Host without the capability lists none.
 */
export const useHarnessCommands = (
  hostKey: string,
  harness: HarnessKind | null,
  cwd: string | null,
  enabled: boolean
): Listing & { readonly want: () => void } => {
  const key = harness === null || cwd === null ? null : keyOf(hostKey, harness, cwd);
  // Once focused, whatever the Harness and directory become (the new-session page picks later).
  const [wanted, setWanted] = useState(false);

  const [state, setState] = useState<{ readonly key: string; readonly listing: Listing } | null>(
    null
  );

  useEffect(() => {
    if (!enabled || key === null || !wanted || harness === null || cwd === null) return undefined;
    let current = true;

    void ask(hostKey, harness, cwd).then((options) => {
      if (current) setState({ key, listing: { options, loading: false } });
    });

    return () => {
      current = false;
    };
  }, [enabled, hostKey, harness, cwd, key, wanted]);

  const cached = key === null ? undefined : known.get(key);
  const fetched = state?.key === key ? state?.listing : undefined;

  const listing =
    fetched ??
    (cached === undefined
      ? { options: [], loading: enabled && wanted }
      : { options: cached, loading: false });

  return { ...(enabled ? listing : NONE), want: () => setWanted(true) };
};

const asked = new Set<string>();

/** Asks the Host once for a Host, Harness and directory no composer has read yet. */
export const ensureCommands = (hostKey: string, harness: HarnessKind, cwd: string) => {
  const key = keyOf(hostKey, harness, cwd);

  if (known.has(key) || asked.has(key)) return;
  asked.add(key);
  void ask(hostKey, harness, cwd);
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);

  return () => listeners.delete(listener);
};

/**
 * The commands a composer already read for this Host, Harness and directory,
 * never asking the Host itself: sent messages draw their chips from it.
 */
export const useKnownCommands = (
  hostKey: string,
  harness: HarnessKind | null,
  cwd: string
): ReadonlyArray<CommandOption> =>
  useSyncExternalStore(subscribe, () =>
    harness === null ? NO_OPTIONS : (known.get(keyOf(hostKey, harness, cwd)) ?? NO_OPTIONS)
  );
