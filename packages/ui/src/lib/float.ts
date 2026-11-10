/** A floating layer: the raised surface, card radius, a hairline and the float shadow. */
export const FLOAT_SURFACE =
  "rounded-card border border-hairline bg-raised text-text-default shadow-float outline-hidden";

/** Popovers keep this clear of the window's edges when they flip, shift or shrink. */
export const FLOAT_EDGE = 12;

/**
 * Floating layers fade in over 160ms, ease-out, scaling from 96% at the side that faces their
 * trigger (Radix Popper's origin), and close at once (DESIGN.md, Motion).
 */
export const FLOAT_MOTION =
  "origin-(--radix-popper-transform-origin) data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.96] duration-160 ease-out";

/** A mount-only reveal: fades in over 160ms, ease-out. */
export const REVEAL_MOTION = "animate-in fade-in-0 duration-160 ease-out";

/** Tooltips: the first one fades in over 160ms; later ones (skip-delay) and closing are instant. */
export const TOOLTIP_MOTION =
  "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 duration-160 ease-out";
