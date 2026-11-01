/**
 * Paints the flame chart (DESIGN.md, Traces → Profile): 20px frames in neutral greys by function,
 * the selected one filled `text-default` with its label in the ground colour, and the trace's
 * overlapping range as a line above the frames. Only frames at least half a pixel wide are drawn.
 */
import type { ProfileDetail } from "@polaris/protocol";
import { eachVisibleFrame, type FlameLayout, type FlameWindow } from "../../model/profile/flame.ts";
import { placeLabel } from "../../model/profile/labels.ts";
import type { MsRange } from "../../model/profile/overlap.ts";

export const FRAME = 20;

export const FRAME_GAP = 2;

/** The strip above the frames that holds the overlapping range's line. */
export const MARK_STRIP = 6;

export const LEVEL = FRAME + FRAME_GAP;

const LABEL_PAD = 6;

const GREYS = [18, 24, 30] as const;

export interface Palette {
  readonly greys: ReadonlyArray<string>;
  readonly selected: string;
  readonly label: string;
  readonly selectedLabel: string;
  readonly mark: string;
  readonly font: string;
}

/** CSS colours (custom properties, light-dark()) resolved to what the canvas can paint. */
export const paletteOf = (probe: HTMLElement): Palette => {
  const resolve = (colour: string) => {
    probe.style.color = colour;

    return getComputedStyle(probe).color;
  };

  return {
    greys: GREYS.map((p) =>
      resolve(`color-mix(in srgb, var(--color-text-strong) ${p}%, var(--color-panel))`)
    ),
    selected: resolve("var(--color-text-default)"),
    label: resolve("var(--color-text-default)"),
    selectedLabel: resolve("var(--color-panel)"),
    mark: resolve("var(--color-text-strong)"),
    font: `11px ${getComputedStyle(probe).fontFamily}`,
  };
};

export interface Scene {
  readonly detail: ProfileDetail;
  readonly layout: FlameLayout;
  readonly window: FlameWindow;
  readonly top: number;
  readonly rows: number;
  readonly frame: number | null;
  /** The open trace's overlap, in ms of the Profile. */
  readonly mark: MsRange | null;
  readonly checkout: string | null;
}

const fitted = (text: string, room: number, charWidth: number) => {
  const fits = Math.floor(room / charWidth);

  if (fits >= text.length) return text;

  return fits < 3 ? "" : `${text.slice(0, fits - 1)}…`;
};

const labelOf = (scene: Scene, node: number, selected: boolean) => {
  const fn = scene.detail.hotFunctions[scene.layout.functionOf[node] ?? -1];

  if (fn === undefined) return "(unknown)";

  return selected ? `${fn.name} · ${placeLabel(fn, scene.checkout)}` : fn.name;
};

const drawMark = (
  context: CanvasRenderingContext2D,
  scene: Scene,
  width: number,
  colour: string
) => {
  if (scene.mark === null) return;
  const { from, to } = scene.window;
  const scale = width / Math.max(to - from, 1e-9);
  const left = Math.max(0, (scene.mark.from - from) * scale);
  const right = Math.min(width, (scene.mark.to - from) * scale);

  if (right <= left) return;
  context.fillStyle = colour;
  context.fillRect(left, 1, Math.max(2, right - left), 2);
};

/** Paints `scene` on `canvas` at its CSS size; returns how many frames it drew. */
export const drawFlame = (canvas: HTMLCanvasElement, palette: Palette, scene: Scene): number => {
  const ratio = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  const context = canvas.getContext("2d");

  if (context === null || width === 0) return 0;

  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.font = palette.font;
  context.textBaseline = "middle";
  const charWidth = context.measureText("M").width || 7;
  const view = { window: scene.window, width, top: scene.top, rows: scene.rows };

  drawMark(context, scene, width, palette.mark);

  return eachVisibleFrame(scene.layout, view, (node, x, w, level) => {
    const y = MARK_STRIP + (level - scene.top) * LEVEL;
    const selected = node === scene.frame;
    const fn = scene.layout.functionOf[node] ?? 0;

    context.fillStyle = selected ? palette.selected : (palette.greys[fn % GREYS.length] ?? "");
    context.fillRect(x, y, Math.max(1, w - (w > 3 ? 1 : 0)), FRAME);

    if (w < LABEL_PAD * 2 + charWidth * 3) return;
    const text = fitted(labelOf(scene, node, selected), w - LABEL_PAD * 2, charWidth);

    context.fillStyle = selected ? palette.selectedLabel : palette.label;
    context.fillText(text, x + LABEL_PAD, y + FRAME / 2 + 0.5);
  });
};
