import { describe, expect, test } from "bun:test";
import { nativeProbe } from "../app/nativeProbe.testing.ts";
import { microphonePermissionCopy, NO_MICROPHONE, openMic, type MicDeps } from "./mic.ts";
import type { DictationCallbacks, Heard } from "./voice.ts";

test("microphone recovery gives the device's settings path", () => {
  expect(microphonePermissionCopy("android")).toContain("Settings → Apps → Polaris → Permissions");
  expect(microphonePermissionCopy("ios")).toBe(NO_MICROPHONE);
});

test("Android microphone denial offers app settings and does not start audio", () => {
  nativeProbe(`
let alert;
let opened = false;
rn.Alert = { alert: (...args) => { alert = args; } };
rn.Linking = { openSettings: async () => { opened = true; } };
const { openMic } = await import("./composer/mic.ts");
let state;
const mic = openMic({
  permitted: async () => false,
  startAudio: async () => { throw new Error("must not start"); },
  stopAudio: () => {}, dictate: () => { throw new Error("must not dictate"); },
  field: () => "", write: () => {}, changed: next => { state = next; },
});
mic.toggle();
await new Promise(resolve => setTimeout(resolve, 0));
assert.match(state.failure, /Settings → Apps → Polaris → Permissions/);
alert[2].find(button => button.text === "Open Settings").onPress();
assert.equal(opened, true);
`);
});

/** The mic over a fake permission prompt, audio stream and Host dictation, and a field to type in. */
const rig = (field = "") => {
  const permission = Promise.withResolvers<boolean>();
  const dictations: Array<{ callbacks: DictationCallbacks; cancelled: boolean }> = [];
  const box = { field, audio: 0 };

  const deps: MicDeps = {
    permitted: () => permission.promise,
    startAudio: async () => void box.audio++,
    stopAudio: () => void (box.audio = 0),
    dictate: (callbacks) => {
      const entry = { callbacks, cancelled: false };
      dictations.push(entry);

      return {
        push: () => undefined,
        finish: () => undefined,
        cancel: () => void (entry.cancelled = true),
      };
    },
    field: () => box.field,
    write: (text) => void (box.field = text),
    changed: () => undefined,
  };

  return { mic: openMic(deps), permission, dictations, box };
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const heard = (finalText: string, interimText = ""): Heard => ({ finalText, interimText });

describe("one dictation at a time", () => {
  test("taps before the microphone is allowed start one dictation, and releasing cancels it", async () => {
    const { mic, permission, dictations } = rig();

    mic.toggle();
    mic.toggle();
    mic.toggle();
    permission.resolve(true);
    await settled();
    expect(dictations.length).toBe(1);

    mic.release();
    expect(dictations.map((d) => d.cancelled)).toEqual([true]);
  });

  test("a dictation's late end doesn't stop the one started after it", async () => {
    const { mic, permission, dictations, box } = rig();

    permission.resolve(true);
    mic.toggle();
    await settled();
    mic.release();
    mic.toggle();
    await settled();
    dictations[0]?.callbacks.ended(null);
    dictations[0]?.callbacks.heard(heard("stale"));
    expect(box.audio).toBe(1);
    expect(box.field).toBe("");
    dictations[1]?.callbacks.heard(heard("fresh"));
    expect(box.field).toBe("fresh");
  });
});

describe("dictation and the field", () => {
  test("an edit while listening survives the next snapshot", async () => {
    const { mic, permission, dictations, box } = rig("typed prefix");

    permission.resolve(true);
    mic.toggle();
    await settled();
    const { heard: hear } = dictations[0]!.callbacks;
    hear(heard("spoken", "next"));
    expect(box.field).toBe("typed prefix spoken next");

    box.field = "handwritten correction";
    hear(heard("spoken next", "words"));
    expect(box.field).toBe("handwritten correction words");
  });

  test("a snapshot after Send takes the field writes nothing back", async () => {
    const { mic, permission, dictations, box } = rig("typed prefix");

    permission.resolve(true);
    mic.toggle();
    await settled();
    const { heard: hear } = dictations[0]!.callbacks;
    hear(heard("spoken", "next"));

    mic.release();
    box.field = "";
    hear(heard("spoken next final"));
    expect(box.field).toBe("");
  });
});
