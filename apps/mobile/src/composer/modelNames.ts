/**
 * The Models each Host's Harness last listed, kept for the app's life: a session started from a new
 * session names its Model on the chip at once, before the thread's own ask returns.
 */
import type { HarnessKind, Model } from "@polaris/protocol";

const known = new Map<string, ReadonlyArray<Model>>();

const keyOf = (hostId: string, harness: HarnessKind) => `${hostId}\u0000${harness}`;

export const rememberModels = (
  hostId: string,
  harness: HarnessKind,
  models: ReadonlyArray<Model>
): void => {
  if (models.length > 0) known.set(keyOf(hostId, harness), models);
};

/** The Models the Host just listed, else the ones it listed last; empty when it never said. */
export const modelsFor = (
  hostId: string,
  harness: HarnessKind,
  fetched: ReadonlyArray<Model>
): ReadonlyArray<Model> =>
  fetched.length > 0 ? fetched : (known.get(keyOf(hostId, harness)) ?? []);

const steering = new Map<string, boolean>();

/** What the Harness last said of `HarnessModels.steersAttachments` on this Host. */
export const rememberSteersAttachments = (
  hostId: string,
  harness: HarnessKind,
  steers: boolean
): void => {
  steering.set(keyOf(hostId, harness), steers);
};

/** The Harness takes files in a steer; false until the Host has said so. */
export const steersAttachmentsFor = (hostId: string, harness: HarnessKind): boolean =>
  steering.get(keyOf(hostId, harness)) ?? false;
