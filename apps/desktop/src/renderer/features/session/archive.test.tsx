import "../../test/dom.testing.ts";
import { SessionId } from "@polaris/protocol";
import { Toaster } from "@polaris/ui";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FakeBridge, installFakeBridge } from "../../test/bridge.testing.ts";
import { standInBridge } from "../bridge.ts";
import { archiveSession } from "./archive.ts";

const page = () => within(document.body);

const sessionId = SessionId.make("s1");

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
  render(<Toaster />);
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const commands = () => bridge.sent("dispatch").map((d) => d.command._tag);

test("an Archive that lands offers Undo, which unarchives the same session", async () => {
  await act(() => archiveSession("local", sessionId, "Fix the feed"));

  expect(await page().findByText("Archived Fix the feed")).toBeTruthy();
  fireEvent.click(page().getByRole("button", { name: "Undo" }));

  await act(async () => {});
  expect(commands()).toEqual(["ArchiveSession", "UnarchiveSession"]);
  expect(bridge.sent("dispatch").at(-1)?.command).toMatchObject({ sessionId });
});

test("a refused Archive says why and offers no Undo", async () => {
  bridge.refuse("dispatch", {
    code: "CommandRejected",
    message: "CommandRejected: interrupt the Turn in flight before archiving",
  });

  await act(() => archiveSession("local", sessionId, "Fix the feed"));

  expect(await page().findByText("Couldn't archive")).toBeTruthy();
  expect(page().queryByRole("button", { name: "Undo" })).toBeNull();
});
