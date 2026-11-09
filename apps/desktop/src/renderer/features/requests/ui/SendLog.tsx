/** The Send log tab's slot (DESIGN.md, Requests → Sidebar), U3's to fill. */
import type { RequestsSlotProps } from "./slots.ts";

export const SendLog = (_props: RequestsSlotProps) => (
  <p className="text-caption text-text-subtle px-2 py-2" data-testid="requests-send-log">
    Sends from this checkout show here
  </p>
);
