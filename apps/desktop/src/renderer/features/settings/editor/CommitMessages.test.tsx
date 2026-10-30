import "../../../test/dom.testing.ts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { CommitMessagesCard } from "./CommitMessages.tsx";

afterEach(cleanup);

const preview = (lastCommit: Parameters<typeof CommitMessagesCard>[0]["lastCommit"]) =>
  render(<CommitMessagesCard lastCommit={lastCommit} chooser={null} />).getByTestId(
    "commit-preview"
  ).textContent;

test("with no commit to read, the preview shows the example draft", () => {
  const text = preview(null);

  expect(text).toContain("A draft looks like");
  expect(text).toContain("fix(daemon): a cancel reaches queued requests");
});

test("the workspace's last commit replaces the example", () => {
  const text = preview({ subject: "feat(ui): the Settings kit", body: "Cards and wells." });

  expect(text).toContain("Like your last commit");
  expect(text).toContain("feat(ui): the Settings kit");
  expect(text).toContain("Cards and wells.");
  expect(text).not.toContain("a cancel reaches queued requests");
});
