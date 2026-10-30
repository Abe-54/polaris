import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { encodePairingString, HostId, Pairing, PairingId } from "@polaris/protocol";
import { installFakeBridge, type FakeBridge } from "../../../test/bridge.testing.ts";
import { HostPairings } from "./ExtensionsPage.tsx";

let fake: FakeBridge;

beforeEach(() => {
  fake = installFakeBridge();
});

afterEach(cleanup);

const raycast = new Pairing({
  id: PairingId.make("pair_raycast"),
  name: "Raycast",
  grant: ["read", "approve", "turn"],
  createdAt: "2026-10-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
});

const pairingString = (url: string | null, name = "Phone shortcuts") =>
  encodePairingString({
    hostId: HostId.make("h1"),
    hostName: "mac-studio",
    url,
    token: "pol_ext_token",
    name,
  });

const answerPair = (url: string | null) =>
  fake.answer("extensions.pair", ({ name, grant }) => ({
    ok: true,
    value: {
      pairing: new Pairing({
        id: PairingId.make("pair_new"),
        name,
        grant,
        createdAt: raycast.createdAt,
        lastUsedAt: null,
        revokedAt: null,
      }),
      token: "pol_ext_token",
      pairingString: pairingString(url, name),
    },
  }));

/** happy-dom lacks `oninput`, so React watches the focused field's value on key events. */
const type = (field: HTMLElement, value: string) => {
  act(() => field.focus());
  fireEvent.change(field, { target: { value } });
  fireEvent.keyUp(field, { key: "a" });
};

const page = () => within(render(<HostPairings hostKey="mac" label="Mac Studio" />).container);

test("pairing starts with read only, sends the chosen Grant, then shows the token once", async () => {
  fake.answerOk("extensions.list", []);
  answerPair(null);
  const view = page();

  fireEvent.click(await view.findByRole("button", { name: "Pair an extension" }));
  const pairButton = view.getByRole("button", { name: "Pair" });

  expect(pairButton).toHaveProperty("disabled", true);
  expect(view.getByLabelText("Read")).toHaveProperty("checked", true);
  expect(view.getByLabelText("Approve")).toHaveProperty("checked", false);
  expect(
    view.getByText(/Also needed to send turns to a session that approves on its own/)
  ).toBeTruthy();

  type(view.getByLabelText("Name"), "  Phone shortcuts ");
  fireEvent.click(view.getByLabelText("Send turns"));
  fireEvent.click(view.getByLabelText("Approve"));
  fireEvent.click(pairButton);

  const reveal = within(await view.findByTestId("pairing-reveal"));

  expect(fake.sent("extensions.pair")).toEqual([
    { hostKey: "mac", name: "Phone shortcuts", grant: ["read", "approve", "turn"] },
  ]);
  expect(reveal.getByTestId("pairing-string").textContent).toBe(pairingString(null));
  expect(reveal.getByRole("img", { name: "Pairing QR code" })).toBeTruthy();
  expect(reveal.getByText(/Remote access is off/).textContent).toContain("Mac Studio");

  fireEvent.click(reveal.getByRole("button", { name: "Done" }));
  expect(view.queryByTestId("pairing-reveal")).toBeNull();
});

test("the reveal names the Remote Access host when the pairing string carries a url", async () => {
  fake.answerOk("extensions.list", [raycast]);
  answerPair("wss://mac-studio.tail4e2a.ts.net/polaris/rpc");
  const view = page();

  fireEvent.click(await view.findByRole("button", { name: "Pair an extension" }));
  type(view.getByLabelText("Name"), "Glasses");
  fireEvent.click(view.getByRole("button", { name: "Pair" }));

  expect((await view.findByText(/through remote access/)).textContent).toBe(
    "Reaches Mac Studio at mac-studio.tail4e2a.ts.net through remote access"
  );
});

test("a Pairing lists with its Grant, and Revoke asks before revoking it", async () => {
  fake.answerOk("extensions.list", [raycast]);
  const view = page();
  const row = within(await view.findByTestId("pairing-row"));

  expect(row.getByText("Read · approve · send turns")).toBeTruthy();
  expect(row.getByText("not used yet")).toBeTruthy();
  // Neutral until it asks (SR-07); only the confirming button is danger.
  expect(row.getByRole("button", { name: "Revoke" }).dataset.variant).toBe("secondary");

  fireEvent.click(row.getByRole("button", { name: "Revoke" }));
  expect(fake.sent("extensions.revoke")).toEqual([]);
  expect(row.getByRole("button", { name: "Revoke Raycast" }).dataset.variant).toBe("danger");

  fireEvent.click(row.getByRole("button", { name: "Revoke Raycast" }));
  await waitFor(() =>
    expect(fake.sent("extensions.revoke")).toEqual([{ hostKey: "mac", id: raycast.id }])
  );
});

test("a successful pair reveals its token even when a later list would fail", async () => {
  fake.answerOk("extensions.list", []);
  answerPair(null);
  const view = page();
  fireEvent.click(await view.findByRole("button", { name: "Pair an extension" }));
  fake.refuse("extensions.list", { code: "Unavailable", message: "Host unavailable" });
  type(view.getByLabelText("Name"), "Phone shortcuts");
  fireEvent.click(view.getByRole("button", { name: "Pair" }));

  expect((await view.findByTestId("pairing-string")).textContent).toBe(pairingString(null));
  expect(view.getByTestId("pairing-row").textContent).toContain("Phone shortcuts");
});

test("revoking the revealed Pairing removes both its row and token without a list refresh", async () => {
  fake.answerOk("extensions.list", []);
  answerPair(null);
  const view = page();
  fireEvent.click(await view.findByRole("button", { name: "Pair an extension" }));
  type(view.getByLabelText("Name"), "Phone shortcuts");
  fireEvent.click(view.getByRole("button", { name: "Pair" }));
  await view.findByTestId("pairing-reveal");
  fake.refuse("extensions.list", { code: "Unavailable", message: "Host unavailable" });
  fake.answerOk(
    "extensions.revoke",
    new Pairing({
      id: PairingId.make("pair_new"),
      name: "Phone shortcuts",
      grant: ["read"],
      createdAt: raycast.createdAt,
      lastUsedAt: null,
      revokedAt: raycast.createdAt,
    })
  );
  const row = within(view.getByTestId("pairing-row"));
  fireEvent.click(row.getByRole("button", { name: "Revoke" }));
  fireEvent.click(row.getByRole("button", { name: "Revoke Phone shortcuts" }));

  await view.findByText("No extensions paired with Mac Studio");
  expect(view.queryByTestId("pairing-row")).toBeNull();
  expect(view.queryByTestId("pairing-reveal")).toBeNull();
});

test("a refused revoke keeps the Pairing and its one-time reveal available", async () => {
  fake.answerOk("extensions.list", []);
  answerPair(null);
  fake.refuse("extensions.revoke", { code: "Unavailable", message: "Host unavailable" });
  const view = page();
  fireEvent.click(await view.findByRole("button", { name: "Pair an extension" }));
  type(view.getByLabelText("Name"), "Phone shortcuts");
  fireEvent.click(view.getByRole("button", { name: "Pair" }));
  await view.findByTestId("pairing-reveal");
  const row = within(view.getByTestId("pairing-row"));
  fireEvent.click(row.getByRole("button", { name: "Revoke" }));
  fireEvent.click(row.getByRole("button", { name: "Revoke Phone shortcuts" }));

  await row.findByRole("button", { name: "Revoke" });
  expect(view.getByTestId("pairing-string").textContent).toBe(pairingString(null));
  expect(row.getByText("Phone shortcuts").textContent).toBe("Phone shortcuts");
});

test("a pairing string beyond QR capacity remains visible and copyable", async () => {
  fake.answerOk("extensions.list", []);
  answerPair(null);
  const view = page();
  fireEvent.click(await view.findByRole("button", { name: "Pair an extension" }));
  const name = "Phone shortcuts ".repeat(400);
  type(view.getByLabelText("Name"), name);
  fireEvent.click(view.getByRole("button", { name: "Pair" }));

  expect((await view.findByTestId("pairing-string")).textContent).toBe(
    pairingString(null, name.trim())
  );
  expect(view.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
  expect(
    view.getByText("Too long for a QR code. Copy the pairing string instead.").textContent
  ).toContain("Copy");
  expect(view.getByRole("button", { name: "Copy" })).toHaveProperty("disabled", false);
});
