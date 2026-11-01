/** Best-effort attribution of database shell commands; this never authorizes or blocks them. */
import { type DataSource, type DomainEvent } from "@polaris/protocol";
import { Effect, Predicate, Redacted } from "effect";
import { basename } from "node:path";
import type { DataQueries, DataSources } from "./index.ts";

const protectedChar = (char: string) => (char === "$" ? "\\$" : char);

const clients = new Set(["psql", "mysql", "pg_dump", "mysqldump", "pgcli"]);

/** Tokenize without executing substitutions; separators inside quotes remain in their argument. */
const commands = (command: string) => {
  const groups: string[][] = [[]];
  let word = "";
  let quote = "";
  let escaped = false;

  const push = () => {
    if (word !== "") groups.at(-1)!.push(word);
    word = "";
  };

  const consume = (char: string) => {
    if (escaped) {
      word += protectedChar(char);
      escaped = false;

      return;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;

      return;
    }

    if (quote !== "") {
      if (char === quote) quote = "";
      else word += quote === "'" ? protectedChar(char) : char;

      return;
    }

    if (char === "'" || char === '"') {
      quote = char;

      return;
    }

    if (/[;&|()\n]/.test(char)) {
      push();
      groups.push([]);

      return;
    }

    if (/\s/.test(char)) {
      push();

      return;
    }

    word += char;
  };

  for (const char of command) consume(char);

  push();

  return groups.filter((group) => group.length > 0);
};

const host = (value: string) =>
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(value.toLowerCase())
    ? "localhost"
    : value.toLowerCase();

const target = (value: string) => {
  try {
    const url = new URL(value);

    const engine =
      url.protocol === "postgres:" || url.protocol === "postgresql:"
        ? "postgres"
        : url.protocol === "mysql:"
          ? "mysql"
          : null;

    if (engine === null) return null;

    return JSON.stringify([
      engine,
      host(url.hostname),
      url.port || (engine === "postgres" ? "5432" : "3306"),
      decodeURIComponent(url.pathname.slice(1)),
      decodeURIComponent(url.username),
    ]);
  } catch {
    return null;
  }
};

const skipFlags = (rest: string[], valued: ReadonlyArray<string>) => {
  while (rest[0]?.startsWith("-")) {
    const flag = rest.shift();

    if (valued.includes(flag ?? "")) rest.shift();
  }
};

const unwrapDocker = (rest: string[]) => {
  rest.shift();

  if (rest[0] === "compose") rest.shift();

  if (rest.shift() !== "exec") return false;
  skipFlags(rest, ["-u", "--user", "-w", "--workdir", "-e", "--env"]);
  rest.shift();

  return true;
};

const invocation = (args: ReadonlyArray<string>, inherited = new Map<string, string>()) => {
  const rest = [...args];
  const env = new Map(inherited);

  while (rest.length > 0) {
    const assignment = /^([A-Za-z_][A-Za-z_\d]*)=(.*)$/.exec(rest[0]!);

    if (assignment !== null) {
      env.set(assignment[1]!, assignment[2]!);
      rest.shift();
      continue;
    }

    const name = basename(rest[0]!);

    if (["env", "command", "sudo"].includes(name)) {
      rest.shift();

      skipFlags(rest, ["-u", "-g", "--user", "--group", "--unset"]);

      continue;
    }

    if (name === "docker") {
      if (!unwrapDocker(rest)) return { name: "", args: [], env };

      continue;
    }

    break;
  }

  return { name: basename(rest.shift() ?? ""), args: rest, env };
};

const nativeFlags = (mysql: boolean) =>
  new Map<string, string>([
    ["--host", "host"],
    ["-h", "host"],
    ["--port", "port"],
    [mysql ? "-P" : "-p", "port"],
    [mysql ? "--user" : "--username", "user"],
    [mysql ? "-u" : "-U", "user"],
    [mysql ? "--database" : "--dbname", "database"],
    [mysql ? "-D" : "-d", "database"],
  ]);

const readNativeArgs = (
  args: ReadonlyArray<string>,
  flags: Map<string, string>,
  values: Map<string, string>
) => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const equals = arg.indexOf("=");
    const field = flags.get(equals === -1 ? arg : arg.slice(0, equals));

    if (field !== undefined) {
      const value = equals === -1 ? args[++i] : arg.slice(equals + 1);

      if (value !== undefined) values.set(field, value);
    } else if (!arg.startsWith("-") && !values.has("database")) values.set("database", arg);
    else if (["-c", "-f", "-o", "-e", "--command", "--file"].includes(arg)) i++;
  }
};

const flagTarget = (call: ReturnType<typeof invocation>, source: DataSource) => {
  const mysql = call.name === "mysql" || call.name === "mysqldump";

  const flags = nativeFlags(mysql);

  const prefix = mysql ? "MYSQL_" : "PG";
  const values = new Map<string, string>();

  for (const field of ["host", "port", "user", "database"])
    if (call.env.has(`${prefix}${field.toUpperCase()}`))
      values.set(field, call.env.get(`${prefix}${field.toUpperCase()}`)!);

  readNativeArgs(call.args, flags, values);

  return (
    source.engine === (mysql ? "mysql" : "postgres") &&
    host(values.get("host") ?? "localhost") === host(source.host) &&
    values.get("database") === source.database &&
    (values.get("user") ?? source.user) === source.user &&
    Number(values.get("port") ?? (mysql ? 3306 : 5432)) === source.port
  );
};

export const outsideMatches = (
  command: string,
  source: DataSource,
  url: Redacted.Redacted<string>
) => {
  const expected = target(Redacted.value(url));

  if (expected === null) return false;
  const key = source.foundIn.key;

  const matches = (script: string, inherited = new Map<string, string>(), depth = 0): boolean => {
    if (depth > 4) return false;

    return commands(script).some((group) => {
      const call = invocation(group, inherited);

      if (["sh", "bash", "zsh"].includes(call.name)) {
        const index = call.args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));

        return (
          index !== -1 &&
          call.args[index + 1] !== undefined &&
          matches(call.args[index + 1]!.replace(/\\\$/g, "$"), call.env, depth + 1)
        );
      }

      const oneLiner =
        ["bun", "node"].includes(call.name) &&
        call.args.some((arg) => arg === "-e" || arg === "--eval") &&
        call.args.some((arg) => /\b(?:connect|SQL)\s*\(|\bsql\s*`/.test(arg));

      const prisma =
        ["npx", "bunx", "prisma"].includes(call.name) &&
        call.args.includes("execute") &&
        call.args.includes("db");

      if (!clients.has(call.name) && !oneLiner && !prisma) return false;

      if (clients.has(call.name) && flagTarget(call, source)) return true;

      if (oneLiner && call.args.some((arg) => /Bun\.sql\s*`/.test(arg)) && key === "DATABASE_URL")
        return true;

      return call.args.some((arg) => {
        if (oneLiner)
          return (
            /\b(?:process\.)?env(?:\.DATABASE_URL|\[['"]DATABASE_URL['"]\])/.test(arg) &&
            (call.env.has("DATABASE_URL")
              ? target(call.env.get("DATABASE_URL")!) === expected
              : key === "DATABASE_URL")
          );
        const value = arg.replace(/^--(?:dbname|database|url)=/, "");

        if (target(value) === expected) return true;

        return (
          key !== undefined &&
          (value === `$${key}` || value === `\${${key}}`) &&
          (!call.env.has(key) || target(call.env.get(key)!) === expected)
        );
      });
    });
  };

  return matches(command);
};

export const recordOutsideCommand = Effect.fnUntraced(function* (
  event: Extract<DomainEvent, { _tag: "TurnItemCompleted" }>,
  sources: Pick<DataSources["Service"], "list" | "resolve">,
  queries: Pick<DataQueries["Service"], "recordOutside">
) {
  if (!Predicate.isTagged(event.item, "CommandExecution") || event.item.status === "declined")
    return;
  const command = event.item.command;

  if (!/\b(psql|mysql|pg_dump|mysqldump|pgcli|prisma|bun|node)\b/.test(command)) return;

  for (const source of yield* sources.list({ sessionId: event.sessionId })) {
    yield* Effect.gen(function* () {
      const resolved = yield* sources.resolve({ sessionId: event.sessionId, source: source.name });

      if (!outsideMatches(command, source, resolved.matchUrl)) return;
      yield* queries.recordOutside({
        sessionId: event.sessionId,
        turn: event.turnId,
        source: source.name,
        command,
        itemId: event.item.id,
      });
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Couldn't record an outside Polaris command for a data source")
      )
    );
  }
});
