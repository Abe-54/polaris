import { session } from "electron";
import type { CdpVersions } from "./facade.ts";

/** What `Browser.getVersion` reports: this Electron's Chromium, V8 and default user agent. */
export const electronCdpVersions = (): CdpVersions => ({
  chrome: process.versions.chrome ?? "",
  v8: process.versions.v8 ?? "",
  userAgent: session.defaultSession.getUserAgent(),
});
