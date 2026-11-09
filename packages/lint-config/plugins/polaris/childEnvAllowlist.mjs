// `polaris/child-env`'s scope, builders and exceptions, repo-relative path prefixes.
// Each exception says where its child's environment comes from instead.
import { REPOSITORY_ENV } from "../security/allowlist.mjs";

/** Modules that start repository code: security/repository-env forbids childEnv there. */
const repositoryModules = Object.fromEntries(
  REPOSITORY_ENV.scope.map((path) => [path, "repository-env"])
);

export const CHILD_ENV = {
  scope: ["apps/daemon/src/"],
  // childEnv and builders over it, plus the allowlisted environments, none of which keep the handoff.
  builders: ["childEnv", "harnessEnv", ...REPOSITORY_ENV.builders],
  allow: {
    ...repositoryModules,
    // Developer scripts run by hand (`bun …/generate.ts`) to regenerate protocol types, never by a Daemon.
    "apps/daemon/src/harness/codex/generate.ts": "script",
    "apps/daemon/src/harness/opencode/generate.ts": "script",
    // Child programs the handoff slow tests start; they inherit the test's environment on purpose.
    "apps/daemon/src/service/fixtures/": "test-fixture",
  },
};
