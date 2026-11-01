/** `polaris data-sqlite`: one SQLite job from stdin, its reply on stdout; the Daemon kills it at its deadline. */
import { deserialize, serialize } from "node:v8";
import { Option, Schema } from "effect";
import { runJob, type SqliteJob } from "./jobs.ts";
import { ChildFailure } from "./protocol.ts";

const failure = Schema.decodeUnknownOption(ChildFailure);

const reply = (job: SqliteJob) => {
  try {
    return { ok: true, value: runJob(job) } as const;
  } catch (error) {
    // The guard's DataError carries a fix; SQLite errors carry SQLITE_* codes.
    const parsed = Option.getOrElse(failure(error), () => ({
      message: "The SQLite query failed.",
    }));

    return { ok: false, error: { ...parsed } } as const;
  }
};

export async function runSqliteChild(): Promise<number> {
  // SAFETY: the Daemon is the only writer of this pipe and sends a structured-clone SqliteJob.
  const job = deserialize(await Bun.stdin.bytes()) as SqliteJob;
  await Bun.write(Bun.stdout, serialize(reply(job)));

  return 0;
}
