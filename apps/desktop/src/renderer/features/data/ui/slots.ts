/** The props every Data slot component takes, so U1–U3 can replace a file without touching the layout. */
import type { DataSessionKey } from "../model/store.ts";
import type { DataTab } from "../model/tabs.ts";

export interface DataSlotProps {
  readonly at: DataSessionKey;
  readonly hostKey: string;
  readonly workspaceId: string;
  /** The focused tab; null when none is open. */
  readonly active: DataTab | null;
}

export interface DataTabProps<T extends DataTab = DataTab> {
  readonly at: DataSessionKey;
  readonly tab: T;
}
