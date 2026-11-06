import { expect, test } from "bun:test";
import { ConstellationFinding, ConstellationRejected, GitError } from "@polaris/protocol";
import { constellationError } from "./constellation.ts";

test("a refusal's findings become one line each, '<message>. <fix>', and travel by code", () => {
  const error = new ConstellationRejected({
    findings: [
      new ConstellationFinding({
        code: "E-REVISION",
        message: "B1 changed since you looked.",
        fix: "Review it again at revision 4",
      }),
      new ConstellationFinding({ code: "E-SETTLED", message: "A2 is settled", fix: "Leave it" }),
    ],
    graph: null,
    revision: 4,
  });

  expect(constellationError(error)).toEqual({
    code: "ConstellationRejected",
    message: "B1 changed since you looked. Review it again at revision 4\nA2 is settled. Leave it",
    findings: [
      {
        code: "E-REVISION",
        message: "B1 changed since you looked.",
        fix: "Review it again at revision 4",
      },
      { code: "E-SETTLED", message: "A2 is settled", fix: "Leave it" },
    ],
  });
  expect(constellationError(new GitError({ cwd: "/x", message: "gone" }))).toEqual({
    code: "GitError",
    message: "gone",
  });
});
