import { test } from "bun:test";
import { expectFullDelivery, heavyArtifacts } from "./deliver-notices.testing";

// Writes, re-reads and removes ~2,600 files: 2.4-6.1 s on a hosted macOS runner, against ~0.6 s locally.
const STAGING_TIMEOUT_MS = 60_000;

for (const candidate of heavyArtifacts) {
  test(
    `offline notice delivery covers ${candidate.id} without activation`,
    () => expectFullDelivery(candidate),
    STAGING_TIMEOUT_MS
  );
}
