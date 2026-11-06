import { expect, test } from "bun:test";
import { checkCatalog } from "./check";

// Reads and hashes ~3,300 retained files: 0.7-5.1 s on a hosted macOS runner, against 0.1-0.5 s locally.
const AUDIT_TIMEOUT_MS = 60_000;

test(
  "catalog audit roots and eligibility flags match the exact retained evidence",
  () => {
    expect(checkCatalog()).toEqual([]);
  },
  AUDIT_TIMEOUT_MS
);
