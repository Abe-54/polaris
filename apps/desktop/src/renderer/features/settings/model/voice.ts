/**
 * Settings → Voice (ENG-404): what one Host's row says about its Deepgram key. The key itself
 * never reaches the Client; only whether it is set and where the Host keeps it.
 */
import type { HostView } from "../../../../shared/api.ts";
import type { VoiceSettingsView } from "../../../../shared/voiceContract.ts";

export const VOICE_CAPABILITY = "voice";

export const CLI_HINT = "polaris voice key set";

/** A Host's key as Settings last heard it. */
export type VoiceKeyState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly settings: VoiceSettingsView };

/** Why a Host shows one line instead of its key row, or null when the row can show. */
export const unavailableLine = (host: HostView): string | null => {
  if (host.status.state === "needs-attention")
    return `${host.label} needs attention in Hosts; its key shows once it's connected`;

  if (host.status.state !== "connected")
    return `${host.label} is ${host.status.state.replace("-", " ")}; its key shows once it's connected`;

  return host.status.capabilities.includes(VOICE_CAPABILITY)
    ? null
    : `The daemon on ${host.label} is too old for voice; upgrade it from Hosts`;
};

const STORE_NAMES: Readonly<Record<VoiceSettingsView["store"], string>> = {
  keychain: "the macOS Keychain",
  file: "~/.polaris/secrets",
};

/** The key row's caption: whether a key is set, and where the Host keeps it. */
export const keyCaption = (settings: VoiceSettingsView, hostLabel: string): string =>
  settings.keySet
    ? `Key set, kept in ${STORE_NAMES[settings.store]} on ${hostLabel}`
    : `No key yet; extensions can't use voice on ${hostLabel}`;

/** What Save sends: the pasted key, or null when there is nothing to save. */
export const keyToSave = (draft: string): string | null => (draft.trim() === "" ? null : draft);
