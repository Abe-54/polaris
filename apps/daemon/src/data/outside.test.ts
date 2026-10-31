import { expect, test } from "bun:test";
import { DataError, DataSource, DomainEvent, SessionId, TurnId, TurnItem } from "@polaris/protocol";
import { Effect, Redacted } from "effect";
import { source, sourceFields } from "../mcp/tools/data.testing.ts";
import { outsideMatches, recordOutsideCommand } from "./outside.ts";
import type { OutsideInput } from "./approvalRequired.ts";

const url = Redacted.make("postgres://owner:private-password@localhost:5432/ledger");

for (const command of [
  'psql "postgresql://owner:changed-password@localhost/ledger" -c "select 1"',
  "pg_dump --dbname=postgres://owner:private-password@localhost:5432/ledger",
  'env psql "$DATABASE_URL"',
  "psql -h localhost -p 5432 -U owner -d ledger -c 'select 1'",
  "pg_dump --host=localhost --port=5432 --username=owner --dbname=ledger",
  'psql "${DATABASE_URL}"',
  'cd /repo && /opt/homebrew/bin/psql "$DATABASE_URL"',
  `bun -e 'const db = new Bun.SQL(process.env.DATABASE_URL); await db\`select 1\`'`,
  `node --eval 'connect(process.env["DATABASE_URL"])'`,
])
  test(`matches checkout source: ${command.replace(/\/\/[^@]+@/, "//[redacted]@")}`, () => {
    expect(outsideMatches(command, source, url)).toBe(true);
  });

for (const command of [
  'echo psql "$DATABASE_URL"',
  "cat file.sql",
  "psql '$DATABASE_URL'",
  "psql \\$DATABASE_URL",
  "psql postgres://owner:pw@localhost:5432/other",
  "psql postgres://other:pw@localhost:5432/ledger",
  "psql postgres://owner:pw@other-host:5432/ledger",
  "psql postgres://owner:pw@localhost:5433/ledger",
  'DATABASE_URL=postgres://owner:pw@localhost:5432/other psql "$DATABASE_URL"',
  `DATABASE_URL=postgres://owner:pw@localhost:5432/other node -e 'connect(process.env.DATABASE_URL)'`,
  `node script.js DATABASE_URL`,
  `bun -e 'console.log("DATABASE_URL")'`,
])
  test(`ignores unrelated target or executable: ${command.replace(/\/\/[^@]+@/, "//[redacted]@")}`, () => {
    expect(outsideMatches(command, source, url)).toBe(false);
  });

for (const name of ["mysql", "mysqldump"])
  test(`${name} matches MySQL source and rejects Postgres`, () => {
    const mysql = new DataSource({ ...sourceFields, engine: "mysql", port: 3306 });
    const target = Redacted.make("mysql://owner:pw@localhost/ledger");
    expect(outsideMatches(`${name} -h localhost -P 3306 -u owner -D ledger`, mysql, target)).toBe(
      true
    );
    expect(outsideMatches(`${name} mysql://owner:pw@localhost:3306/ledger`, mysql, target)).toBe(
      true
    );
    expect(outsideMatches(`${name} postgres://owner:pw@localhost:5432/ledger`, mysql, target)).toBe(
      false
    );
  });

test("completed command records authenticated session, Turn, source and id without executing anything", async () => {
  const recorded: OutsideInput[] = [];
  const sessionId = SessionId.make("s1");
  const turn = TurnId.make("t1");

  const event = DomainEvent.cases.TurnItemCompleted.make({
    sessionId,
    turnId: turn,
    item: TurnItem.cases.CommandExecution.make({
      id: "item-1",
      startedAt: null,
      command: 'psql "$DATABASE_URL"',
      cwd: "/checkout",
      output: "",
      exitCode: 1,
      status: "failed",
    }),
    subagentId: null,
  });

  await Effect.runPromise(
    recordOutsideCommand(
      event,
      {
        list: () =>
          Effect.succeed([
            new DataSource({ ...sourceFields, id: "broken", name: "broken" }),
            source,
          ]),
        resolve: (input) =>
          input.source === "broken"
            ? Effect.fail(
                new DataError({
                  code: "E-DATA-UNKNOWN-SOURCE",
                  message: "missing",
                  fix: "data_sources",
                })
              )
            : Effect.succeed({
                source,
                matchUrl: url,
                connection: {
                  hostname: "localhost",
                  port: 5432,
                  database: "db",
                  username: "user",
                  password: Redacted.make("private"),
                  tls: false,
                },
              }),
      },
      {
        recordOutside: (input) =>
          Effect.sync(() => {
            recorded.push(input);
          }),
      }
    )
  );
  expect(recorded).toEqual([
    { sessionId, turn, source: "app", command: 'psql "$DATABASE_URL"', itemId: "item-1" },
  ]);
});

test("declined commands never discover or record a database call", async () => {
  const event = DomainEvent.cases.TurnItemCompleted.make({
    sessionId: SessionId.make("s1"),
    turnId: TurnId.make("t1"),
    item: TurnItem.cases.CommandExecution.make({
      id: "item-1",
      startedAt: null,
      command: 'psql "$DATABASE_URL"',
      cwd: "/checkout",
      output: "",
      exitCode: null,
      status: "declined",
    }),
    subagentId: null,
  });

  await Effect.runPromise(
    recordOutsideCommand(
      event,
      {
        list: () => {
          throw new Error("must not discover");
        },
        resolve: () =>
          Effect.fail(
            new DataError({
              code: "E-DATA-UNKNOWN-SOURCE",
              message: "missing",
              fix: "data_sources",
            })
          ),
      },
      {
        recordOutside: () => {
          throw new Error("must not record");
        },
      }
    )
  );
});

for (const command of [
  `bash -lc 'psql "$DATABASE_URL"'`,
  `/bin/zsh -lc 'psql "$DATABASE_URL"'`,
  `sh -c 'pg_dump "$DATABASE_URL"'`,
  "docker exec -it pg psql -U owner ledger",
  "docker compose exec db psql -U owner ledger",
  "sudo -u postgres psql -U owner ledger",
  "env PGPASSWORD=private psql -h 127.0.0.1 -U owner ledger",
  "PGHOST=127.0.0.1 PGUSER=owner PGDATABASE=ledger psql",
  "psql -h localhost -d ledger",
  `npx prisma db execute --url "$DATABASE_URL"`,
  "pgcli $DATABASE_URL",
  `bun -e 'await Bun.sql\`select 1\`'`,
])
  test(`RM F5: unwraps and attributes ${command}`, () => {
    expect(outsideMatches(command, source, url)).toBe(true);
  });

test("RM F5: reading DATABASE_URL in a log is not a database query", () => {
  expect(outsideMatches(`node -e 'console.log(process.env.DATABASE_URL)'`, source, url)).toBe(
    false
  );
});

test("RM F5: MySQL env variables, positional dbname and loopback aliases match", () => {
  const mysql = new DataSource({ ...sourceFields, engine: "mysql", port: 3306 });
  const target = Redacted.make("mysql://owner:pw@localhost/ledger");
  expect(
    outsideMatches(
      "MYSQL_HOST=127.0.0.1 MYSQL_USER=owner MYSQL_DATABASE=ledger mysql",
      mysql,
      target
    )
  ).toBe(true);
  expect(outsideMatches("mysql --defaults-file=.my.cnf ledger", mysql, target)).toBe(true);
});
