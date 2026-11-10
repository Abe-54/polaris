/**
 * The app and window each `polaris_desktop` call acted on (`ToolCall.computerUse`). A session
 * remembers what its snapshots and listings saw, so a ref action names its snapshot's app.
 */
import { AppId, AppRef, AppWindow, ComputerUseCall, type TurnItem } from "@polaris/protocol";
import { Option, Schema } from "effect";
import type { Target } from "./catalog.ts";
import type { Envelope } from "./envelope.ts";

/** The server name in both Harnesses; not `desktop`, which a user's own server may take. */
export const DESKTOP_MCP_NAME = "polaris_desktop";

const ListedApp = Schema.Struct({
  name: Schema.String,
  bundle_id: Schema.optionalKey(Schema.String),
});

const ListedWindow = Schema.Struct({
  id: Schema.String,
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  app_name: Schema.optionalKey(Schema.String),
});

const Seen = Schema.Struct({
  app: Schema.optionalKey(Schema.String),
  snapshot_id: Schema.optionalKey(Schema.String),
  window: Schema.optionalKey(ListedWindow),
  apps: Schema.optionalKey(Schema.Array(ListedApp)),
});

const decodeSeen = Schema.decodeUnknownOption(Seen);

const decodeWindows = Schema.decodeUnknownOption(Schema.Array(ListedWindow));

/** `@s8f3k2p9:e5` → `s8f3k2p9`. */
export const snapshotOfRef = (ref: string): string | null =>
  /^@([^:]+):e\d+$/.exec(ref)?.[1] ?? null;

interface SnapshotSeen {
  readonly app: string | null;
  readonly windowId: string | null;
}

/** What one session's calls have seen; small, and gone with the session. */
export class Sightings {
  private readonly bundles = new Map<string, string>();
  private readonly titles = new Map<string, string | null>();
  private readonly windowApps = new Map<string, string>();
  private readonly snapshots = new Map<string, SnapshotSeen>();

  /** Learns apps, windows and snapshots from a successful call's envelope. */
  see(envelope: Envelope): void {
    if (!envelope.ok) return;

    for (const window of Option.getOrElse(decodeWindows(envelope.data), () => [])) {
      this.titles.set(window.id, window.title ?? null);

      if (window.app_name !== undefined) this.windowApps.set(window.id, window.app_name);
    }

    Option.map(decodeSeen(envelope.data), (seen) => {
      for (const app of seen.apps ?? [])
        if (app.bundle_id !== undefined) this.bundles.set(app.name, app.bundle_id);

      if (seen.window !== undefined) this.titles.set(seen.window.id, seen.window.title ?? null);

      if (seen.snapshot_id !== undefined)
        this.snapshots.set(seen.snapshot_id, {
          app: seen.app ?? null,
          windowId: seen.window?.id ?? null,
        });
    });
  }

  knowsBundleOf(name: string): boolean {
    return this.bundles.has(name);
  }

  /** The app and window a call acted on, as far as this session knows them. */
  callOf(target: Target, headed: boolean, envelope: Envelope | null): ComputerUseCall {
    const fromRef =
      target.ref === null ? undefined : this.snapshots.get(snapshotOfRef(target.ref) ?? "");

    const fromResult =
      envelope === null ? undefined : Option.getOrUndefined(decodeSeen(envelope.data));

    const windowId = target.windowId ?? fromRef?.windowId ?? fromResult?.window?.id ?? null;
    const ofWindow = windowId === null ? undefined : this.windowApps.get(windowId);
    const name = target.app ?? fromRef?.app ?? fromResult?.app ?? ofWindow ?? null;

    return new ComputerUseCall({
      app:
        name === null ? null : new AppRef({ id: AppId.make(this.bundles.get(name) ?? name), name }),
      window:
        windowId === null
          ? null
          : new AppWindow({ id: windowId, title: this.titles.get(windowId) ?? null }),
      headed,
    });
  }
}

const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const Blocks = Schema.Array(Schema.Unknown);

const decodeString = Schema.decodeUnknownOption(Schema.String);

const decodeArray = Schema.decodeUnknownOption(Blocks);

const decodeContent = Schema.decodeUnknownOption(Schema.Struct({ content: Blocks }));

const blocksOf = (output: HarnessOutput): ReadonlyArray<unknown> =>
  Option.getOrElse(
    Option.orElse(decodeArray(output), () => Option.map(decodeContent(output), (c) => c.content)),
    () => []
  );

const decodeText = Schema.decodeUnknownOption(Text);

/** A Tool Call's output as a Harness kept it: a string, content blocks, or `{ content }`. */
export type HarnessOutput = Extract<TurnItem, { readonly _tag: "ToolCall" }>["output"];

const textsOf = (output: HarnessOutput): ReadonlyArray<string> =>
  Option.getOrElse(
    Option.map(decodeString(output), (text) => [text]),
    () =>
      blocksOf(output).flatMap((block) =>
        Option.toArray(Option.map(decodeText(block), (t) => t.text))
      )
  );

const Carried = Schema.fromJsonString(Schema.Struct({ computer_use: ComputerUseCall }));

const decodeCarried = Schema.decodeUnknownOption(Carried);

/**
 * The `computer_use` a polaris_desktop result carries, read from the Harness's copy of the
 * result; null when it has none.
 */
export const computerUseCallOf = (output: HarnessOutput): ComputerUseCall | null => {
  for (const text of textsOf(output)) {
    const carried = decodeCarried(text);

    if (Option.isSome(carried)) return carried.value.computer_use;
  }

  return null;
};
