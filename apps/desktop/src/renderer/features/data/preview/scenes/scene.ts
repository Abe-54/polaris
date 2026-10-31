/** A Data preview scene: the DataApi it reads through, and what it opens once mounted. */
import type { DataApi } from "../../data/api.ts";
import type { DataSessionKey } from "../../model/store.ts";

export interface DataScene {
  /** Defaults to `fixtureDataApi()`. */
  readonly api?: () => DataApi;
  /** Opens tabs and sets filters for the shown session. */
  readonly play?: (at: DataSessionKey) => void;
}
