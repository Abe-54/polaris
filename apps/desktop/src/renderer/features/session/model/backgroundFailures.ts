/**
 * Run in background the Harness couldn't carry out (ENG-389): each one, once, worded for the
 * "Couldn't run in background" toast a refused `BackgroundCommand` shows too.
 */
import type { BackgroundFailure, HostModel } from "../../../store/hostModel.ts";

export const BACKGROUND_FAILED_TITLE = "Couldn't run in background";

/** The Harness's reason, first letter up: "The command already finished". */
export const backgroundFailureMessage = (failure: BackgroundFailure): string =>
  failure.reason.charAt(0).toUpperCase() + failure.reason.slice(1);

/** The failures not yet in `seen`, which it then holds; each event folds to a new object. */
export const unseenFailures = (
  models: Readonly<Record<string, HostModel>>,
  seen: WeakSet<BackgroundFailure>
): ReadonlyArray<BackgroundFailure> =>
  Object.values(models).flatMap((model) =>
    [...model.sessions.values()].flatMap(({ lastBackgroundFailure: failure }) => {
      if (failure === undefined || seen.has(failure)) return [];
      seen.add(failure);

      return [failure];
    })
  );
