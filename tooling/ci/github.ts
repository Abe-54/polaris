/** The run's jobs and their logs, from GitHub's REST API (`actions: read`). */
import { Schema } from "effect";
import { type Check, failingTestsIn, NO_RUNNER } from "./plan.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const Job = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.NullOr(Schema.String),
  steps: Schema.optional(Schema.Array(Schema.Unknown)),
});

const Annotation = Schema.Struct({ annotation_level: Schema.String, message: Schema.String });

export const Annotations = Schema.Array(Annotation);

const decodeAnnotations = Schema.decodeUnknownSync(Annotations);

export const JobsPage = Schema.Struct({
  total_count: Schema.Number,
  jobs: Schema.Array(Job),
});

export type JobsPage = typeof JobsPage.Type;

const decodeJobs = Schema.decodeUnknownSync(JobsPage);

export interface GitHubRun {
  readonly api: string;
  readonly repository: string;
  readonly runId: string;
  readonly attempt: string;
  readonly token: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The current run, from GitHub Actions' env. */
export const gitHubRunOf = (env: Env): GitHubRun => ({
  api: env.GITHUB_API_URL ?? "https://api.github.com",
  repository: env.GITHUB_REPOSITORY ?? "",
  runId: env.GITHUB_RUN_ID ?? "",
  attempt: env.GITHUB_RUN_ATTEMPT ?? "1",
  token: env.GITHUB_TOKEN ?? "",
});

const PER_PAGE = 100;

/** GitHub's own failure statuses, which a job's log explains. */
const LOGGED = new Set(["failure", "timed_out"]);

export const headers = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

export const ok = async (response: Response, what: string): Promise<Response> => {
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${await response.text()}`);

  return response;
};

const jobsOf = async (run: GitHubRun, fetch: Fetch) => {
  const base = `${run.api}/repos/${run.repository}/actions/runs/${run.runId}/attempts/${run.attempt}/jobs`;
  const jobs: Array<typeof Job.Type> = [];

  for (let page = 1; ; page++) {
    const response = await fetch(`${base}?per_page=${PER_PAGE}&page=${page}`, {
      headers: headers(run.token),
    });

    const body = decodeJobs(await (await ok(response, "GitHub jobs")).json());

    jobs.push(...body.jobs);

    if (body.jobs.length < PER_PAGE || jobs.length >= body.total_count) return jobs;
  }
};

/** GitHub's own words for a job it cancelled because no runner picked it up. */
const NOT_ACQUIRED = "was not acquired by Runner";

/**
 * Only a job with no steps can be one: a step can print any annotation, and other jobs cancelled
 * before a step ran (a job timeout, a superseded run) say why in theirs. Unsure stays red.
 */
const concludedOf = async (run: GitHubRun, job: typeof Job.Type, fetch: Fetch): Promise<string> => {
  const conclusion = job.conclusion ?? "";

  if (conclusion !== "cancelled" || job.steps?.length !== 0) return conclusion;
  const url = `${run.api}/repos/${run.repository}/check-runs/${job.id}/annotations?per_page=${PER_PAGE}`;

  try {
    const response = await fetch(url, { headers: headers(run.token) });
    const annotations = decodeAnnotations(await (await ok(response, "annotations")).json());

    return annotations.some(
      (annotation) =>
        annotation.annotation_level === "failure" && annotation.message.includes(NOT_ACQUIRED)
    )
      ? NO_RUNNER
      : conclusion;
  } catch (error) {
    console.warn(`::warning::No annotations for ${job.name}, so it stays red: ${String(error)}`);

    return conclusion;
  }
};

/** The log redirects to storage that must not get GitHub's token, so the redirect is followed by hand. */
const logOf = async (run: GitHubRun, jobId: number, fetch: Fetch): Promise<string> => {
  const url = `${run.api}/repos/${run.repository}/actions/jobs/${jobId}/logs`;
  const first = await fetch(url, { headers: headers(run.token), redirect: "manual" });
  const location = first.headers.get("location");

  if (location) return (await ok(await fetch(location), `log of job ${jobId}`)).text();

  return (await ok(first, `log of job ${jobId}`)).text();
};

/**
 * The run's completed jobs, minus `ignore`; failed ones carry the tests their logs name, and a job
 * no runner acquired concludes `no_runner`.
 */
export const checksOf = async (
  run: GitHubRun,
  ignore: ReadonlySet<string>,
  fetch: Fetch
): Promise<ReadonlyArray<Check>> => {
  const jobs = (await jobsOf(run, fetch)).filter(
    (job) => job.status === "completed" && job.conclusion !== null && !ignore.has(job.name)
  );

  return Promise.all(
    jobs.map(async (job) => {
      const conclusion = await concludedOf(run, job, fetch);

      const log = LOGGED.has(conclusion)
        ? await logOf(run, job.id, fetch).catch((error: Error) => {
            console.warn(
              `::warning::No log for ${job.name}, so no failing tests named: ${error.message}`
            );

            return "";
          })
        : "";

      return {
        name: job.name,
        conclusion,
        url: job.html_url ?? "",
        failingTests: failingTestsIn(log),
      };
    })
  );
};
