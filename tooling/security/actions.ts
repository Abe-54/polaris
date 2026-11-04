/**
 * Every external GitHub Action a workflow or composite action uses, and whether it is pinned:
 * a tag can be moved to other code, a full commit SHA can't (finding csf_5f27bdde…).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Schema } from "effect";

const Step = Schema.Struct({ uses: Schema.optional(Schema.String) });

const Steps = Schema.optional(Schema.Array(Step));

/** A workflow (`jobs`) or a composite action (`runs`); other keys are ignored. */
const Definition = Schema.Struct({
  jobs: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ uses: Schema.optional(Schema.String), steps: Steps })
    )
  ),
  runs: Schema.optional(Schema.Struct({ steps: Steps })),
});

const decodeDefinition = Schema.decodeUnknownSync(Definition);

/** `owner/repo[/path]@<40 hex>`, a local `./` action, or a Docker image by digest. */
const PINNED = [
  /^[\w.-]+\/[\w.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/,
  /^\.\//,
  /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/,
];

export const isPinned = (uses: string): boolean => PINNED.some((pattern) => pattern.test(uses));

/** Every `uses:` in one YAML file's text. */
export const usesIn = (yaml: string): ReadonlyArray<string> => {
  const definition = decodeDefinition(Bun.YAML.parse(yaml));
  const jobs = Object.values(definition.jobs ?? {});

  return [
    ...jobs.flatMap((job) => (job.uses === undefined ? [] : [job.uses])),
    ...[...jobs.flatMap((job) => job.steps ?? []), ...(definition.runs?.steps ?? [])].flatMap(
      (step) => (step.uses === undefined ? [] : [step.uses])
    ),
  ];
};

const YAML = /\.ya?ml$/;

const yamlFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return yamlFiles(path);

    return YAML.test(entry.name) ? [path] : [];
  });

/** `file: uses` for every unpinned action under `.github/`, relative to `root`. */
export const unpinnedActions = (root: string): ReadonlyArray<string> =>
  yamlFiles(join(root, ".github")).flatMap((file) =>
    usesIn(readFileSync(file, "utf8")).flatMap((uses) =>
      isPinned(uses) ? [] : [`${relative(root, file).replaceAll("\\", "/")}: ${uses}`]
    )
  );
