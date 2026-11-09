import { expect, test } from "bun:test";
import { HostUnreachable, InvalidPairing } from "@polaris/sdk";
import {
  describeFailure,
  failureMarkdown,
  permissionModeLabel,
  permissionModesOn,
  unavailableMarkdown,
} from "./copy.ts";

test("Plan is offered only on a Host whose Daemon has plan mode, and labelled as on the Desktop", () => {
  expect(permissionModesOn(["session.plan-mode"]).map((m) => m.mode)).toEqual([
    "plan",
    "supervised",
    "auto-edits",
    "auto",
    "full-access",
  ]);
  expect(permissionModesOn([]).map((m) => m.mode)).not.toContain("plan");
  expect(permissionModeLabel("plan")).toBe("Plan");
});

test("a failure before the feed opens cannot embed images, links or HTML", () => {
  const failure = describeFailure(
    new Error("![leak](https://evil.example) <img src=x>"),
    "connect"
  );

  const html = Bun.markdown.html(failureMarkdown(failure));

  expect(html).not.toMatch(/<(?:img|a)\b/);
  expect(html).toContain("Couldn't connect");
});

test.each([
  new Error("failed hello pol_ext_secret-token and polaris-pair:v1:encoded_secret"),
  new HostUnreachable({
    hostId: "mac",
    detail: "ws://localhost/?token=pol_ext_secret-token refused",
  }),
  new InvalidPairing({ reason: "invalid URL with pol_ext_secret-token" }),
])("connection and pairing error copy does not expose credentials: %s", (error) => {
  const copy = JSON.stringify(describeFailure(error, "connect", "Mac"));
  const markdown = unavailableMarkdown([{ hostName: "Mac", error }]);

  expect(copy).not.toContain("secret");
  expect(markdown).not.toContain("secret");
});
