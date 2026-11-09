/** The Requests RPCs (ADR 0098, ENG-809): each acts on the checkout of its Agent Session. */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative } from "node:path";
import {
  RequestsError,
  RequestsRpcs,
  type HttpRequest,
  type OriginLocality,
  type RequestFile,
  type RequestTarget,
  type RequestsSnapshot,
  type SessionId,
} from "@polaris/protocol";
import { Duration, Effect, Layer, Queue, Result, Stream } from "effect";
import { subscribeDirectoryChanges } from "../files/watch.ts";
import { FileSearch } from "../files/FileSearch.ts";
import { withFileMutation } from "../files/write.ts";
import { EventStore } from "../store/EventStore.ts";
import { originLocality, parseOrigin, type LocalityProbes } from "./approvals/locality.ts";
import {
  ENV_FILE,
  PRIVATE_ENV_FILE,
  REQUEST_FILE_LIMIT,
  editRequest,
  formatCurl,
  isRequestFile,
  loadSnapshot,
  parseCurl,
  parseDocument,
  resolveRequest,
  variableSources,
} from "./format/index.ts";
import { loadTarget, prepare } from "./prepare.ts";
import { RequestSends } from "./sendsService.ts";

/** Where the Requests view saves a Request that has no file yet. */
export const NEW_REQUEST_FILE = "http/requests.http";

/** Quiet time after the last relevant change before `requests.watch` reloads. */
export const WATCH_SETTLE_MS = 100;

export type CheckoutOf = (sessionId: SessionId) => Effect.Effect<string, RequestsError>;

export interface RequestsRpcsOptions {
  readonly probes?: LocalityProbes;
  readonly settleMs?: number;
}

const unavailable = (cause: unknown) =>
  new RequestsError({
    code: "E-REQUESTS-UNAVAILABLE",
    message: `Requests couldn't read the checkout: ${cause instanceof Error ? cause.message : String(cause)}`,
    fix: "Check that the Agent Session's checkout still exists, then try again.",
  });

const input = (message: string, fix: string) =>
  new RequestsError({ code: "E-INPUT", message, fix });

/** An Agent Session's checkout is its working directory, as Data and Traces read it. */
export const sessionCheckout =
  (store: EventStore["Service"]): CheckoutOf =>
  (sessionId) =>
    Effect.flatMap(store.model, (model) => {
      const record = model.sessions.get(sessionId);

      return record
        ? Effect.succeed(record.session.cwd)
        : Effect.fail(
            input(`No Agent Session ${sessionId} on this Host.`, "Select an Agent Session.")
          );
    });

const attempt = <A>(run: () => Promise<Result.Result<A, RequestsError>>) =>
  Effect.tryPromise({ try: run, catch: unavailable }).pipe(Effect.flatMap(Effect.fromResult));

const inside = (root: string, path: string) => {
  const rel = relative(root, path);

  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** A checkout-relative `.http`/`.rest` path with no `..`, absolute part or backslash. */
const validFile = (file: string) =>
  isRequestFile(file) &&
  !file.includes("\\") &&
  !posix.isAbsolute(file) &&
  posix.normalize(file) === file &&
  !file.startsWith("../");

const saveRefused = (file: string, why: string) =>
  input(`Polaris can't save to ${file}: ${why}.`, "Save to a .http file inside the checkout.");

/** The nearest existing ancestor of `dir` must resolve inside the checkout before any mkdir. */
const ensureDirectory = async (root: string, dir: string) => {
  let existing = dir;

  while (
    !(await lstat(existing).then(
      () => true,
      () => false
    ))
  )
    existing = dirname(existing);

  if (!inside(root, await realpath(existing))) return undefined;
  await mkdir(dir, { recursive: true });
  const real = await realpath(dir);

  return inside(root, real) ? real : undefined;
};

const writeAtomically = async (path: string, text: string, mode: number) => {
  const temp = join(dirname(path), `.polaris-save-${randomUUID()}`);

  try {
    const handle = await open(temp, "wx", mode);

    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
};

/** F's in-place edit, written atomically; a missing file and its directories are created. */
export const saveRequest = async (
  checkout: string,
  request: HttpRequest,
  previousName?: string
): Promise<Result.Result<RequestFile, RequestsError>> => {
  const file = request.file;

  if (!validFile(file)) return Result.fail(saveRefused(file, "not a .http path in the checkout"));
  const root = await realpath(checkout);
  const dir = await ensureDirectory(root, dirname(join(root, file)));

  if (dir === undefined)
    return Result.fail(saveRefused(file, "its folder is outside the checkout"));
  const path = join(dir, basename(file));

  return withFileMutation(path, async () => {
    const stat = await lstat(path).catch(() => undefined);

    if (stat !== undefined && !stat.isFile())
      return Result.fail(saveRefused(file, "it isn't a regular file"));

    if (stat !== undefined && stat.size > REQUEST_FILE_LIMIT)
      return Result.fail(saveRefused(file, "it is too large to read (over 1 MiB)"));
    const text = stat === undefined ? "" : await readFile(path, "utf8");
    const edited = editRequest(text, file, request, previousName);

    if (Result.isFailure(edited)) return Result.fail(edited.failure);
    await writeAtomically(path, edited.success, stat === undefined ? 0o644 : stat.mode & 0o7777);

    return Result.succeed(parseDocument(edited.success, file).file);
  });
};

/** The variables a target uses, each URL-valued one with its origin's locality (G's check). */
export const requestVariables = async (
  checkout: string,
  target: RequestTarget,
  environment: string | undefined,
  probes: LocalityProbes = {}
) => {
  const loaded = await loadTarget(checkout, target);

  if (Result.isFailure(loaded)) return Result.fail(loaded.failure);
  const { path, request, variables } = loaded.success;
  const sources = await variableSources(checkout, path, variables, environment);

  if (Result.isFailure(sources)) return Result.fail(sources.failure);
  // F's callback is synchronous: a first pass collects the origins, then each is probed once.
  const origins = new Map<string, Promise<typeof OriginLocality.Type>>();

  const first = resolveRequest(
    request,
    {
      ...sources.success,
      locality: (url) => {
        const parsed = parseOrigin(url.href);

        if (parsed && !origins.has(parsed.origin))
          origins.set(parsed.origin, originLocality(parsed, probes));

        return undefined;
      },
    },
    environment
  );

  if (Result.isFailure(first)) return Result.fail(first.failure);
  const found = new Map<string, typeof OriginLocality.Type>();

  for (const [origin, locality] of origins) found.set(origin, await locality);

  const second = resolveRequest(
    request,
    {
      ...sources.success,
      locality: (url) => found.get(parseOrigin(url.href)?.origin ?? ""),
    },
    environment
  );

  return Result.map(second, (resolution) => resolution.variables);
};

const ENV_NAMES = new Set([ENV_FILE, PRIVATE_ENV_FILE]);

const relevant = (path: string) => isRequestFile(path) || ENV_NAMES.has(basename(path));

/** The directories whose env files a snapshot reads: each request file's and its ancestors. */
const envDirectories = (root: string, snapshot: RequestsSnapshot) => {
  const dirs = new Set([root]);

  for (const file of snapshot.files)
    for (let dir = posix.dirname(file.path); dir !== "." && dir !== ""; dir = posix.dirname(dir))
      dirs.add(join(root, dir));

  return dirs;
};

const sameSnapshot = (a: RequestsSnapshot, b: RequestsSnapshot) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The snapshot now, then again after a `.http`/`.rest` or env file changes: directory watches on
 * the folders the snapshot reads (env files are often gitignored), the files/ watcher for the rest
 * of the tree. No polling; the directory watches are armed before the first snapshot is sent.
 */
export const watchSnapshot = (search: FileSearch["Service"], checkout: string, settleMs: number) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise({ try: () => realpath(checkout), catch: unavailable });
      const ticks = yield* Queue.sliding<void>(1);
      const watches = new Map<string, () => void>();

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const close of watches.values()) close();
          watches.clear();
        })
      );

      const follow = (snapshot: RequestsSnapshot) => {
        const wanted = envDirectories(root, snapshot);

        for (const [dir, close] of watches)
          if (!wanted.has(dir)) {
            close();
            watches.delete(dir);
          }

        for (const dir of wanted)
          if (!watches.has(dir))
            watches.set(
              dir,
              subscribeDirectoryChanges(dir, (path) => {
                if (relevant(path)) Queue.offerUnsafe(ticks, undefined);
              })
            );
      };

      const reload = Effect.tryPromise({ try: () => loadSnapshot(root), catch: unavailable }).pipe(
        Effect.map(({ snapshot }) => {
          follow(snapshot);

          return snapshot;
        })
      );

      const first = yield* reload;

      const tree = search.watch(root).pipe(
        Stream.mapError(unavailable),
        Stream.filter((batch) => batch.some((change) => relevant(change.path))),
        Stream.as(undefined)
      );

      const changes = Stream.merge(tree, Stream.fromQueue(ticks)).pipe(
        Stream.debounce(Duration.millis(settleMs)),
        Stream.mapEffect(() => reload)
      );

      return Stream.concat(Stream.succeed(first), changes).pipe(Stream.changesWith(sameSnapshot));
    })
  );

export const requestsHandlers = (checkoutOf: CheckoutOf, options: RequestsRpcsOptions = {}) =>
  RequestsRpcs.toLayer(
    Effect.gen(function* () {
      const sends = yield* RequestSends;
      const search = yield* FileSearch;
      const settleMs = options.settleMs ?? WATCH_SETTLE_MS;

      return {
        "requests.watch": ({ sessionId }) =>
          Stream.unwrap(
            Effect.map(checkoutOf(sessionId), (checkout) =>
              watchSnapshot(search, checkout, settleMs)
            )
          ),
        "requests.save": ({ sessionId, request, previousName }) =>
          Effect.flatMap(checkoutOf(sessionId), (checkout) =>
            attempt(() => saveRequest(checkout, request, previousName))
          ),
        "requests.send": ({ sessionId, target, environment }) =>
          Effect.flatMap(checkoutOf(sessionId), (checkout) =>
            sends.send({
              checkout,
              target,
              ...(environment === undefined ? undefined : { environment }),
              by: { kind: "user", sessionId },
            })
          ),
        "requests.variables": ({ sessionId, target, environment }) =>
          Effect.flatMap(checkoutOf(sessionId), (checkout) =>
            attempt(() => requestVariables(checkout, target, environment, options.probes))
          ),
        "requests.sendLog.page": ({ sessionId, before, filter, limit }) =>
          Effect.flatMap(checkoutOf(sessionId), (checkout) =>
            sends.page(checkout, {
              ...(before === undefined ? undefined : { before }),
              ...(filter === undefined ? undefined : { filter }),
              ...(limit === undefined ? undefined : { limit }),
            })
          ),
        "requests.sendLog.watch": ({ sessionId }) =>
          Stream.unwrap(Effect.map(checkoutOf(sessionId), (checkout) => sends.watch(checkout))),
        "requests.send.get": ({ sessionId, lookup }) =>
          Effect.flatMap(checkoutOf(sessionId), (checkout) => sends.get(checkout, lookup)),
        "requests.curl.parse": ({ sessionId, text }) =>
          Effect.andThen(checkoutOf(sessionId), Effect.fromResult(parseCurl(text))),
        "requests.curl.format": ({ sessionId, target, environment }) =>
          Effect.flatMap(checkoutOf(sessionId), (checkout) =>
            attempt(async () =>
              Result.map(await prepare(checkout, target, environment), (prepared) =>
                formatCurl(prepared.request, prepared.secrets)
              )
            )
          ),
      };
    })
  );

/** What the Daemon mounts (lazily, `transport/lazyRequests.ts`): checkouts from the event store. */
export const RequestsRpcsLive = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* EventStore;

    return requestsHandlers(sessionCheckout(store));
  })
);
