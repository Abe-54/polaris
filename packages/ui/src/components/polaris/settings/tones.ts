/** Paper SR-Kit's translucent edges and fills, each a light-dark() pair. */

/** A control's edge on a raised surface (white 8% dark). */
export const CONTROL_EDGE = "border-[light-dark(#00000014,#ffffff14)]";

/** A dashed edge: unset ("Choose account"), or a host that isn't connected. */
export const DASHED_EDGE = "border-dashed border-[light-dark(#00000026,#ffffff2e)]";

/** The secondary button's fill and the scope pill's (white 6% and 4% dark). */
export const SOFT_FILL = "bg-[light-dark(#0000000a,#ffffff0f)]";

export const FAINT_FILL = "bg-[light-dark(#00000005,#ffffff0a)]";

/** Settings' row padding: 12px a side at Calm, from the gap token. */
export const ROW_PAD = "px-panel py-[calc(var(--spacing-gap)+4px)]";

/** A per-host or override row: 48px at Calm around a 26px control. */
export const LANE_PAD = "px-panel py-[calc(var(--spacing-gap)+3px)]";
