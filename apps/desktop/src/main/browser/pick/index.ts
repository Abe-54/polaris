/**
 * Picking an element in a Browser tab (ENG-618): `page.ts` runs in an isolated world, never
 * through the debugger the CDP relay owns, and main crops a capture of the tab to its bounds.
 */
import { Option, Schema } from "effect";
import type { WebContents } from "electron";
import { BrowserPickResult } from "../../../shared/browserContract.ts";
import { cancelScript, type PickLimits, pickScript } from "./page.ts";

/** Isolated worlds 1–999 are Electron's and extensions'; this one is pick mode's alone. */
const PICK_WORLD = 1618;

/** What the page may answer for each field, in characters; the outer HTML is the excerpt. */
export const PICK_LIMITS: PickLimits = { url: 2048, title: 300, selector: 1000, html: 4000 };

const upTo = (limit: number) => Schema.String.check(Schema.isMaxLength(limit));

/** Past this the screenshot is scaled down: a whole-page pick stays a sane attachment. */
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

const PageRect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

const PagePick = Schema.NullOr(
  Schema.Struct({
    url: upTo(PICK_LIMITS.url),
    title: upTo(PICK_LIMITS.title),
    selector: upTo(PICK_LIMITS.selector),
    html: upTo(PICK_LIMITS.html),
    htmlLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    rect: PageRect,
  })
);

/** What the page answered, or null for a cancel or an answer that isn't a bounded pick. */
export const decodePagePick = Schema.decodeUnknownOption(PagePick);

/** The HTML as the agent reads it: cut where the page cut it, saying how much is missing. */
export const htmlExcerpt = (html: string, fullLength: number) =>
  fullLength > html.length
    ? `${html}\n<!-- ${fullLength - html.length} more characters not included -->`
    : html;

/** The page's CSS px rect in the view's DIPs (page zoom), whole and inside the view. */
export const captureRect = (
  rect: typeof PageRect.Type,
  zoom: number
): Electron.Rectangle | null => {
  const x = Math.floor(rect.x * zoom);
  const y = Math.floor(rect.y * zoom);
  const width = Math.ceil((rect.x + rect.width) * zoom) - x;
  const height = Math.ceil((rect.y + rect.height) * zoom) - y;

  return width > 0 && height > 0 ? { x, y, width, height } : null;
};

const screenshotOf = async (contents: WebContents, rect: Electron.Rectangle | null) => {
  if (rect === null) return new Uint8Array();

  const image = await contents.capturePage(rect);
  let png = image.toPNG();

  // PNG size isn't linear in the pixels: shrink until it fits, else attach no screenshot.
  for (let round = 0; round < 4 && png.byteLength > MAX_SCREENSHOT_BYTES; round++) {
    const scale = Math.sqrt(MAX_SCREENSHOT_BYTES / png.byteLength) * 0.9;
    const width = Math.max(1, Math.floor(image.getSize().width * scale ** (round + 1)));

    png = image.resize({ width, quality: "good" }).toPNG();
  }

  return png.byteLength <= MAX_SCREENSHOT_BYTES ? new Uint8Array(png) : new Uint8Array();
};

/**
 * Runs pick mode in the page until the user clicks an element (the pick), presses Escape, or
 * `abort` settles (null). A navigation or a crashed page ends it with null too.
 */
export const pickIn = async (
  contents: WebContents,
  abort: Promise<void>
): Promise<BrowserPickResult | null> => {
  let ended = false;
  let stop = () => {};

  const stopped = new Promise<null>((resolve) => {
    stop = () => {
      ended = true;
      resolve(null);
    };
  });

  const inPage = (_event: Electron.Event, _url: string, isMainFrame: boolean) => {
    if (isMainFrame) stop();
  };

  const listen = (on: boolean) => {
    const method = on ? "on" : "off";

    contents[method]("did-navigate", stop);
    contents[method]("did-navigate-in-page", inPage);
    contents[method]("render-process-gone", stop);
    contents[method]("destroyed", stop);
  };

  listen(true);
  void abort.then(stop);

  // Cancels hold until the capture is done: a pick from a page that moved on is dropped.
  try {
    contents.focus();

    const answer: unknown = await Promise.race([
      contents
        .executeJavaScriptInIsolatedWorld(PICK_WORLD, [{ code: pickScript(PICK_LIMITS) }], true)
        .catch(() => null),
      stopped,
    ]);

    const page = Option.getOrNull(decodePagePick(answer));

    if (page === null || ended || contents.isDestroyed()) {
      cancelPickIn(contents);

      return null;
    }

    const rect = captureRect(page.rect, contents.getZoomFactor());
    const screenshot = await Promise.race([screenshotOf(contents, rect), stopped]);

    if (screenshot === null || ended || contents.isDestroyed()) return null;

    return BrowserPickResult.make({
      url: page.url,
      title: page.title,
      selector: page.selector,
      html: htmlExcerpt(page.html, page.htmlLength),
      screenshot,
    });
  } finally {
    if (!contents.isDestroyed()) listen(false);
  }
};

/** Ends the page's pick mode, if it has one. */
export const cancelPickIn = (contents: WebContents) => {
  if (contents.isDestroyed()) return;
  void contents
    .executeJavaScriptInIsolatedWorld(PICK_WORLD, [{ code: cancelScript() }])
    .catch(() => {});
};
