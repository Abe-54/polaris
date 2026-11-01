import { PROTOCOL_VERSION } from "@polaris/protocol";

/** The protocol versions this SDK speaks, sent in `hello` (ADR 0075). */
export const SUPPORTED_PROTOCOL = { min: 1, max: PROTOCOL_VERSION } as const;

/** Reported as `clientVersion` when the Extension names none. */
export const SDK_VERSION = "0.2.0";
