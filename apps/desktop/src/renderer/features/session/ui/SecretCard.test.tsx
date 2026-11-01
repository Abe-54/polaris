import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  type ApprovalDecision,
  ApprovalRequest,
  RequestId,
  SessionId,
  TurnId,
} from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import type { SecretOutcome } from "../model/secret.ts";
import { ConversationRow, type RowContext } from "./rows.tsx";

let fake: FakeBridge;

beforeEach(() => {
  fake = installFakeBridge();
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const SECRET = "tskey-auth-kQ2x7-9fzP";

const REASON = "To join the Pi to your tailnet. Make one under Settings → Keys.";

const request = new ApprovalRequest({
  id: RequestId.make("r1"),
  sessionId: SessionId.make("s1"),
  turnId: TurnId.make("t1"),
  kind: "secret",
  title: "Tailscale auth key",
  detail: REASON,
  options: [],
  placeholder: "tskey-auth-…",
  expiresAt: null,
  openedAt: "2026-10-30T09:00:00.000Z",
});

const none = () => {};

const decisions: Array<ApprovalDecision> = [];

const ctx: RowContext = {
  harness: "claude",
  celestial: "sun",
  state: "needs-you",
  liveTurnId: null,
  where: "local",
  onSetTurnOpen: none,
  onOpenDiff: none,
  onRespond: (_request, decision) => decisions.push(decision),
  onContinue: none,
  limit: null,
  onLoadOlder: none,
  onRetry: none,
  modelLabel: () => "",
  canSteer: false,
  outbox: { retry: none, edit: none },
  diff: { hostKey: "studio", cwd: "/repo", sessionId: SessionId.make("s1") },
  chrome: {},
  latestDoneTurnId: null,
  onCopyTurn: none,
  onForkTurn: null,
  onOpenSubagent: none,
};

const mount = (settled: SecretOutcome | null = null) => {
  decisions.length = 0;

  const row = { kind: "approval" as const, key: "approval:r1", request, settled, wrote: null };

  return within(
    render(
      <TooltipProvider>
        <ConversationRow row={row} ctx={ctx} />
      </TooltipProvider>
    ).container
  );
};

const field = (view: ReturnType<typeof mount>) => {
  const element = view.getByLabelText("Tailscale auth key");

  if (!(element instanceof HTMLInputElement)) throw new Error("not an input");

  return element;
};

/** happy-dom lacks `oninput`, so React watches the focused field's value on key events. */
const type = (input: HTMLInputElement, value: string) => {
  act(() => input.focus());
  fireEvent.change(input, { target: { value } });
  fireEvent.keyUp(input, { key: "a" });
};

test("a secret is never approved: its card offers Save securely and Decline only", () => {
  const view = mount();

  expect(view.queryByRole("button", { name: /approve|always|deny/i })).toBeNull();
  expect(view.getByRole("button", { name: /Save securely/ })).not.toBeNull();
  expect(view.getByText(REASON)).not.toBeNull();
});

test("the field is masked text, not a password field, and password managers skip it", () => {
  const input = field(mount());

  expect(input.type).toBe("text");
  expect(input.className).toContain("[-webkit-text-security:disc]");
  expect(input.getAttribute("autocomplete")).toBe("off");
  expect(input.getAttribute("data-1p-ignore")).not.toBeNull();
  expect(input.getAttribute("data-lpignore")).toBe("true");
  expect(input.placeholder).toBe("tskey-auth-…");
});

test("Enter sends the trimmed value once over secret.provide, then the field empties", async () => {
  const view = mount();

  type(field(view), `  ${SECRET}  `);
  await act(async () => fireEvent.submit(field(view)));

  expect(fake.methods()).toEqual(["secret.provide"]);
  expect(fake.sent("secret.provide")).toEqual([
    { hostKey: "studio", sessionId: request.sessionId, requestId: request.id, value: SECRET },
  ]);
  expect(field(view).value).toBe("");
  expect(document.body.innerHTML).not.toContain(SECRET);
  expect(decisions).toEqual([]);
});

test("a blank field can't be saved", async () => {
  const view = mount();

  type(field(view), "   ");
  await act(async () => fireEvent.submit(field(view)));

  expect(fake.calls).toEqual([]);
  expect(view.getByRole("button", { name: /Save securely/ }).hasAttribute("disabled")).toBe(true);
});

test.each([
  [
    "the Host's refusal reads as the Host wrote it",
    { code: "SecretRejected", message: "This request has ended, so the secret wasn't saved." },
    "This request has ended, so the secret wasn't saved.",
  ],
  [
    "a transport failure is generic and never quotes what was sent",
    { code: "Defect", message: `encode failed for ${SECRET}` },
    "Couldn't save the secret. Try again.",
  ],
])("%s", async (_name, error, shown) => {
  fake.refuse("secret.provide", error);
  const view = mount();

  type(field(view), SECRET);
  await act(async () => fireEvent.submit(field(view)));

  expect(view.getByRole("alert").textContent).toBe(shown);
  expect(document.body.innerHTML).not.toContain(SECRET);
});

test("Decline is the ordinary Deny", () => {
  const view = mount();

  fireEvent.click(view.getByRole("button", { name: "Decline" }));

  expect(decisions.map((d) => d._tag)).toEqual(["Deny"]);
  expect(fake.calls).toEqual([]);
});

test.each([
  ["provided", "Saved securely and kept private"],
  ["declined", "Declined"],
  ["ended", "Request ended"],
] as const)("a %s secret's card says so and takes no value", (outcome, text) => {
  const view = mount(outcome);

  expect(view.getByTestId("secret-request-settled").textContent).toContain(text);
  expect(view.queryByRole("textbox")).toBeNull();
  expect(view.queryByRole("button")).toBeNull();
});
