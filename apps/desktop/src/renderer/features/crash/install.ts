/** Errors no boundary caught (an event handler, a timer, a rejected promise) go to the crash log too. */
import { type CrashReporter, crashReport, reportCrash } from "./report.ts";

type Target = Pick<Window, "addEventListener" | "removeEventListener">;

/** Listens on `window` for "error" and "unhandledrejection"; returns the uninstaller. */
export const installCrashReporting = (
  target: Target = window,
  report: CrashReporter = reportCrash
) => {
  const onError = (event: ErrorEvent) => report(crashReport("error", event.error ?? event.message));

  const onRejection = (event: PromiseRejectionEvent) =>
    report(crashReport("unhandledrejection", event.reason));

  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);

  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
};
