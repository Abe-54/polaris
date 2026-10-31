/** RW's external-effect probes, with assertions and cleanup against opt-in disposable databases. */
import { expect, test } from "bun:test";
import { databaseUrl, writeFixture } from "./writeFixes.testing.ts";

test.skipIf(!databaseUrl("postgres"))(
  "postgres F1: user functions and triggers cannot run an unapproved dblink effect",
  async () => {
    const f = writeFixture("postgres");
    const { admin, name: t, write } = f;
    let installed = false;

    try {
      const existing = await admin<
        Array<{ present: boolean }>
      >`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='dblink') AS present`;

      if (!existing[0]!.present) {
        await admin`CREATE EXTENSION dblink`;
        installed = true;
      }

      await admin
        .unsafe(`CREATE TABLE ${t}(id int PRIMARY KEY,v int); CREATE TABLE ${t}_audit(note text)`)
        .simple();
      await admin.unsafe(`INSERT INTO ${t} VALUES(1,0)`);
      await admin.unsafe(
        `CREATE FUNCTION ${t}_wrap() RETURNS int LANGUAGE sql AS $$ SELECT 1 FROM dblink_exec('dbname=' || current_database(), 'INSERT INTO ${t}_audit VALUES (''wrapper'')') $$`
      );
      await Promise.resolve(
        expect(write(`UPDATE ${t} SET v=${t}_wrap()`)).rejects.toMatchObject({
          code: "E-DATA-READ-ONLY",
        })
      );
      await admin.unsafe(`ALTER TABLE ${t} ALTER COLUMN v SET DEFAULT ${t}_wrap()`);
      await Promise.resolve(
        expect(write(`INSERT INTO ${t}(id) VALUES(2)`)).rejects.toMatchObject({
          code: "E-DATA-SQL",
        })
      );
      await admin.unsafe(`ALTER TABLE ${t} ALTER COLUMN v DROP DEFAULT`);
      await admin.unsafe(
        `CREATE FUNCTION ${t}_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM dblink_exec('dbname=' || current_database(), 'INSERT INTO ${t}_audit VALUES (''trigger'')'); RETURN NEW; END $$`
      );
      await admin.unsafe(
        `CREATE TRIGGER ${t}_tr AFTER UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_trg()`
      );
      await admin.unsafe(
        `CREATE TRIGGER ${t}_truncate AFTER TRUNCATE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION ${t}_trg()`
      );
      expect(await write(`TRUNCATE ${t}`)).toMatchObject({
        previewed: false,
        note: "Not previewed: this statement changes the schema",
      });
      expect(await write(`UPDATE ${t} SET v=5`)).toMatchObject({
        previewed: false,
        before: [],
        after: [],
        note: "Not previewed: this table has triggers",
      });
      expect(
        Array.from(
          await admin.unsafe<Array<Record<string, string | number | null>>>(
            `SELECT * FROM ${t}_audit`
          )
        )
      ).toEqual([]);
      expect(Array.from(await admin.unsafe<Array<{ v: number }>>(`SELECT v FROM ${t}`))).toEqual([
        { v: 0 },
      ]);
    } finally {
      await admin.unsafe(`DROP TABLE IF EXISTS ${t},${t}_audit CASCADE`);
      await admin.unsafe(`DROP FUNCTION IF EXISTS ${t}_wrap(),${t}_trg()`);

      if (installed) await admin`DROP EXTENSION dblink`;
      await f.close();
    }
  },
  30000
);

test.skipIf(!databaseUrl("mysql"))(
  "mysql F1/F8: trigger and routine MyISAM escapes and other databases are refused",
  async () => {
    const f = writeFixture("mysql");
    const { admin, name: t, write } = f;

    try {
      await admin.unsafe(`CREATE TABLE ${t}(id int PRIMARY KEY,v int) ENGINE=InnoDB`);
      await admin.unsafe(`CREATE TABLE ${t}_audit(note varchar(20)) ENGINE=MyISAM`);
      await admin.unsafe(`INSERT INTO ${t} VALUES(1,0)`);
      await admin.unsafe(
        `CREATE TRIGGER ${t}_tr AFTER UPDATE ON ${t} FOR EACH ROW INSERT INTO ${t}_audit VALUES('trigger')`
      );
      await Promise.resolve(
        expect(write(`UPDATE ${t} SET v=5`)).rejects.toMatchObject({ code: "E-DATA-SQL" })
      );
      expect(
        Array.from(
          await admin.unsafe<Array<Record<string, string | number | null>>>(
            `SELECT * FROM ${t}_audit`
          )
        )
      ).toEqual([]);
      await admin.unsafe(`CREATE TABLE ${t}_middle(note varchar(20)) ENGINE=InnoDB`);
      await admin.unsafe(
        `CREATE TRIGGER ${t}_nested AFTER INSERT ON ${t}_middle FOR EACH ROW INSERT INTO ${t}_audit VALUES('nested')`
      );
      await admin.unsafe(`DROP TRIGGER ${t}_tr`);
      await admin.unsafe(
        `CREATE TRIGGER ${t}_tr AFTER UPDATE ON ${t} FOR EACH ROW INSERT INTO ${t}_middle VALUES('middle')`
      );
      await Promise.resolve(
        expect(write(`UPDATE ${t} SET v=6`)).rejects.toMatchObject({ code: "E-DATA-SQL" })
      );
      expect(
        Array.from(await admin.unsafe<Array<{ note: string }>>(`SELECT * FROM ${t}_audit`))
      ).toEqual([]);
      await admin.unsafe(`DROP TRIGGER ${t}_tr`);
      await admin.unsafe(
        `CREATE FUNCTION ${t}_f() RETURNS int MODIFIES SQL DATA NOT DETERMINISTIC BEGIN INSERT INTO ${t}_audit VALUES('function'); RETURN 1; END`
      );
      await Promise.resolve(
        expect(write(`UPDATE ${t} SET v=${t}_f()`)).rejects.toMatchObject({
          code: "E-DATA-READ-ONLY",
        })
      );
      expect(
        Array.from(
          await admin.unsafe<Array<Record<string, string | number | null>>>(
            `SELECT * FROM ${t}_audit`
          )
        )
      ).toEqual([]);
      await admin.unsafe(`ALTER TABLE ${t}_audit ENGINE=InnoDB`);
      await admin.unsafe(
        `CREATE TRIGGER ${t}_tr AFTER UPDATE ON ${t} FOR EACH ROW INSERT INTO ${t}_audit VALUES('trigger')`
      );
      expect(await write(`UPDATE ${t} SET v=5`)).toMatchObject({
        previewed: false,
        note: "Not previewed: this table has triggers",
      });
      expect(
        Array.from(
          await admin.unsafe<Array<Record<string, string | number | null>>>(
            `SELECT * FROM ${t}_audit`
          )
        )
      ).toEqual([]);
      await admin.unsafe(`CREATE DATABASE ${t}_db`);
      await admin.unsafe(`CREATE TABLE ${t}_db.t(id int PRIMARY KEY,v int) ENGINE=InnoDB`);
      await admin.unsafe(`INSERT INTO ${t}_db.t VALUES(1,0)`);
      await Promise.resolve(
        expect(write(`UPDATE ${t}_db.t SET v=5`)).rejects.toMatchObject({ code: "E-DATA-SQL" })
      );
      expect(
        Array.from(await admin.unsafe<Array<{ v: number }>>(`SELECT v FROM ${t}_db.t`))
      ).toEqual([{ v: 0 }]);
    } finally {
      await admin.unsafe(`DROP TABLE IF EXISTS ${t},${t}_audit,${t}_middle`);
      await admin.unsafe(`DROP FUNCTION IF EXISTS ${t}_f`);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${t}_db`);
      await f.close();
    }
  },
  30000
);

test.skipIf(!databaseUrl("postgres"))(
  "postgres F3: abort during COMMIT waits for confirmation; lost connection reports unknown",
  async () => {
    const f = writeFixture("postgres");
    const { admin, name: t, write } = f;

    try {
      await admin.unsafe(`CREATE TABLE ${t}(id int PRIMARY KEY,v int)`);
      await admin.unsafe(`INSERT INTO ${t} VALUES(1,0)`);
      await admin.unsafe(
        `CREATE FUNCTION ${t}_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$`
      );
      await admin.unsafe(
        `CREATE CONSTRAINT TRIGGER ${t}_tr AFTER UPDATE ON ${t} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${t}_trg()`
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 250);

      try {
        expect(
          (
            await write(`UPDATE ${t} SET v=42`, {
              dryRun: false,
              previewed: false,
              signal: controller.signal,
            })
          ).affected
        ).toBe(1);
      } finally {
        clearTimeout(timer);
      }

      expect(Array.from(await admin.unsafe<Array<{ v: number }>>(`SELECT v FROM ${t}`))).toEqual([
        { v: 42 },
      ]);
      await admin.unsafe(
        `CREATE OR REPLACE FUNCTION ${t}_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END $$`
      );
      await Promise.resolve(
        expect(
          write(`UPDATE ${t} SET v=43`, { dryRun: false, previewed: false })
        ).rejects.toMatchObject({ code: "E-DATA-OUTCOME-UNKNOWN" })
      );
    } finally {
      await admin.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
      await admin.unsafe(`DROP FUNCTION IF EXISTS ${t}_trg()`);
      await f.close();
    }
  },
  30000
);
