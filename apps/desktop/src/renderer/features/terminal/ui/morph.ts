/**
 * The Editor's terminal morph (DESIGN.md, Motion → Morphs): the editor card's foot divides into
 * the terminal card and the status strip, and joins back when the terminal hides.
 */
import { MORPH_EASE, MORPH_MS, reducedMotion } from "@polaris/ui";

/** How long the terminal stays mounted after it hides, for the join to play. */
export const EXIT_MS = 200;

const EXIT_EASE = "cubic-bezier(0.215, 0.61, 0.355, 1)";

const FADE_MS = 150;

const GAP = 6;

const CARD_RADIUS = 18;

const STRIP_RADIUS = 12;

/** The furthest the terminal card may pass its resting place: less than the gap above it. */
const MAX_OVERSHOOT = 4;

/** The well's clip while a morph plays: open above and beside, cut at the strip's top edge. */
const CUT = `inset(-24px -2px -${GAP}px -2px)`;

const SAMPLES = MORPH_EASE.slice("linear(".length, -1).split(",").map(Number);

/** The column's parts at one split: 0 is one card (terminal hidden), 1 is divided and at rest. */
export interface Split {
  /** How far below its resting place the terminal card sits. */
  readonly drop: number;
  /** How far the editor card's stand-in edge has pulled up from the strip's top. */
  readonly lift: number;
  /** The stand-in edge's corner radius. */
  readonly edge: number;
  /** The strip's top and bottom corner radii. */
  readonly top: number;
  readonly bottom: number;
}

export const splitAt = (height: number, split: number): Split => {
  const progress = Math.min(1, Math.max(0, split));

  return {
    drop: (height + GAP) * (1 - split),
    lift: (height + 2 * GAP) * progress,
    edge: CARD_RADIUS * progress,
    top: STRIP_RADIUS * progress,
    bottom: CARD_RADIUS - (CARD_RADIUS - STRIP_RADIUS) * progress,
  };
};

/** The morph spring from `from` to 1, its overshoot capped at `MAX_OVERSHOOT` px of `travel`. */
export const springSteps = (travel: number, from: number): readonly number[] => {
  const left = (1 - from) * travel;
  const over = (Math.max(...SAMPLES) - 1) * left;
  const scale = over > MAX_OVERSHOOT ? MAX_OVERSHOOT / over : 1;

  return SAMPLES.map((sample) => {
    const eased = sample > 1 ? 1 + (sample - 1) * scale : sample;

    return from + (1 - from) * eased;
  });
};

/** The column's elements the morph paints. */
export interface Parts {
  readonly card: HTMLElement;
  readonly well: HTMLElement;
  readonly terminal: HTMLElement;
  readonly strip: HTMLElement;
  readonly fill: HTMLElement;
}

const part = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLElement>(`[data-morph="${name}"]`);

/** The parts under the column's root, or null unless the terminal is laid out. */
export const partsIn = (root: HTMLElement): Parts | null => {
  const card = part(root, "card");
  const well = part(root, "well");
  const terminal = part(root, "terminal");
  const strip = part(root, "strip");
  const fill = part(root, "fill");

  if (card === null || well === null || terminal === null || strip === null || fill === null)
    return null;

  return { card, well, terminal, strip, fill };
};

const px = (value: number) => `${Math.round(value * 100) / 100}px`;

const keyframes = (height: number, steps: readonly number[]) => {
  const at = steps.map((step) => splitAt(height, step));

  return {
    terminal: at.map((a) => ({ transform: `translateY(${px(a.drop)})` })),
    fill: at.map((a) => ({
      visibility: "visible",
      clipPath: `inset(0px 0px ${px(a.lift)} 0px round 0px 0px ${px(a.edge)} ${px(a.edge)})`,
    })),
    strip: at.map((a) => ({
      borderRadius: `${px(a.top)} ${px(a.top)} ${px(a.bottom)} ${px(a.bottom)}`,
    })),
  };
};

/** The test DOM has no running animations; there the column just changes. */
const canMorph = (element: HTMLElement) =>
  "getAnimations" in element && "DOMMatrixReadOnly" in globalThis;

const stop = (element: HTMLElement) => {
  for (const animation of element.getAnimations()) animation.cancel();
};

/** The split the column is at now, read from where the terminal card is painted. */
const splitNow = ({ terminal }: Parts) => {
  const travel = terminal.offsetHeight + GAP;
  const dropped = new DOMMatrixReadOnly(getComputedStyle(terminal).transform).m42;

  return Math.min(1, Math.max(0, 1 - dropped / travel));
};

const play = (parts: Parts, steps: readonly number[], timing: KeyframeAnimationOptions) => {
  const { card, well, terminal, strip, fill } = parts;
  const height = terminal.offsetHeight;
  const frames = keyframes(height, steps);

  for (const element of [well, terminal, strip, fill]) stop(element);

  // The fill spans from inside the editor card's bottom corners down to the strip's top.
  fill.style.top = `${card.offsetTop + card.offsetHeight - CARD_RADIUS}px`;
  fill.style.height = `${CARD_RADIUS + 2 * GAP + height}px`;

  fill.animate(frames.fill, timing);
  well.animate([{ clipPath: CUT }, { clipPath: CUT }], timing);
  terminal.animate(frames.terminal, timing);
  strip.animate(frames.strip, timing);
};

const fade = (element: Element) =>
  element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out" });

/**
 * Divides the card: the terminal rises out of the strip. `fresh` is a terminal that just
 * mounted (from one card); otherwise it starts from where an interrupted join left it.
 * Web Animations, not CSS: Reduce Motion zeroes CSS transitions, and its crossfade must play.
 */
export const playDivide = (parts: Parts, fresh: boolean) => {
  if (!canMorph(parts.terminal)) return;

  if (reducedMotion()) {
    for (const element of [parts.well, parts.terminal, parts.strip, parts.fill]) stop(element);

    if (fresh) {
      fade(parts.strip);
      fade(parts.terminal);
    }

    return;
  }

  const from = fresh ? 0 : splitNow(parts);

  play(parts, springSteps(parts.terminal.offsetHeight + GAP, from), {
    duration: MORPH_MS,
    easing: "linear",
  });
};

/** Joins the card back from where it is now, and holds there until the layout changes. */
export const playJoin = (parts: Parts) => {
  if (!canMorph(parts.terminal) || reducedMotion()) return;

  play(parts, [splitNow(parts), 0], { duration: EXIT_MS, easing: EXIT_EASE, fill: "forwards" });
};

/** The foot layout is back: drop the fill's held frame; Reduce Motion fades the row in. */
export const settle = (root: HTMLElement) => {
  const fill = part(root, "fill");
  const row = root.querySelector<HTMLElement>('[data-slot="status-row"]');

  if (fill !== null && canMorph(fill)) stop(fill);

  if (row !== null && canMorph(row) && reducedMotion()) fade(row);
};

/** How long to keep a hidden terminal mounted: no hold when nothing will play. */
export const exitMs = () => (reducedMotion() ? 0 : EXIT_MS);
