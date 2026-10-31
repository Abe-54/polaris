/** Best-effort attribution of database shell commands; this never authorizes or blocks them. */
import { type DataSource, type DomainEvent } from "@polaris/protocol";
import { Effect, Predicate, Redacted } from "effect";
import { basename } from "node:path";
import type { DataQueries, DataSources } from "./index.ts";

const protectedChar = (char: string) => (char === "$" ? "\\$" : char);

const clients = new Set(["psql", "mysql", "pg_dump", "mysqldump"]);

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
      url.hostname.toLowerCase(),
      url.port || (engine === "postgres" ? "5432" : "3306"),
      decodeURIComponent(url.pathname.slice(1)),
      decodeURIComponent(url.username),
    ]);
  } catch {
    return null;
  }
};

const invocation = (args: ReadonlyArray<string>) => {
  const rest = [...args];
  const env = new Map<string, string>();

  while (rest.length > 0) {
    const first = rest[0]!;
    const assignment = /^([A-Za-z_][A-Za-z_\d]*)=(.*)$/.exec(first);

    if (assignment !== null) {
      env.set(assignment[1]!, assignment[2]!);
      rest.shift();
      continue;
    }

    if (["env", "command", "sudo"].includes(basename(first))) {
      rest.shift();
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

const flagTarget = (call: ReturnType<typeof invocation>, source: DataSource) => {
  const mysql = call.name === "mysql" || call.name === "mysqldump";

  const flags = nativeFlags(mysql);

  const values = new Map<string, string>();

  for (let i = 0; i < call.args.length; i++) {
    const arg = call.args[i]!;
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const field = flags.get(flag);

    if (field === undefined) continue;

    const value = equals === -1 ? call.args[++i] : arg.slice(equals + 1);

    if (value !== undefined) values.set(field, value);
  }

  return (
    source.engine === (mysql ? "mysql" : "postgres") &&
    values.get("host") === source.host &&
    values.get("database") === source.database &&
    values.get("user") === source.user &&
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

  return commands(command).some((group) => {
    const call = invocation(group);

    const oneLiner =
      ["bun", "node"].includes(call.name) &&
      call.args.some((arg) => arg === "-e" || arg === "--eval");

    if (!clients.has(call.name) && !oneLiner) return false;

    if (!oneLiner && flagTarget(call, source)) return true;

    const keys = key === undefined ? [] : [key];

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

      return keys.some(
        (name) =>
          (value === `$${name}` || value === `\${${name}}`) &&
          (!call.env.has(name) || target(call.env.get(name)!) === expected)
      );
    });
  });
};

export const recordOutsideCommand = Effect.fnUntraced(function* (
  event: Extract<DomainEvent, { _tag: "TurnItemCompleted" }>,
  sources: Pick<DataSources["Service"], "list" | "resolve">,
  queries: Pick<DataQueries["Service"], "recordOutside">
) {
  if (!Predicate.isTagged(event.item, "CommandExecution") || event.item.status === "declined")
    return;
  const command = event.item.command;

  if (!/\b(psql|mysql|pg_dump|mysqldump|bun|node)\b/.test(command)) return;

  for (const source of yield* sources.list({ sessionId: event.sessionId })) {
    const resolved = yield* sources.resolve({ sessionId: event.sessionId, source: source.name });

    if (!outsideMatches(command, source, resolved.matchUrl)) continue;
    yield* queries.recordOutside({
      sessionId: event.sessionId,
      turn: event.turnId,
      source: source.name,
      command,
      itemId: event.item.id,
    });
  }
});
