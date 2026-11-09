import { Redacted } from "effect";

/** A test Desktop App's user key: a fresh root enrols it on its first `hello` (ADR 0099). */
export const TEST_USER_KEY = { userKey: Redacted.make("0".repeat(64)) } as const;
