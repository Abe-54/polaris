/**
 * The model sheet's state and commands: the session's Harness's Models (asked once per Harness),
 * the Harnesses a Fork can move to, and SetModel / SetPermissionMode / ForkSession sent to the Host.
 */
import type {
  Capability,
  Command,
  HarnessKind,
  Model,
  PermissionMode,
  ReasoningEffort,
  Turn,
  TurnId,
} from "@polaris/protocol";
import { useEffect, useState } from "react";
import { useNavigation } from "../app/navigation.tsx";
import { type HarnessOption, harnessOptions } from "../newSession/harness.ts";
import { newSessionId, type PermissionOption } from "../newSession/model.ts";
import type { HostConnection } from "../runtime/hostConnection.ts";
import type { Session } from "../thread/fold.ts";
import { newCommandId } from "../thread/source.ts";
import {
  CHANGE_NOTES,
  currentModel,
  modelLabel,
  forkCommand,
  type ModelChange,
  modelChange,
  permissionModesFor,
  setModelCommand,
  setPermissionCommand,
} from "./modelSheet.ts";
import { modelsFor, rememberModels, rememberSteersAttachments } from "./modelNames.ts";

export interface ModelSheetInput {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly harness: HarnessKind;
  /** The Harness's Models, in its order; empty while loading or when it won't say. */
  readonly models: ReadonlyArray<Model>;
  readonly model: Model | null;
  /** The chip's words: the Model's name, else its id, else "Default". */
  readonly label: string;
  readonly effort: ReasoningEffort | null;
  readonly change: ModelChange;
  readonly note: string | null;
  /** Other Harnesses a Fork can move to; empty without a finished Turn. */
  readonly forkTo: ReadonlyArray<HarnessOption>;
  /** "fork": picking another Harness forks the session; "choose": it is the one it starts on. */
  readonly harnessPick: "fork" | "choose";
  readonly permission: PermissionMode;
  readonly permissions: ReadonlyArray<PermissionOption>;
  /** Why the last change didn't go through; null when it did. */
  readonly error: string | null;
  readonly pickModel: (model: Model, effort: ReasoningEffort | null) => void;
  readonly pickPermission: (mode: PermissionMode) => void;
  readonly forkOn: (harness: HarnessKind) => void;
}

export interface ModelSheetContext {
  readonly hostId: string;
  readonly connection: HostConnection | null;
  readonly capabilities: ReadonlyArray<Capability>;
  readonly session: Session;
  readonly turnInFlight: boolean;
  /** The last Turn that ended, which a Fork starts from; null before any. */
  readonly lastFinished: TurnId | null;
}

/** What the sheet changes, from the thread's fold; the Host only while it's connected. */
export const sheetContextOf = (
  connection: HostConnection,
  live: boolean,
  fold: { readonly session: Session; readonly turns: ReadonlyArray<{ readonly turn: Turn }> }
): ModelSheetContext => ({
  hostId: connection.hostId,
  connection: live ? connection : null,
  capabilities: connection.status().capabilities,
  session: fold.session,
  turnInFlight: fold.turns.at(-1)?.turn.status === "working",
  lastFinished: fold.turns.findLast((t) => t.turn.status !== "working")?.turn.id ?? null,
});

interface Listed {
  readonly models: ReadonlyArray<Model>;
  readonly switchesModel: boolean;
}

/** The session's Harness's Models, asked again only when the Host or Harness changes. */
const useModels = (hostId: string, connection: HostConnection | null, harness: HarnessKind) => {
  const [listed, setListed] = useState<Listed>({ models: [], switchesModel: false });

  useEffect(() => {
    if (connection === null) return;
    let live = true;

    void connection
      .run((client) => client["harness.models"]({ harness, refresh: false }))
      .then((reply) => {
        rememberModels(hostId, harness, reply.models);
        rememberSteersAttachments(hostId, harness, reply.steersAttachments);

        if (live) setListed({ models: reply.models, switchesModel: reply.switchesModel });
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, [hostId, connection, harness]);

  return { ...listed, models: modelsFor(hostId, harness, listed.models) };
};

/** The ready Harnesses other than the session's, asked when the sheet opens. */
const useForkTargets = (connection: HostConnection | null, open: boolean, own: HarnessKind) => {
  const [options, setOptions] = useState<ReadonlyArray<HarnessOption>>([]);

  useEffect(() => {
    if (connection === null || !open) return;
    let live = true;

    void connection
      .run((client) => client["harness.availability"]({ refresh: false }))
      .then((report) => {
        if (live) setOptions(harnessOptions(report).filter((o) => o.kind !== own && o.startable));
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, [connection, open, own]);

  return options;
};

export const useModelSheet = (ctx: ModelSheetContext): ModelSheetInput => {
  const { connection, session } = ctx;
  const navigation = useNavigation();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listed = useModels(ctx.hostId, connection, session.harness);
  const forkable = useForkTargets(connection, open, session.harness);
  const model = currentModel(listed.models, session.model);

  const change = modelChange({
    switchesModel: listed.switchesModel,
    capabilities: ctx.capabilities,
    turnInFlight: ctx.turnInFlight,
    hasFinishedTurn: ctx.lastFinished !== null,
  });

  const send = (command: Command) => {
    if (connection === null) return Promise.resolve(false);
    setError(null);

    return connection
      .run((client) => client.dispatch({ commandId: newCommandId(), command }))
      .then(() => true)
      .catch(() => {
        setError("Couldn't change it. Try again.");

        return false;
      });
  };

  const fork = (harness: HarnessKind, picked: Model | null, effort: ReasoningEffort | null) => {
    if (ctx.lastFinished === null) return;
    const sessionId = newSessionId();

    const command = forkCommand({
      sessionId,
      fromSessionId: session.id,
      fromTurnId: ctx.lastFinished,
      harness,
      model: picked,
      effort,
    });

    void send(command).then((ok) => {
      if (!ok) return;
      setOpen(false);
      navigation.push({
        screen: "thread",
        hostId: connection?.hostId ?? "",
        sessionId: String(sessionId),
      });
    });
  };

  return {
    open,
    setOpen,
    harness: session.harness,
    models: listed.models,
    model,
    label: modelLabel(model, session.model),
    effort: session.effort,
    change,
    note: CHANGE_NOTES[change.kind],
    forkTo: ctx.lastFinished !== null && ctx.capabilities.includes("session.fork") ? forkable : [],
    harnessPick: "fork",
    permission: session.permissionMode,
    permissions: permissionModesFor(ctx.capabilities),
    error,
    pickModel: (picked, effort) => {
      if (change.kind === "set") void send(setModelCommand(session.id, picked, effort));
      else if (change.kind === "fork") fork(session.harness, picked, effort);
    },
    pickPermission: (mode) => {
      if (mode !== session.permissionMode) void send(setPermissionCommand(session.id, mode));
    },
    forkOn: (harness) => fork(harness, null, null),
  };
};
