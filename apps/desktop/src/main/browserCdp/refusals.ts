/**
 * What a tab session may send (ENG-616, ADR 0092): an allowlist of page-scoped domains, with
 * the few methods in them that still reach past the tab refused, and a few methods outside
 * them mediated one by one. Without a `sessionId` only the facade's own methods exist.
 * `README.md` lists it all for agents.
 */
import type { CdpJson } from "@polaris/protocol";
import { Option, Schema } from "effect";

/** Domains a tab session may use whole; everything in them acts on that tab's frame tree. */
export const ALLOWED_DOMAINS: ReadonlySet<string> = new Set([
  "Accessibility",
  "Animation",
  "Audits",
  "Console",
  "CSS",
  "DOM",
  "DOMDebugger",
  "DOMSnapshot",
  "Debugger",
  "Emulation",
  "Fetch",
  "Input",
  "Inspector",
  "Log",
  "Network",
  "Overlay",
  "Page",
  "Performance",
  "Profiler",
  "Runtime",
  "Security",
]);

/** Methods refused everywhere: browser-wide, or reading files on the Desktop App's machine. */
export const REFUSED_METHODS: ReadonlySet<string> = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setPermission",
  "Browser.getWindowForTarget",
  "Browser.getWindowBounds",
  "Browser.setWindowBounds",
  "Browser.setContentsSize",
  "Browser.setDockTile",
  "Browser.executeBrowserCommand",
  "Browser.getBrowserCommandLine",
  "Browser.getHistograms",
  "Browser.getHistogram",
  "Browser.cancelDownload",
  "Browser.addPrivacySandboxEnrollmentOverride",
  "Browser.addPrivacySandboxCoordinatorKeyConfig",
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.getBrowserContexts",
  "Target.setRemoteLocations",
  "Target.exposeDevToolsProtocol",
  "Target.sendMessageToTarget",
  "Target.autoAttachRelated",
  "Target.attachToBrowserTarget",
  "DOM.setFileInputFiles",
  "Page.setInterceptFileChooserDialog",
  "Network.loadNetworkResource",
  // TLS checks stay on for public sites; Host addresses are trusted by their partition instead.
  "Security.setIgnoreCertificateErrors",
  "Security.setOverrideCertificateErrors",
  "Security.handleCertificateError",
]);

/** Domains that describe or control the Desktop App's Chromium or its storage, not one tab. */
export const REFUSED_DOMAINS: ReadonlyArray<string> = [
  "Storage",
  "ServiceWorker",
  "Tracing",
  "SystemInfo",
  "Tethering",
  "Memory",
  "HeadlessExperimental",
  "Extensions",
  "PWA",
  "Autofill",
];

/** Methods outside the allowed domains a tab session may still send, each checked below. */
export const MEDIATED_METHODS: ReadonlySet<string> = new Set([
  "Target.setAutoAttach",
  "IO.read",
  "IO.close",
  "IO.resolveBlob",
]);

const DownloadBehavior = Schema.Struct({
  behavior: Schema.String,
  downloadPath: Schema.optionalKey(Schema.String),
});

const decodeDownloadBehavior = Schema.decodeUnknownOption(DownloadBehavior);

const DragData = Schema.Struct({
  data: Schema.Struct({ files: Schema.optionalKey(Schema.Array(Schema.String)) }),
});

const decodeDragData = Schema.decodeUnknownOption(DragData);

const WithHandle = Schema.Struct({ handle: Schema.String });

export const decodeHandle = Schema.decodeUnknownOption(WithHandle);

export const refusalMessage = (method: string) =>
  `${method} is not available through this Browser: it reaches beyond this session's tabs.`;

const domainOf = (method: string) => method.split(".")[0] ?? method;

/** Why `method` is refused wherever it is sent, or null. */
export const refusalOf = (method: string, params: CdpJson | undefined): string | null => {
  if (REFUSED_METHODS.has(method)) return refusalMessage(method);

  if (REFUSED_DOMAINS.includes(domainOf(method))) return refusalMessage(method);

  if (method === "Input.dispatchDragEvent") {
    const files = Option.flatMap(decodeDragData(params), (p) => Option.fromNullishOr(p.data.files));

    return Option.isSome(files) && files.value.length > 0
      ? "Input.dispatchDragEvent may not drop files here: they would come from the Desktop App's machine."
      : null;
  }

  if (method === "Browser.setDownloadBehavior" || method === "Page.setDownloadBehavior") {
    const decoded = decodeDownloadBehavior(params);

    const allowed =
      Option.isSome(decoded) &&
      (decoded.value.behavior === "deny" || decoded.value.behavior === "default") &&
      decoded.value.downloadPath === undefined;

    return allowed
      ? null
      : `${method} may only deny downloads here: the Desktop App chooses where they go.`;
  }

  return null;
};

/**
 * Why a tab session may not send `method`, or null when it may reach the tab. `handles` are
 * the IO streams this facade's tab handed out; IO reads any other handle in the browser.
 */
export const tabRefusalOf = (
  method: string,
  params: CdpJson | undefined,
  handles: ReadonlySet<string>
): string | null => {
  const everywhere = refusalOf(method, params);

  if (everywhere !== null) return everywhere;

  if (ALLOWED_DOMAINS.has(domainOf(method))) return null;

  if (!MEDIATED_METHODS.has(method))
    return `${method} is not available through this Browser: only a tab's own domains are.`;

  if (method === "IO.read" || method === "IO.close") {
    const handle = decodeHandle(params);

    return Option.isSome(handle) && handles.has(handle.value.handle)
      ? null
      : `${method} may only read a stream this tab handed out.`;
  }

  return null;
};
