import { SQL } from "bun";
import { DataSource } from "@polaris/protocol";
import { Redacted } from "effect";
import { parseConnection } from "./connection.ts";
import type { ResolvedSource } from "./schemaCatalog.ts";

export async function disposable(
  engine: "postgres" | "mysql",
  url: string,
  work: (db: SQL, resolved: ResolvedSource) => Promise<void>
) {
  const name = `sdf_${crypto.randomUUID().replaceAll("-", "")}`;

  const admin = new SQL({
    url,
    max: 1,
    ...(engine === "mysql" ? { allowPublicKeyRetrieval: true } : undefined),
  });

  let db: SQL | undefined;
  let created = false;

  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    created = true;
    const target = new URL(url);
    target.pathname = `/${name}`;
    const safeUrl = Redacted.make(target.toString());
    const parsed = parseConnection({ name: "sdf", url: safeUrl, foundIn: { kind: "manual" } })!;
    db = new SQL({
      url: target.toString(),
      max: 1,
      ...(engine === "mysql" ? { allowPublicKeyRetrieval: true } : undefined),
    });

    const source = new DataSource({
      id: "sdf",
      name: "sdf",
      engine,
      host: parsed.connection.hostname,
      port: parsed.connection.port,
      database: name,
      user: parsed.connection.username,
      locality: "local",
      foundIn: { kind: "manual" },
      access: "read",
      writes: "ask",
      label: { text: "", colour: "none" },
    });

    await work(db, { source, connection: parsed.connection, matchUrl: safeUrl });
  } finally {
    await db?.close();

    if (created)
      await admin.unsafe(`DROP DATABASE ${name}${engine === "postgres" ? " WITH (FORCE)" : ""}`);
    await admin.close();
  }
}
