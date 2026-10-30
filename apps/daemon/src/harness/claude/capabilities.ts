import type { HarnessDriver } from "../HarnessDriver.ts";

/** What the Claude driver declares; `registry.ts` declares the same for its lazy stand-in. */
export const CLAUDE_CAPABILITIES = {
  steer: true,
  steerAttachments: true,
  liveCoAttach: false,
  switchModel: true,
  stopBackground: true,
  backgroundCommand: true,
  shellCommand: true,
  compact: true,
} as const satisfies HarnessDriver["capabilities"];
