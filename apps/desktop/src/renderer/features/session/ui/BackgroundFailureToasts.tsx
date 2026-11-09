import { useEffect, useRef } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { showFailure } from "../dispatch.ts";
import type { BackgroundFailure } from "../../../store/hostModel.ts";
import {
  BACKGROUND_FAILED_TITLE,
  backgroundFailureMessage,
  unseenFailures,
} from "../model/backgroundFailures.ts";

/** Mounted once in the app: toasts each Run in background a Harness couldn't carry out. */
export const BackgroundFailureToasts = () => {
  const models = useApp((s) => s.hostModels);
  const seen = useRef(new WeakSet<BackgroundFailure>());

  useEffect(() => {
    for (const failure of unseenFailures(models, seen.current))
      showFailure(BACKGROUND_FAILED_TITLE, backgroundFailureMessage(failure));
  }, [models]);

  return null;
};
