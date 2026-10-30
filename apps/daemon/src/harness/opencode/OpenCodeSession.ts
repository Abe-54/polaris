/**
 * One Agent Session's view of one OpenCode session on the shared server.
 *
 * It holds a lease on the server for as long as it is open, subscribes to its
 * directory's `/event` stream before creating or resuming the OpenCode session,
 * and hands every payload to the translator. A TUI attached with
 * `opencode attach` works on the same session, so its Turns show up here too.
 */
import { type ApprovalDecision, type Attachment, type RequestId } from "@polaris/protocol";
import { steerItem } from "../userMessage.ts";
import { type Cause, Deferred, Effect, Queue, Schema, type Scope, Stream } from "effect";
import { statSync } from "node:fs";
import {
  type HarnessError,
  HarnessEvent,
  type HarnessSession,
  type OpenOptions,
  type TurnInput,
} from "../HarnessDriver.ts";
import { clientFor, type OpenCodeClient } from "./Client.ts";
import {
  agentFor,
  parseModelId,
  permissionReply,
  promptParts,
  questionReply,
  rulesetFor,
} from "./mapping.ts";
import { readCommands, slashCommandOf } from "./commands.ts";
import * as P from "./protocol.ts";
import { type OpenCodeServer, opencodeError } from "./Server.ts";
import { translatorFor, type Translator } from "./translate.ts";
import { polarisContextWithoutTools } from "../../constellation/skills/preamble.ts";

const decodeSession = P.decoder(P.SessionInfo);

const decodeStatuses = P.decoder(P.SessionStatusMap);

const decodePermissions = P.decoder(Schema.Array(P.PermissionRequest));

const decodeQuestions = P.decoder(Schema.Array(P.QuestionRequest));

const CONNECT_TIMEOUT = "10 seconds";

/** What a mentioned path is on this Host (`mentionParts`). */
const pathKind = (path: string): "file" | "folder" | null => {
  const stat = statSync(path, { throwIfNoEntry: false });

  if (stat === undefined) return null;

  return stat.isDirectory() ? "folder" : "file";
};

/** argv for "Open in terminal": the password is read from its 0600 file, never put on a command line. */
export const attachCommand = (options: {
  readonly opencodePath: string;
  readonly passwordFile: string;
  readonly url: string;
  readonly sessionId: string;
  readonly cwd: string;
}): ReadonlyArray<string> => [
  "/bin/sh",
  "-c",
  'OPENCODE_SERVER_PASSWORD="$(cat "$1")" exec "$2" attach "$3" --session "$4" --dir "$5"',
  "opencode-attach",
  options.passwordFile,
  options.opencodePath,
  options.url,
  options.sessionId,
  options.cwd,
];

const modelOf = (id: string | null) =>
  id === null
    ? Effect.succeed(null)
    : Effect.fromNullishOr(parseModelId(id)).pipe(
        Effect.mapError(() => opencodeError(`${id} isn't an OpenCode Model id (provider/model)`))
      );

/** Creates the OpenCode session, or checks the one being resumed exists; returns its id. */
const createOrResume = (client: OpenCodeClient, options: OpenOptions) =>
  Effect.gen(function* () {
    const rules = rulesetFor(options.permissionMode);

    if (options.resumeCursor !== null) {
      const path = `/session/${encodeURIComponent(options.resumeCursor)}`;
      const found = decodeSession(yield* client.get(path));

      if (found === null)
        return yield* opencodeError(`OpenCode session ${options.resumeCursor} wasn't found`);
      yield* client.send("PATCH", path, { permission: rules } satisfies P.SessionUpdateBody);

      return found.id;
    }

    const model = yield* modelOf(options.model);
    const body: P.SessionCreateBody = { permission: rules };

    if (model !== null) {
      const chosen: NonNullable<P.SessionCreateBody["model"]> = {
        providerID: model.providerID,
        id: model.modelID,
      };

      if (options.effort !== null) chosen.variant = options.effort;
      body.model = chosen;
    }

    const created = decodeSession(yield* client.send("POST", "/session", body));

    return created === null
      ? yield* opencodeError("Unexpected response creating an OpenCode session")
      : created.id;
  });

/** On resume: a Turn already running (from the terminal) and the approvals it is waiting on. */
const catchUp = (client: OpenCodeClient, sessionId: string, translator: Translator) =>
  Effect.gen(function* () {
    const statuses = decodeStatuses(yield* client.get("/session/status"));

    if (statuses?.[sessionId]?.type === "busy") translator.adoptRunningTurn();

    for (const request of decodePermissions(yield* client.get("/permission")) ?? [])
      if (request.sessionID === sessionId) translator.openPermission(request);

    for (const request of decodeQuestions(yield* client.get("/question")) ?? [])
      if (request.sessionID === sessionId) translator.openQuestion(request);
  });

export const openSession = (
  server: OpenCodeServer,
  options: OpenOptions
): Effect.Effect<HarnessSession, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const handle = yield* server.lease;
    const client = clientFor(handle, options.cwd);
    const events = yield* Queue.unbounded<HarnessEvent, Cause.Done>();
    const connected = yield* Deferred.make<void>();

    const emit = (event: HarnessEvent) => {
      Queue.offerUnsafe(events, event);
    };

    const translator = translatorFor(options.cwd, emit, options.resumeCursor);
    const abort = new AbortController();
    let closing = false;
    let finished = false;

    const finish = (error: string | null) => {
      if (finished) return;
      finished = true;
      emit(HarnessEvent.Exited({ error }));
      Queue.endUnsafe(events);
    };

    yield* client.events(abort.signal).pipe(
      Stream.runForEach((payload) =>
        Effect.sync(() => translator.handle(payload)).pipe(
          Effect.andThen(Deferred.succeed(connected, undefined))
        )
      ),
      Effect.match({
        onFailure: (error) => finish(closing ? null : error.message),
        onSuccess: () => finish(closing ? null : "the OpenCode server closed the connection"),
      }),
      Effect.forkScoped
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closing = true;
        finish(null);
        abort.abort();
      })
    );

    yield* Deferred.await(connected).pipe(
      Effect.timeoutOrElse({
        duration: CONNECT_TIMEOUT,
        orElse: () => Effect.fail(opencodeError("OpenCode's event stream didn't connect")),
      })
    );
    const sessionId = yield* createOrResume(client, options);
    const sessionPath = `/session/${encodeURIComponent(sessionId)}`;
    translator.setSessionId(sessionId);
    emit(HarnessEvent.CursorAssigned({ cursor: sessionId }));

    if (options.resumeCursor !== null) yield* catchUp(client, sessionId, translator);

    let agent = agentFor(options.permissionMode);

    const prompt = (body: P.PromptAsyncBody) =>
      client
        .send(
          "POST",
          `${sessionPath}/prompt_async`,
          agent === undefined ? body : { ...body, agent }
        )
        .pipe(Effect.asVoid);

    /** `/name args` naming one of OpenCode's commands; it answers once the Turn is done, so it runs aside. */
    const runCommand = (input: TurnInput, call: P.CommandBody) =>
      client.send("POST", `${sessionPath}/command`, call).pipe(
        Effect.catch((error) =>
          Effect.sync(() => translator.failLocalTurn(input.turnId, error.message))
        ),
        Effect.forkDetach,
        Effect.asVoid
      );

    const sendTurn = (input: TurnInput) =>
      Effect.gen(function* () {
        if (translator.turn() !== null)
          return yield* opencodeError("A Turn is already in progress; steer or interrupt it");
        const model = yield* modelOf(input.model);
        const variant = input.effort;

        const slash = input.prompt.trimStart().startsWith("/")
          ? slashCommandOf(input.prompt, yield* readCommands(client))
          : null;

        translator.beginLocalTurn({ id: input.turnId, model, variant });

        if (slash !== null) {
          const call: P.CommandBody = { ...slash };

          if (model !== null) call.model = `${model.providerID}/${model.modelID}`;

          if (variant !== null) call.variant = variant;

          if (agent !== undefined) call.agent = agent;

          return yield* runCommand(input, call);
        }

        const body: P.PromptAsyncBody = {
          parts: promptParts(input.prompt, input.attachments, {
            cwd: options.cwd,
            kindOf: pathKind,
          }),
          system: polarisContextWithoutTools(),
        };

        if (model !== null) body.model = model;

        if (variant !== null) body.variant = variant;
        yield* prompt(body).pipe(
          Effect.tapError(() => Effect.sync(() => translator.abandonLocalTurn(input.turnId)))
        );
      });

    const steer = (text: string, attachments: ReadonlyArray<Attachment> = []) =>
      Effect.gen(function* () {
        const active = translator.turn();

        if (active === null) return yield* opencodeError("No Turn is in progress to steer");
        const body: P.PromptAsyncBody = { parts: promptParts(text, attachments) };

        if (active.model !== null) body.model = active.model;

        if (active.variant !== null) body.variant = active.variant;
        yield* prompt(body);
        emit(
          HarnessEvent.ItemCompleted({
            turnId: active.id,
            item: steerItem(`steer:${crypto.randomUUID()}`, text, attachments),
          })
        );
      });

    const respond = (requestId: RequestId, decision: ApprovalDecision) =>
      Effect.gen(function* () {
        const request = translator.takeRequest(requestId);

        if (request === null)
          return yield* opencodeError(
            `No open OpenCode request ${requestId}; it may have been resolved`
          );
        const id = encodeURIComponent(request.openId);

        if (request.type === "permission") {
          yield* client.send("POST", `/permission/${id}/reply`, permissionReply(decision));

          return;
        }

        const reply = questionReply(request.request, decision);
        yield* reply === null
          ? client.send("POST", `/question/${id}/reject`)
          : client.send("POST", `/question/${id}/reply`, reply);
      });

    const session: HarnessSession = {
      events: Stream.fromQueue(events),
      sendTurn,
      steer,
      interrupt: Effect.suspend(() =>
        translator.turn() === null
          ? Effect.void
          : client.send("POST", `${sessionPath}/abort`).pipe(Effect.asVoid)
      ),
      respond,
      setPermissionMode: (mode) =>
        client
          .send("PATCH", sessionPath, {
            permission: rulesetFor(mode),
          } satisfies P.SessionUpdateBody)
          .pipe(Effect.andThen(Effect.sync(() => (agent = agentFor(mode)))), Effect.asVoid),
      terminalCommand: Effect.succeed(
        attachCommand({
          opencodePath: handle.opencodePath,
          passwordFile: server.passwordFile,
          url: handle.url,
          sessionId,
          cwd: options.cwd,
        })
      ),
    };

    return session;
  });
