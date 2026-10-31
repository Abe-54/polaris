/** A Data preview scene: the DataApi it reads through, and what it opens once mounted. */
import type { AppState } from "../../../../store/store.ts";
import type { DataApi } from "../../data/api.ts";
import type { DataSessionKey } from "../../model/store.ts";

export interface DataScene {
  /** Defaults to `fixtureDataApi()`. */
  readonly api?: () => DataApi;
  /** Opens tabs and sets filters for the shown session. */
  readonly play?: (at: DataSessionKey) => void;
  /** The app's state before mount, from the preview's: a Working session, a pending approval. */
  readonly state?: (base: AppState) => AppState;
}
