import "../../test/dom.testing.ts";
import { expect, test } from "bun:test";
import type { RendererCrash } from "../../../shared/crash.ts";
import { installCrashReporting } from "./install.ts";

/** An Event carrying the fields the listener reads; happy-dom lacks PromiseRejectionEvent. */
const event = (type: string, fields: { readonly error?: Error; readonly reason?: string }) =>
  Object.assign(new Event(type), fields);

test("uncaught errors and unhandled rejections reach the crash log, until uninstalled", () => {
  const reports: Array<RendererCrash> = [];
  const uninstall = installCrashReporting(window, (report) => reports.push(report));

  window.dispatchEvent(event("error", { error: new Error("handler threw") }));
  window.dispatchEvent(event("unhandledrejection", { reason: "socket closed" }));
  uninstall();
  window.dispatchEvent(event("error", { error: new Error("after") }));

  expect(reports.map((r) => [r.kind, r.message])).toEqual([
    ["error", "handler threw"],
    ["unhandledrejection", "Non-error thrown: socket closed"],
  ]);
  expect(reports[0]?.stack).toContain("handler threw");
});
