/**
 * Restart daemon on one host page (HS-D4): Confirm only when something would be interrupted,
 * then Restarting until `machines.restartDaemon` answers Back or Failed. Local to the page:
 * leaving the page drops the Back note, and it goes on its own after an hour.
 */
import { PixelFailedIcon, showToast } from "@polaris/ui";
import { createElement, useCallback, useEffect, useState } from "react";
import type { RestartDaemonResult, RestartPreviewView } from "../../../../shared/restart.ts";
import { call } from "../hooks.tsx";
import { type Failed, needsConfirm } from "./model.ts";

type Back = Extract<RestartDaemonResult, { readonly outcome: "back" }>;

export type RestartState =
  | { readonly step: "idle" }
  | { readonly step: "confirm"; readonly preview: RestartPreviewView }
  | { readonly step: "restarting"; readonly stoppedAt: number; readonly turns: number | null }
  | { readonly step: "back"; readonly result: Back; readonly at: number }
  | { readonly step: "failed"; readonly result: Failed };

const IDLE: RestartState = { step: "idle" };

/** How long "Daemon restarted" stays when the user doesn't leave the page. */
export const BACK_NOTE_MS = 60 * 60_000;

export interface Restart {
  readonly state: RestartState;
  /** Restart daemon…: asks first when something would be interrupted. */
  readonly begin: () => void;
  readonly confirm: () => void;
  readonly cancel: () => void;
}

const workingCount = (preview: RestartPreviewView | null) =>
  preview?.interrupts?.workingSessions.length ?? null;

export const useRestart = (hostKey: string): Restart => {
  const [state, setState] = useState<RestartState>(IDLE);

  const run = useCallback(
    async (preview: RestartPreviewView | null) => {
      setState({ step: "restarting", stoppedAt: Date.now(), turns: workingCount(preview) });
      const result = await call("machines.restartDaemon", { hostKey });

      if (result === null) return setState(IDLE);

      switch (result.outcome) {
        case "back":
          return setState({ step: "back", result, at: Date.now() });
        case "failed":
          return setState({ step: "failed", result });
        default:
          // Refused, or another Polaris home holds the sign-in task: nothing ran.
          showToast({
            source: "starlight",
            icon: createElement(PixelFailedIcon),
            title: "The daemon wasn't restarted",
            message: result.message,
          });

          return setState(IDLE);
      }
    },
    [hostKey]
  );

  const begin = useCallback(() => {
    void call("machines.restartPreview", { hostKey }).then((preview) => {
      if (preview === null || !preview.available) return;

      if (needsConfirm(preview)) setState({ step: "confirm", preview });
      else void run(preview);
    });
  }, [hostKey, run]);

  useEffect(() => {
    if (state.step !== "back") return undefined;
    const timer = setTimeout(() => setState(IDLE), BACK_NOTE_MS);

    return () => clearTimeout(timer);
  }, [state]);

  return {
    state,
    begin,
    confirm: () => {
      if (state.step === "confirm") void run(state.preview);
    },
    cancel: () => setState(IDLE),
  };
};
