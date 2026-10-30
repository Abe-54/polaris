import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type GrantKind, PairingId } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import type { HostView, RequestOutput } from "../../../../shared/api.ts";
import type { VoiceSettingsView } from "../../../../shared/voiceContract.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { installFakeBridge, type FakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { VoicePage } from "./VoicePage.tsx";

let fake: FakeBridge;

beforeEach(() => {
  fake = installFakeBridge();
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const KEY = "0123456789abcdef0123456789abcdef01234567";

const host = (
  key: string,
  label: string,
  capabilities: ReadonlyArray<string> = ["voice"],
  state: HostView["status"]["state"] = "connected"
): HostView => {
  const base = hostView(key, state);

  return {
    ...base,
    label,
    // SAFETY: test Hosts announce only real capability names.
    status: { ...base.status, capabilities: capabilities as HostView["status"]["capabilities"] },
  };
};

const STUDIO = host("studio", "Mac Studio");

const settings = (keySet: boolean, store: VoiceSettingsView["store"]): VoiceSettingsView => ({
  provider: "deepgram",
  keySet,
  store,
});

/** happy-dom lacks `oninput`, so React watches the focused field's value on key events. */
const type = (field: HTMLInputElement, value: string) => {
  act(() => field.focus());
  fireEvent.change(field, { target: { value } });
  fireEvent.keyUp(field, { key: "a" });
};

const mount = async (hosts: ReadonlyArray<HostView> = [STUDIO]) => {
  const store = createStore<AppState>(() => ({ ...initialState, hosts: [...hosts] }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  render(
    <AppProvider
      value={{
        connection,
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TooltipProvider>
        <VoicePage />
      </TooltipProvider>
    </AppProvider>
  );

  await act(async () => undefined);
};

const row = (hostKey = "studio") => {
  const found = document.querySelector(`[data-testid="voice-host"][data-host="${hostKey}"]`);

  if (!(found instanceof HTMLElement)) throw new Error(`no row for ${hostKey}`);

  return within(found);
};

const caption = (hostKey = "studio") => row(hostKey).getByTestId("voice-key-state").textContent;

const field = (hostKey = "studio") => {
  const element = row(hostKey).getByLabelText("Deepgram key");

  if (!(element instanceof HTMLInputElement)) throw new Error("not an input");

  return element;
};

const card = (title: string) => {
  const found = screen.getAllByRole("heading").find((h) => h.textContent === title);
  const section = found?.closest("section");

  if (section == null) throw new Error(`no card ${title}`);

  return within(section);
};

test("saving a key sends it once, empties the field, and shows where the host keeps it", async () => {
  fake.answerOk("voice.settings", settings(false, "keychain"));
  fake.answerOk("voice.setKey", settings(true, "keychain"));
  await mount();

  type(field(), KEY);
  await act(async () => fireEvent.click(row().getByRole("button", { name: "Save" })));

  expect(fake.sent("voice.setKey")).toEqual([
    { hostKey: "studio", provider: "deepgram", key: KEY },
  ]);
  expect(caption()).toBe("Key set, kept in the macOS Keychain on Mac Studio");
  expect(row().queryByLabelText("Deepgram key")).toBeNull();
  expect(row().getByRole("button", { name: "Remove key" })).not.toBeNull();
});

test("a refused key shows the host's message inline and keeps the field to fix", async () => {
  fake.answerOk("voice.settings", settings(false, "file"));
  fake.refuse("voice.setKey", {
    code: "VoiceError",
    message: "That is not a Deepgram API key: it should be letters and digits only.",
  });
  await mount();

  type(field(), "not a key");
  await act(async () => fireEvent.submit(field()));

  expect(row().getByRole("alert").textContent).toBe(
    "That is not a Deepgram API key: it should be letters and digits only."
  );
  expect(field().getAttribute("aria-invalid")).toBe("true");
  expect(field().value).toBe("not a key");
  expect(caption()).toBe("No key yet; extensions can't use voice on Mac Studio");
});

test("Remove key asks first; only confirming sends null and brings back the paste field", async () => {
  fake.answerOk("voice.settings", settings(true, "file"));
  fake.answerOk("voice.setKey", settings(false, "file"));
  await mount();

  expect(caption()).toBe("Key set, kept in ~/.polaris/secrets on Mac Studio");
  await act(async () => fireEvent.click(row().getByRole("button", { name: "Remove key" })));

  expect(fake.sent("voice.setKey")).toEqual([]);
  expect(
    row().getByText(
      "Removing it stops voice on Mac Studio: extensions can't transcribe there until you paste a key again."
    )
  ).not.toBeNull();
  await act(async () =>
    fireEvent.click(row().getByRole("button", { name: "Remove the key on Mac Studio" }))
  );

  expect(fake.sent("voice.setKey")).toEqual([
    { hostKey: "studio", provider: "deepgram", key: null },
  ]);
  expect(caption()).toBe("No key yet; extensions can't use voice on Mac Studio");
  expect(row().queryByRole("button", { name: "Remove key" })).toBeNull();
  expect(field().placeholder).toBe("Paste an API key");
});

test("Replace opens a field for a new key, and Cancel closes it without sending", async () => {
  fake.answerOk("voice.settings", settings(true, "keychain"));
  await mount();

  expect(row().queryByLabelText("Deepgram key")).toBeNull();
  act(() => {
    fireEvent.click(row().getByRole("button", { name: "Replace" }));
  });

  expect(field().placeholder).toBe("Paste a new key to replace it");
  act(() => {
    fireEvent.click(row().getByRole("button", { name: "Cancel" }));
  });

  expect(row().queryByLabelText("Deepgram key")).toBeNull();
  expect(fake.sent("voice.setKey")).toEqual([]);
});

test("a blank field can't be saved", async () => {
  fake.answerOk("voice.settings", settings(false, "keychain"));
  await mount();

  type(field(), "   ");
  await act(async () => fireEvent.submit(field()));

  expect(fake.sent("voice.setKey")).toEqual([]);
});

test("an old or offline host says why, and only hosts that can answer are asked", async () => {
  fake.answerOk("voice.settings", settings(true, "keychain"));
  await mount([
    STUDIO,
    host("old", "Old box", []),
    host("pi", "Raspberry Pi 4", ["voice"], "offline"),
    host("box", "Old Mac", ["voice"], "needs-attention"),
  ]);

  expect(caption("old")).toBe("The daemon on Old box is too old for voice; upgrade it from Hosts");
  expect(caption("pi")).toBe("Raspberry Pi 4 is offline; its key shows once it's connected");
  expect(row("pi").getByText("Not connected")).not.toBeNull();
  expect(caption("box")).toBe(
    "Old Mac needs attention in Hosts; its key shows once it's connected"
  );
  expect(fake.sent("voice.settings")).toEqual([{ hostKey: "studio" }]);
  expect(card("Deepgram key").getByText("Set on 1 of 4 hosts")).not.toBeNull();
});

type Pairings = RequestOutput<"extensions.list">;

const pairing = (
  name: string,
  grant: ReadonlyArray<GrantKind>,
  revoked = false
): Pairings[number] => ({
  id: PairingId.make(`p-${name}`),
  name,
  grant,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: revoked ? "2026-10-02T00:00:00.000Z" : null,
});

test("extensions allowed voice lists live voice pairings, ready where their host has a key", async () => {
  fake.answer("voice.settings", ({ hostKey }) => ({
    ok: true,
    value: settings(hostKey === "studio", "keychain"),
  }));
  fake.answer("extensions.list", ({ hostKey }) => ({
    ok: true,
    value:
      hostKey === "studio"
        ? [pairing("Even G2", ["read", "voice"]), pairing("Raycast", ["read"])]
        : [pairing("Phone", ["voice"]), pairing("Old glasses", ["voice"], true)],
  }));
  await mount([
    host("studio", "Mac Studio", ["voice", "extensions"]),
    host("vm", "Linux VM", ["voice", "extensions"]),
  ]);

  const extensions = card("Extensions allowed voice");

  await waitFor(() => expect(extensions.getAllByTestId("voice-extension")).toHaveLength(2));
  const lines = extensions.getAllByTestId("voice-extension").map((r) => r.textContent);

  expect(lines).toEqual([
    "Even G2Paired with Mac Studio · not used yetReady",
    "PhonePaired with Linux VM · not used yetNo key on Linux VM",
  ]);
  expect(extensions.getByText("2 extensions · 1 host ready")).not.toBeNull();
});
