/**
 * Visualization frames (ADR 0101): each frame document is served once at
 * `app://polaris/frame/<token>` under its own CSP, since a `srcdoc` frame would inherit the
 * app's CSP and its inline scripts would be blocked. The iframe's sandbox gives it an opaque origin.
 */
/** Under `APP_ORIGIN` (`protocol.ts`, which imports Electron and this file). */
export const FRAME_PREFIX = "app://polaris/frame/";

/** The app's CSP lets it frame these documents and nothing else. */
export const FRAME_SRC = `frame-src ${FRAME_PREFIX}`;

/** A floor under the document's own CSP meta: both apply, so the stricter wins. */
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "sandbox allow-scripts",
].join("; ");

/** Subframe preloads run in a sandboxed isolated world; only the main frame exposes Polaris. */
export const FRAME_WEB_PREFERENCES = {
  nodeIntegrationInSubFrames: true,
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
} as const;

/** Documents waiting for their frame to load; a renderer never needs more at once. */
const MAX_WAITING = 16;

export const isFrameUrl = (url: string) => url.startsWith(FRAME_PREFIX);

/** Only a frame's own first document; any later page it loads is refused, then torn down. */
export interface FrameDocuments {
  /** Holds a document and returns the URL that serves it once. */
  readonly serve: (document: string) => string;
  /** The held document for a frame URL, removed as it is taken; null once taken or unknown. */
  readonly take: (url: string) => string | null;
}

export const frameDocuments = (token: () => string = () => crypto.randomUUID()): FrameDocuments => {
  const waiting = new Map<string, string>();

  return {
    serve: (document) => {
      const url = `${FRAME_PREFIX}${token()}`;

      waiting.set(url, document);

      for (const oldest of waiting.keys()) {
        if (waiting.size <= MAX_WAITING) break;
        waiting.delete(oldest);
      }

      return url;
    },
    take: (url) => {
      const document = waiting.get(url) ?? null;

      waiting.delete(url);

      return document;
    },
  };
};

/** The response for a frame URL: its document under `FRAME_CSP`, or 404. */
export const frameResponse = (documents: FrameDocuments, url: string): Response => {
  const document = documents.take(url);

  if (document === null) return new Response(null, { status: 404 });

  return new Response(document, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": FRAME_CSP,
      "Cache-Control": "no-store",
    },
  });
};

/** Whether a subframe may load a URL: a frame document only, so a Visualization never leaves. */
export const subframeMayLoad = (url: string) => isFrameUrl(url);
