/**
 * Setup's side effects: install the polaris-tracing skill in a terminal on the Host, then start an
 * agent session in the same checkout; or hand the fixed-exporter change to an agent.
 */
import type { AgentSession, SessionId, SessionPlacement } from "@polaris/protocol";
import { Match } from "effect";
import { Commands, newSessionId } from "../../../../commands.ts";
import { followExit } from "../../../review/checkout/exit.ts";
import { loginShellArgv } from "../../../review/checkout/model/run.ts";
import { send } from "../../../session/dispatch.ts";
import { runInTerminal } from "../../../terminal/index.ts";
import { askRoute, installCommand, SETUP_PROMPT } from "../../model/agentSetup.ts";
import { outputTail } from "../../model/installOutput.ts";

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
  | {
      readonly kind: "failed";
      readonly message: string;
      /** The last lines the install printed (stdout and stderr share the terminal). */
      readonly output: ReadonlyArray<string>;
    };

/** Lines of a failed install's output shown with its failure. */
const SHOWN_LINES = 6;

type Ended = { readonly code: number | null | "lost"; readonly output: ReadonlyArray<string> };

/** The install's exit code (null: the Host forgot the terminal; "lost": its feed ended) and output. */
const exitOf = (hostKey: string, terminalId: string) =>
  new Promise<Ended>((resolve) => {
    const tail = outputTail();
    const end = (code: Ended["code"]) => resolve({ code, output: tail.lines(SHOWN_LINES) });

    followExit(hostKey, terminalId, end, { onLost: () => end("lost"), onOutput: tail.push });
  });

const installFailure = (code: Ended["code"]): string => {
  if (code === "lost") return "Lost the install’s terminal before it finished; try again";

  return code === null
    ? "The install stopped before it finished"
    : `The install exited with code ${code}; its output is in the terminal`;
};

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

/** Installs the skill (output in the Workspace's terminal drawer), then starts the agent session. */
export const setUpTracing = async (
  place: SetupPlace,
  report: (progress: SetupProgress) => void
): Promise<void> => {
  report({ kind: "installing" });
  const install = installCommand(place.session.harness);

  const terminalId = await runInTerminal(
    { hostKey: place.hostKey, workspaceId: place.workspaceId },
    {
      key: `traces-setup:${place.session.id}`,
      title: install,
      cwd: place.session.cwd,
      argv: loginShellArgv(install),
    }
  );

  if (terminalId === null)
    return report({ kind: "failed", message: "Couldn't open a terminal on this host", output: [] });

  const { code, output } = await exitOf(place.hostKey, terminalId);

  if (code !== 0) return report({ kind: "failed", message: installFailure(code), output });

  report({ kind: "starting" });
  const sessionId = await startAgent(place, SETUP_PROMPT);

  report(
    sessionId === null
      ? {
          kind: "failed",
          message: "The skill is installed, but the agent session didn't start",
          output: [],
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
