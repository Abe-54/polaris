/**
 * Setup's side effects: install the polaris-tracing skill bundled with the Host's Daemon, then start
 * an agent session in the same checkout; or hand the fixed-exporter change to an agent.
 */
import type { AgentSession, SessionId, SessionPlacement } from "@polaris/protocol";
import { Match } from "effect";
import { Commands, newSessionId } from "../../../../commands.ts";
import { polaris } from "../../../bridge.ts";
import { send } from "../../../session/dispatch.ts";
import { askRoute, SETUP_PROMPT } from "../../model/agentSetup.ts";

export interface SetupPlace {
  readonly hostKey: string;
  readonly workspaceId: string;
  /** The agent session Traces shows; a new one copies its Harness, Model and checkout. */
  readonly session: AgentSession;
  /** Where a new session works: the shown session's checkout (agentSetup.ts placementOf). */
  readonly placement: SessionPlacement;
}

export type SetupProgress =
  | { readonly kind: "idle" }
  | { readonly kind: "installing" }
  | { readonly kind: "starting" }
  | { readonly kind: "started"; readonly sessionId: SessionId }
  | { readonly kind: "failed"; readonly message: string; readonly fix: string | null };

/** A new agent session beside the shown one with `prompt`; its id, or null after a refusal (toasted). */
export const startAgent = async (place: SetupPlace, prompt: string): Promise<SessionId | null> => {
  const sessionId = newSessionId();
  const { session } = place;

  const started = await send(
    place.hostKey,
    Commands.StartSession({
      sessionId,
      workspaceId: session.workspaceId,
      harness: session.harness,
      placement: place.placement,
      permissionMode: session.permissionMode,
      model: session.model,
      effort: session.effort,
      prompt,
      attachments: [],
    }),
    "Couldn't start the agent session"
  );

  return started ? sessionId : null;
};

/** Installs the Daemon's bundled skill for the session's Harness, then starts the agent session. */
export const setUpTracing = async (
  place: SetupPlace,
  report: (progress: SetupProgress) => void
): Promise<void> => {
  report({ kind: "installing" });

  const installed = await polaris().request("traces.installSkill", {
    hostKey: place.hostKey,
    harness: place.session.harness,
  });

  if (!installed.ok)
    return report({
      kind: "failed",
      message: installed.error.message,
      fix: installed.error.fix ?? null,
    });

  report({ kind: "starting" });
  const sessionId = await startAgent(place, SETUP_PROMPT);

  report(
    sessionId === null
      ? {
          kind: "failed",
          message: "The skill is installed, but the agent session didn't start",
          fix: null,
        }
      : { kind: "started", sessionId }
  );
};

export type Asked =
  | { readonly kind: "steered" | "sent" | "started"; readonly sessionId: SessionId }
  | { readonly kind: "refused" | "waiting" };

/**
 * Steers the shown session while it works, sends it as its next Turn when idle, sends nothing while
 * it starts, else starts one.
 */
export const askAgent = async (place: SetupPlace, prompt: string): Promise<Asked> => {
  const { session } = place;
  const title = "Couldn't hand the change to the agent";

  return Match.value(askRoute(session.state)).pipe(
    Match.when("steer", async (): Promise<Asked> =>
      (await send(place.hostKey, Commands.Steer({ sessionId: session.id, text: prompt }), title))
        ? { kind: "steered", sessionId: session.id }
        : { kind: "refused" }
    ),
    Match.when("send", async (): Promise<Asked> =>
      (await send(
        place.hostKey,
        Commands.SendTurn({ sessionId: session.id, prompt, attachments: [] }),
        title
      ))
        ? { kind: "sent", sessionId: session.id }
        : { kind: "refused" }
    ),
    Match.when("wait", async (): Promise<Asked> => ({ kind: "waiting" })),
    Match.when("start", async (): Promise<Asked> => {
      const sessionId = await startAgent(place, prompt);

      return sessionId === null ? { kind: "refused" } : { kind: "started", sessionId };
    }),
    Match.exhaustive
  );
};
