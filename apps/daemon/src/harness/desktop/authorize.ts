/**
 * The one hook D3's app approvals plug into: every `polaris_desktop` call asks it first. Until
 * then, headless calls run, headed ones only behind a flag, and shells and secrets never.
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

/** Apps that would hand the agent a shell or the user's secrets, past the Harness's approvals. */
const NEVER = new Set(
  [
    "Terminal",
    "iTerm2",
    "iTerm",
    "Ghostty",
    "Warp",
    "kitty",
    "Alacritty",
    "WezTerm",
    "Script Editor",
    "Automator",
    "Shortcuts",
    "System Settings",
    "Keychain Access",
    "Passwords",
    "Polaris",
    "Polaris Computer Use",
  ].map((name) => name.toLowerCase())
);

export const neverRefused = (app: string) =>
  `polaris_desktop doesn't drive ${app}: it would get around the approvals this session asks for. Ask the user to do this step.`;

const refusedApp = (call: DesktopCall) =>
  [call.target.appName, call.target.app].find(
    (app): app is string => app !== null && NEVER.has(app.trim().toLowerCase())
  );

export const defaultAuthorize =
  (allowHeaded: () => boolean = headedFlag): Authorize =>
  (call) => {
    const app = refusedApp(call);

    if (app !== undefined)
      return Effect.succeed(Authorization.Refuse({ message: neverRefused(app) }));

    return Effect.succeed(
      !call.headed || allowHeaded()
        ? Authorization.Allow()
        : Authorization.Refuse({ message: HEADED_REFUSED })
    );
  };
