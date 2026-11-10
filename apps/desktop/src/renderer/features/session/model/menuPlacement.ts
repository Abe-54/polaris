/**
 * Where the composer's `/` and `@` menus open: above the composer, unless the
 * room there is short and there is more below (the new-session page, where the
 * composer sits near the top of its scroll area); capped to the room it gets.
 */

/** The menus' own cap; below this the room above counts as short. */
export const MENU_MAX = 320;

/** The gap between the menu and the composer, and kept from the clipping edge. */
const GAP = 8;

export interface MenuPlacement {
  readonly side: "above" | "below";
  /** The most the menu may take, in px. */
  readonly room: number;
}

/** `above` and `below`: the px between the composer and its clipping edges. */
export const placeMenu = (above: number, below: number): MenuPlacement => {
  const side = above >= MENU_MAX + GAP || above >= below ? "above" : "below";

  return { side, room: Math.max(0, Math.min(MENU_MAX, (side === "above" ? above : below) - GAP)) };
};
