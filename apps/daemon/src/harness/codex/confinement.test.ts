import { describe, expect, test } from "bun:test";
import type { ReadConfinement } from "../confinement.ts";
import { REVIEWER_PROFILE, reviewerConfig } from "./confinement.ts";

const confinement: ReadConfinement = {
  root: "/srv/checkout",
  shellRoots: ["/usr/bin", "/usr/lib"],
  hidden: ["/srv/checkout/.git"],
  unwritable: [],
  shellEnv: {},
};

const filesystem = (executable: string | null) =>
  reviewerConfig(confinement, { config: {} }, {}, executable).permissions[REVIEWER_PROFILE]
    .filesystem;

// ENG-758: Codex's bubblewrap runs its own binary first; under home it was invisible and every command failed.
describe("the Reviewer's profile on Linux", () => {
  test("reads Codex's own binary, and only that file of home", () => {
    const binary = "/home/lucas/.codex/packages/standalone/releases/0.164.0/bin/codex";
    const paths = filesystem(binary);

    expect(paths).toHaveProperty([binary], "read");
    expect(Object.keys(paths).filter((path) => path.startsWith("/home"))).toEqual([binary]);
  });

  test("never reads a binary inside a hidden path", () => {
    expect(filesystem("/srv/checkout/.git/codex")).not.toHaveProperty(["/srv/checkout/.git/codex"]);
  });
});
