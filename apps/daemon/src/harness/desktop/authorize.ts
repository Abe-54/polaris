/**
 * What every `polaris_desktop` call on an app asks first: the Host's app policy (ADR 0107),
 * `AppControl` in `computerUse/control.ts`. It may wait on the user's approval.
 */
import type { AppRef, SessionId } from "@polaris/protocol";
import { Data, Effect } from "effect";

export interface DesktopCall {
  readonly sessionId: SessionId;
  /** The app the call acts on, by its stable id on the Host. */
  readonly app: AppRef;
  readonly headed: boolean;
  readonly signal?: AbortSignal | undefined;
}

export type Authorization = Data.TaggedEnum<{
  /** `asked`: the user answered an approval for this call just now. */
  Allow: { readonly asked: boolean };
  /** `message` is the tool result the agent reads. */
  Refuse: { readonly message: string };
}>;

export const Authorization = Data.taggedEnum<Authorization>();

export interface Authorize {
  readonly use: (call: DesktopCall) => Effect.Effect<Authorization>;
  /** Whether the session controls an app now. */
  readonly controlling: (sessionId: SessionId) => Effect.Effect<boolean>;
  /** The session's Turn ended: its Controlled apps are released. */
  readonly release: (sessionId: SessionId) => Effect.Effect<void>;
  /** The session stopped. */
  readonly forget: (sessionId: SessionId) => Effect.Effect<void>;
}

export const NAME_THE_APP =
  "polaris_desktop needs to know which app this is for: pass `app`, or use a ref or window id from a snapshot or list_windows of it.";

export const unknownApp = (app: string, host: string) =>
  `polaris_desktop can't find an app called ${JSON.stringify(app)} on ${host}. list_apps shows the ones that are running; use an app's exact name.`;

export const SCREEN_NEEDS_APP =
  "A screenshot that names no app needs an app this session controls: act on the app first (focus_window it), or pass `app` to screenshot its window.";

export const UNSEEN_TARGET =
  "polaris_desktop doesn't know that ref or window: use one from this session's own snapshot or list_windows.";

export const mixedApps = (app: string, other: string) =>
  `This call names ${app} but its ref or window belongs to ${other}. Name one app.`;
