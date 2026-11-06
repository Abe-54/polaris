/**
 * A fake GitHub and Linear behind `fetch`, for `ciRed.ts --fake <fixture.json>` and its tests.
 * Reads answer from the fixture; every request is recorded.
 */
import { Schema } from "effect";
import { ContextData } from "./linear.ts";
import { Annotations, JobsPage } from "./github.ts";

export const Fixture = Schema.Struct({
  jobs: JobsPage,
  /** Each failed job's log, by job id. */
  logs: Schema.Record(Schema.String, Schema.String),
  /** Each cancelled job's annotations, by job id. */
  annotations: Schema.optional(Schema.Record(Schema.String, Annotations)),
  linear: ContextData,
});

export type Fixture = typeof Fixture.Type;

export const decodeFixture = Schema.decodeUnknownSync(Schema.fromJsonString(Fixture));

export interface Recorded {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const LOG = /\/actions\/jobs\/(\d+)\/logs$/;

const ANNOTATIONS = /\/check-runs\/(\d+)\/annotations/;

const answer = (fixture: Fixture, url: string, body: string): Response => {
  if (url.includes("/oauth/token")) return Response.json({ access_token: "fake-token" });

  if (url.includes("/graphql"))
    return body.includes("CiRedContext")
      ? Response.json({ data: fixture.linear })
      : Response.json({ data: { ok: { success: true } } });
  const job = LOG.exec(url)?.[1];

  if (job) return new Response(fixture.logs[job] ?? "", { status: 200 });

  const annotated = ANNOTATIONS.exec(url)?.[1];

  if (annotated) return Response.json(fixture.annotations?.[annotated] ?? []);

  if (url.includes("/rerun-failed-jobs")) return new Response(null, { status: 201 });

  if (url.includes("/jobs?")) return Response.json(fixture.jobs);

  return new Response("not faked", { status: 404 });
};

export const fakeFetch = (fixture: Fixture) => {
  const requests: Array<Recorded> = [];

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? await new Response(init.body).text() : "";

    requests.push({ url: input, headers: new Headers(init?.headers).toJSON(), body });

    return answer(fixture, input, body);
  };

  return { fetch, requests };
};
