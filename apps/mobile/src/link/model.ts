/**
 * Linking as a pure model (DESIGN.md, Mobile chrome redesign · phase 3; Paper MX-AH to MX-AM):
 * each step of the scan sheet, how an event moves it, and the star's light in each.
 */
import { type DeviceCopy, deviceCopyFor } from "../app/deviceCopy.ts";
import { CONTENT_TEXT_SCALE } from "../theme/textScale.ts";

/** What a scanned or pasted text named: the Host it came from, then every Host it shares. */
export interface FoundHosts {
  readonly hostName: string;
  readonly hosts: ReadonlyArray<string>;
}

export type LinkStep =
  | { readonly kind: "scan" }
  | { readonly kind: "paste" }
  | ({ readonly kind: "linking" } & FoundHosts)
  | ({ readonly kind: "linked" } & FoundHosts)
  | { readonly kind: "failed"; readonly message: string };

export type LinkEvent =
  /** The Scan | Paste control, Scan again or Paste a link instead. */
  | { readonly kind: "show"; readonly view: "scan" | "paste" }
  /** A scanned code or the pasted text, decoded: null when it isn't a Polaris link. */
  | { readonly kind: "read"; readonly found: FoundHosts | null }
  /** The Polaris Relay linked these Hosts and the Keychain kept them. */
  | { readonly kind: "linked"; readonly hosts: ReadonlyArray<string> }
  /** The link was refused (the `LinkFailed` message) or its keys weren't saved. */
  | { readonly kind: "refused"; readonly message: string };

export const NOT_A_LINK = "That isn't a Polaris link.";

/** The Keychain refused the keys; the link itself was used. */
export const notSavedMessage = ({ phone }: DeviceCopy): string =>
  `Couldn't save the link on this ${phone}. Make a new one and try again.`;

export const NOT_SAVED = notSavedMessage(deviceCopyFor("ios"));

export const FIRST_STEP: LinkStep = { kind: "scan" };

/** While a link is under way nothing else is read; once linked the sheet only moves on. */
const settled = (step: LinkStep): boolean =>
  step.kind === "scan" || step.kind === "paste" || step.kind === "failed";

const read = (step: LinkStep, found: FoundHosts | null): LinkStep => {
  if (found !== null) return { kind: "linking", ...found };

  // A QR code that isn't a Polaris link is ignored while scanning; a pasted one is refused.
  return step.kind === "paste" ? { kind: "failed", message: NOT_A_LINK } : step;
};

/** The step after `event`; an event the step can't take leaves it as it was. */
export const advance = (step: LinkStep, event: LinkEvent): LinkStep => {
  switch (event.kind) {
    case "show":
      return settled(step) ? { kind: event.view } : step;
    case "read":
      return settled(step) ? read(step, event.found) : step;
    case "linked":
      return step.kind === "linking"
        ? { kind: "linked", hostName: step.hostName, hosts: event.hosts }
        : step;
    case "refused":
      return step.kind === "linking" ? { kind: "failed", message: event.message } : step;
  }
};

/** Whether moving from `before` to `after` starts a link: the one time the link is used. */
export const startsLink = (before: LinkStep, after: LinkStep): boolean =>
  before.kind !== "linking" && after.kind === "linking";

/** The Polaris star's light: it stays in place and only this changes (MX-AK, MX-AL, MX-AM). */
export type StarLight = "rest" | "twinkle" | "bright" | "dim";

export const starLight = (step: LinkStep): StarLight => {
  switch (step.kind) {
    case "scan":
    case "paste":
      return "rest";
    case "linking":
      return "twinkle";
    case "linked":
      return "bright";
    case "failed":
      return "dim";
  }
};

export const hostsLine = (count: number, hostName: string): string =>
  `Found ${count} ${count === 1 ? "host" : "hosts"} on ${hostName}`;

/** How long "Linked this iPhone" stays before the app moves on by itself (MX-AL, no button). */
export const LINKED_DWELL_MS = 1600;

/** Each step's height (MX-AH, MX-AK, MX-AL, MX-AM); a titled sheet adds its header. */
const HEIGHTS: Readonly<Record<LinkStep["kind"], number>> = {
  scan: 430,
  paste: 430,
  linking: 152,
  linked: 152,
  failed: 268,
};

const HEADER_HEIGHT = 52;

/** The sheet's height at `step`: the horizon behind the pairing sheet rests on it. */
export const scanSheetHeight = (step: LinkStep, titled: boolean): number =>
  HEIGHTS[step.kind] + (titled ? HEADER_HEIGHT : 0);

/** The sheet frame around the body: its top padding, grabber row and gap (`sheet/frame.tsx`). */
const FRAME_TOP = 8 + 9 + 10;

/**
 * The step's height, grown to fit a body taller than its artboard (a long failure, Dynamic Type),
 * so the last button is never cut off; `body` is 0 until it has been measured.
 */
export const fittedSheetHeight = (
  step: LinkStep,
  titled: boolean,
  body: number,
  bottomInset: number,
  fontScale = 1
): number => {
  // The header's 26pt title line grows with Dynamic Type, up to its cap.
  const header = HEADER_HEIGHT + 26 * (Math.min(Math.max(fontScale, 1), CONTENT_TEXT_SCALE) - 1);

  return Math.max(
    scanSheetHeight(step, titled),
    Math.ceil(FRAME_TOP + (titled ? header : 0) + body + Math.max(bottomInset, 16))
  );
};

/** MX-AH's gap above "Link this iPhone", and the least it gives way to at large Dynamic Type. */
export const HEADING_TOP = 60;

export const HEADING_TOP_MIN = 12;

/**
 * The gap above the heading: MX-AH's 60pt while the heading fits above the sheet (`room` is the
 * height between the safe area and the sheet), down to 12pt so the lead stays in view.
 */
export const headingTop = (room: number, heading: number): number =>
  Math.min(HEADING_TOP, Math.max(HEADING_TOP_MIN, room - heading - HEADING_TOP_MIN));
