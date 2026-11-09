/** The polaris-tracing skill as this Daemon was built with it (ENG-694): no network, no Git ref. */
import skill from "../../../../../skills/polaris-tracing/SKILL.md" with { type: "text" };
import bun from "../../../../../skills/polaris-tracing/references/bun.md" with { type: "text" };
import existingExporters from "../../../../../skills/polaris-tracing/references/existing-exporters.md" with { type: "text" };
import next from "../../../../../skills/polaris-tracing/references/next.md" with { type: "text" };
import node from "../../../../../skills/polaris-tracing/references/node.md" with { type: "text" };
import tracingHelper from "../../../../../skills/polaris-tracing/references/tracing-helper.md" with { type: "text" };

export const SKILL_NAME = "polaris-tracing";

/** Each file relative to the skill's folder. */
export const BUNDLED_SKILL: ReadonlyArray<readonly [path: string, contents: string]> = [
  ["SKILL.md", skill],
  ["references/bun.md", bun],
  ["references/existing-exporters.md", existingExporters],
  ["references/next.md", next],
  ["references/node.md", node],
  ["references/tracing-helper.md", tracingHelper],
];
