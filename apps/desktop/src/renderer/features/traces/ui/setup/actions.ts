/**
 * Setup's side effects: install the polaris-tracing skill in a terminal on the Host, then start an
 * agent session in the same checkout; or hand the fixed-exporter change to an agent.
 */
import type { AgentSession, SessionId } from "@polaris/protocol";
import { Match } from "effect";
import { Commands, newSessionId } from "../../../../commands.ts";
import { followExit } from "../../../review/checkout/exit.ts";
import { loginShellArgv } from "../../../review/checkout/model/run.ts";
import { send } from "../../../session/dispatch.ts";
import { runInTerminal } from "../../../terminal/index.ts";
import { askRoute, INSTALL_COMMAND, placementOf, SETUP_PROMPT } from "../../model/agentSetup.ts";

export interface SetupPlace {
  readonly hostKey: string;
  readonly workspaceId: string;
  /** The agent session Traces shows; a new one copies its Harness, Model and checkout. */
  readonly session: AgentSession;
}

export type SetupProgress =
  | { readonly kind: "idle" }
  | { readonly kind: "installing" }
  | { readonly kind: "starting" }
  | { readonly kind: "started"; readonly sessionId: SessionId }
  | { readonly kind: "failed"; readonly message: string };

const exitOf = (hostKey: string, terminalId: string) =>
  new Promise<number | null>((resolve) => {
    followExit(hostKey, terminalId, resolve);
  });

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
      placement: placementOf(session),
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

/** Installs the skill (output in the Workspace's terminal drawer), then starts the agent session. */
export const setUpTracing = async (
  place: SetupPlace,
  report: (progress: SetupProgress) => void
): Promise<void> => {
  report({ kind: "installing" });

  const terminalId = await runInTerminal(
    { hostKey: place.hostKey, workspaceId: place.workspaceId },
    {
      key: `traces-setup:${place.session.id}`,
      title: INSTALL_COMMAND,
      cwd: place.session.cwd,
      argv: loginShellArgv(INSTALL_COMMAND),
    }
  );

  if (terminalId === null)
    return report({ kind: "failed", message: "Couldn't open a terminal on this host" });

  const code = await exitOf(place.hostKey, terminalId);

  if (code !== 0)
    return report({
      kind: "failed",
      message:
        code === null
          ? "The install stopped before it finished"
          : `The install exited with code ${code}; its output is in the terminal`,
    });

  report({ kind: "starting" });
  const sessionId = await startAgent(place, SETUP_PROMPT);

  report(
    sessionId === null
      ? { kind: "failed", message: "The skill is installed, but the agent session didn't start" }
      : { kind: "started", sessionId }
  );
};

export type Asked =
  | { readonly kind: "steered" | "sent" | "started"; readonly sessionId: SessionId }
  | { readonly kind: "refused" };

/** Steers the shown session while it works, sends it as its next Turn when idle, else starts one. */
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
    Match.when("start", async (): Promise<Asked> => {
      const sessionId = await startAgent(place, prompt);

      return sessionId === null ? { kind: "refused" } : { kind: "started", sessionId };
    }),
    Match.exhaustive
  );
};
