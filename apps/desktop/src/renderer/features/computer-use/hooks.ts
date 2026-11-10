/**
 * A Host's computer use, live: the Host feed (`computerUse.watch`) and its actions. The feed
 * never checks the Host by itself; opening setup makes the Daemon check until it's ready.
 */
import type {
  AllowedApp,
  AppId,
  ComputerUsePermission,
  ComputerUseStatus,
  ControlledApp,
} from "@polaris/protocol";
import { Match } from "effect";
import { useEffect, useState } from "react";
import { polaris } from "../bridge.ts";
import { call } from "../machines/hooks.tsx";
import type { Opened } from "./model.ts";

export interface ComputerUseFeed {
  /** Null until the first status, and on a Daemon without computer use. */
  readonly status: ComputerUseStatus | null;
  readonly allowed: ReadonlyArray<AllowedApp>;
  readonly controlled: ReadonlyArray<ControlledApp>;
}

const EMPTY: ComputerUseFeed = { status: null, allowed: [], controlled: [] };

/** Folds the Host feed's items; each replaces its kind whole. */
export const useComputerUseFeed = (hostKey: string | null): ComputerUseFeed => {
  const [feed, setFeed] = useState<ComputerUseFeed>(EMPTY);

  useEffect(() => {
    setFeed(EMPTY);

    if (hostKey === null) return;

    return polaris().subscribe(
      "computerUse.watch",
      { hostKey },
      {
        items: (items) =>
          setFeed((was) =>
            items.reduce(
              (next, item): ComputerUseFeed =>
                Match.value(item).pipe(
                  Match.tagsExhaustive({
                    Status: ({ status }) => ({ ...next, status }),
                    AllowedApps: ({ apps }) => ({ ...next, allowed: apps }),
                    ControlledApps: ({ apps }) => ({ ...next, controlled: apps }),
                  })
                ),
              was
            )
          ),
      }
    );
  }, [hostKey]);

  return feed;
};

export interface ComputerUseActions {
  readonly busy: boolean;
  /** The pane last opened from here, so the copy can say what happens next. */
  readonly opened: Opened;
  readonly setOn: (on: boolean) => void;
  /** Turns it on first when it's off, then opens the Host's one setup step. */
  readonly openSetup: (permission?: ComputerUsePermission | null) => void;
  readonly checkAgain: () => void;
  readonly remove: (appId: AppId) => void;
}

/** Failures toast (machines' `call`); the feed brings the new status, so answers are dropped. */
export const useComputerUseActions = (hostKey: string): ComputerUseActions => {
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<Opened>(undefined);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);

    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    opened,
    setOn: (on) => {
      if (!on) setOpened(undefined);
      void run(async () => {
        await call(on ? "computerUse.enable" : "computerUse.disable", { hostKey });
      });
    },
    openSetup: (permission = null) =>
      void run(async () => {
        const status = await call("computerUse.enable", { hostKey });

        if (status === null) return;
        const opening = await call("computerUse.openSetup", { hostKey, permission });

        if (opening !== null) setOpened(permission);
      }),
    checkAgain: () =>
      void run(async () => {
        await call("computerUse.status", { hostKey, refresh: true });
      }),
    remove: (appId) =>
      void run(async () => {
        await call("computerUse.removeAllowedApp", { hostKey, appId });
      }),
  };
};
