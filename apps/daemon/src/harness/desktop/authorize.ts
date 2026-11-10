/**
 * The one hook D3's app approvals plug into: every `polaris_desktop` call asks it first.
 * Until then, headless calls run and headed ones only behind `POLARIS_COMPUTER_USE_HEADED=1`.
 */
import type { SessionId } from "@polaris/protocol";
import { Data, Effect } from "effect";
import type { Json, Target } from "./catalog.ts";

export interface DesktopCall {
  readonly sessionId: SessionId;
  readonly tool: string;
  readonly input: Json;
  readonly headed: boolean;
  /** The app's display name, when the call names one or acts on a ref from its snapshot. */
  readonly target: Target & { readonly appName: string | null };
}

export type Authorization = Data.TaggedEnum<{
  Allow: Record<never, never>;
  /** `message` is the tool result the agent reads. */
  Refuse: { readonly message: string };
}>;

export const Authorization = Data.taggedEnum<Authorization>();

export type Authorize = (call: DesktopCall) => Effect.Effect<Authorization>;

export const HEADED_REFUSED =
  "Headed input is off on this Host: it needs the user's approval, which Polaris can't ask for yet. Use the headless tools, or tell the user the app has no accessibility tree.";

/** `POLARIS_COMPUTER_USE_HEADED=1` lets headed input through unasked: for testing, off by default. */
export const headedFlag = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  env.POLARIS_COMPUTER_USE_HEADED === "1";

export const defaultAuthorize =
  (allowHeaded: () => boolean = headedFlag): Authorize =>
  (call) =>
    Effect.succeed(
      !call.headed || allowHeaded()
        ? Authorization.Allow()
        : Authorization.Refuse({ message: HEADED_REFUSED })
    );
