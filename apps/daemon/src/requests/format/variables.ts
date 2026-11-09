/** `{{name}}` resolution: file `@vars` over the environment, `{{$dotenv NAME}}`, dynamic values. */
import {
  RequestAuth,
  RequestsError,
  type AdHocRequest,
  type OriginLocality,
  type ResolvedVariable,
} from "@polaris/protocol";
import { Match, Result } from "effect";

/** Where values come from; `private` and `dotenv` values are secrets. */
export interface VariableSources {
  readonly file: Readonly<Record<string, string>>;
  readonly public: Readonly<Record<string, string>>;
  readonly private: Readonly<Record<string, string>>;
  readonly dotenv: Readonly<Record<string, string>>;
  /** The locality of a URL-valued variable's origin; Local needs no Origin Approval. */
  readonly locality?: (url: URL) => typeof OriginLocality.Type | undefined;
  readonly now?: () => Date;
}

export interface Resolution {
  readonly request: AdHocRequest;
  /** Every variable used, directly or through another, in first-use order. */
  readonly variables: ReadonlyArray<ResolvedVariable>;
  /** Resolved secret values, for `maskSecrets`. */
  readonly secrets: ReadonlyArray<string>;
}

export const MASK = "••••••••";

const REFERENCE = /\{\{\s*([^{}]*?)\s*\}\}/g;

const MAX_DEPTH = 16;

interface Found {
  readonly record: ResolvedVariable;
  readonly value: string;
}

type Lookup = { value: string; source: ResolvedVariable["source"]; secret: boolean } | undefined;

const lookup = (sources: VariableSources, name: string): Lookup => {
  const dotenv = /^\$dotenv\s+(\S+)$/.exec(name)?.[1];

  if (dotenv !== undefined) {
    const value = sources.dotenv[dotenv];

    return value === undefined ? undefined : { value, source: "dotenv", secret: true };
  }

  if (name in sources.file) return { value: sources.file[name]!, source: "file", secret: false };

  if (name in sources.private)
    return { value: sources.private[name]!, source: "env", secret: true };

  if (name in sources.public) return { value: sources.public[name]!, source: "env", secret: false };

  return undefined;
};

const randomInt = (args: string) => {
  const [min = 0, max = 1000] = args.split(/\s+/).filter(Boolean).map(Number);

  return String(Math.floor(min + Math.random() * Math.max(0, max - min)));
};

/** JetBrains' and REST Client's dynamic values; undefined for any other `$name`. */
const dynamic = (name: string, now: () => Date) => {
  const [head = "", ...rest] = name.split(/\s+/);

  return Match.value(head).pipe(
    Match.whenOr("$uuid", "$guid", "$random.uuid", () => crypto.randomUUID()),
    Match.when("$timestamp", () => String(Math.floor(now().getTime() / 1000))),
    Match.when("$isoTimestamp", () => now().toISOString()),
    Match.whenOr("$randomInt", "$random.integer", () => randomInt(rest.join(" "))),
    Match.orElse(() => undefined)
  );
};

const origin = (value: string, sources: VariableSources) => {
  if (!sources.locality || !/^https?:\/\//i.test(value)) return undefined;

  try {
    return sources.locality(new URL(value));
  } catch {
    return undefined;
  }
};

interface Resolved {
  readonly value: string;
  readonly masked: boolean;
}

class Resolver {
  readonly found = new Map<string, Found>();
  /** Names in first-use order: a variable comes before the ones its value refers to. */
  readonly order: string[] = [];
  readonly unresolved = new Set<string>();
  readonly cycles = new Set<string>();

  constructor(private readonly sources: VariableSources) {}

  /** The text with every reference resolved; `masked` is true when any secret went into it. */
  text(text: string, stack: ReadonlyArray<string> = []): Resolved {
    let masked = false;

    const value = text.replace(REFERENCE, (whole, name: string) => {
      const resolved = this.variable(name, stack);

      if (resolved === undefined) return whole;
      masked ||= resolved.masked;

      return resolved.value;
    });

    return { value, masked };
  }

  private variable(name: string, stack: ReadonlyArray<string>): Resolved | undefined {
    if (name.startsWith("$") && !name.startsWith("$dotenv")) {
      const value = dynamic(name, this.sources.now ?? (() => new Date()));

      if (value === undefined) this.unresolved.add(name);

      return value === undefined ? undefined : { value, masked: false };
    }

    const seen = this.found.get(name);

    if (seen) return { value: seen.value, masked: seen.record.masked };

    if (stack.includes(name) || stack.length > MAX_DEPTH) {
      this.cycles.add(name);

      return undefined;
    }

    return this.define(name, stack);
  }

  private define(name: string, stack: ReadonlyArray<string>): Resolved | undefined {
    const found = lookup(this.sources, name);

    if (!found) {
      this.unresolved.add(name);

      return undefined;
    }

    this.order.push(name);
    const inner = this.text(found.value, [...stack, name]);
    const masked = found.secret || inner.masked;
    const locality = origin(inner.value, this.sources);

    const record: ResolvedVariable = { name, source: found.source, masked };

    if (!masked) Object.assign(record, { value: inner.value });

    if (locality) Object.assign(record, { origin: locality });

    this.found.set(name, { record, value: inner.value });

    return { value: inner.value, masked };
  }
}

const unresolvedError = (names: ReadonlyArray<string>, environment: string | undefined) => {
  const list = names.map((name) => `{{${name}}}`).join(", ");

  const where =
    environment === undefined
      ? "http-client.env.json"
      : `env ${environment} of http-client.env.json`;

  return new RequestsError({
    code: "E-VARIABLE-UNRESOLVED",
    message: `Not defined: ${list}`,
    fix: `Define it in ${where}, as @name = value in the file, or in .env for {{$dotenv NAME}}`,
  });
};

const cycleError = (names: ReadonlyArray<string>) =>
  new RequestsError({
    code: "E-VARIABLE-UNRESOLVED",
    message: `These variables refer to themselves: ${names.join(", ")}`,
    fix: "Give one of them a plain value",
  });

const resolveAuth = (auth: RequestAuth, text: (value: string) => string) =>
  Match.valueTags(auth, {
    Bearer: ({ token }) => RequestAuth.cases.Bearer.make({ token: text(token) }),
    Basic: ({ user, password }) =>
      RequestAuth.cases.Basic.make({ user: text(user), password: text(password) }),
  });

/** Resolves a Request's URL, headers, body and auth; any undefined name is an error, never "". */
export const resolveRequest = (
  request: AdHocRequest,
  sources: VariableSources,
  environment?: string
): Result.Result<Resolution, RequestsError> => {
  const resolver = new Resolver(sources);
  const text = (value: string) => resolver.text(value).value;

  const resolved: AdHocRequest = {
    method: request.method,
    url: text(request.url),
    headers: request.headers.map((header) => ({
      name: text(header.name),
      value: text(header.value),
    })),
  };

  if (request.body !== undefined) Object.assign(resolved, { body: text(request.body) });

  if (request.auth) Object.assign(resolved, { auth: resolveAuth(request.auth, text) });

  if (resolver.cycles.size > 0) return Result.fail(cycleError([...resolver.cycles]));

  if (resolver.unresolved.size > 0)
    return Result.fail(unresolvedError([...resolver.unresolved], environment));

  const found = resolver.order.flatMap((name) => resolver.found.get(name) ?? []);

  return Result.succeed({
    request: resolved,
    variables: found.map((item) => item.record),
    secrets: found
      .filter((item) => item.record.masked && item.value !== "")
      .map((item) => item.value),
  });
};

/** Replaces every secret value in `text` with the mask, longest first. */
export const maskSecrets = (text: string, secrets: ReadonlyArray<string>) =>
  [...secrets]
    .filter((secret) => secret !== "")
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.split(secret).join(MASK), text);
