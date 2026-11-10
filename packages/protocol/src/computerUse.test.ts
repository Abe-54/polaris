/** Computer use on the wire: what survives JSON, what older logs still decode as, and the caps. */
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { CapabilityList } from "./capabilities.ts";
import {
  AllowedApp,
  APP_ICON_MAX_BYTES,
  AppIcon,
  AppId,
  AppRef,
  AppWindow,
  ComputerUseCall,
  ComputerUseItem,
  ComputerUseSetup,
  ComputerUseState,
  ComputerUseStatus,
  ControlledApp,
  DesktopApp,
  OpenComputerUseSetup,
  PREVIEW_MAX_EDGE_PX,
  PREVIEW_MAX_FRAME_BYTES,
  previewEdge,
  PreviewFrame,
  PreviewItem,
  RemoveAllowedApp,
  WatchPreview,
} from "./computerUse.ts";
import { decideDeviceAccess } from "./deviceGrants.ts";
import { ApprovalRequest, TurnItem } from "./domain.ts";
import { DomainEvent } from "./events.ts";
import { Pairing } from "./extensions.ts";
import { decideAccess } from "./grants.ts";
import { BlobId, PairingId, RequestId, SessionId, TurnId } from "./ids.ts";
import { DaemonRpcs } from "./rpc.ts";

type Codec = Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never };

/** `value` as it comes back from JSON text on the wire. */
const overJson = <S extends Codec>(schema: S, value: S["Type"]): S["Type"] => {
  const codec = Schema.toCodecJson(schema);

  return Schema.decodeUnknownSync(Schema.fromJsonString(codec))(
    JSON.stringify(Schema.encodeSync(codec)(value))
  );
};

const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(DomainEvent))
);

/** A real 1×1 PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const at = "2026-11-09T12:00:00.000Z";

const figma = new DesktopApp({ id: AppId.make("com.figma.Desktop"), name: "Figma", icon: PNG });

const figmaRef = new AppRef({ id: figma.id, name: figma.name });

const session = SessionId.make("s1");

const request = (kind: "app" | "headed-input") =>
  new ApprovalRequest({
    id: RequestId.make(`r-${kind}`),
    sessionId: session,
    turnId: TurnId.make("t1"),
    kind,
    app: figma,
    title: "Use Figma",
    detail: null,
    options: [],
    openedAt: at,
  });

const frame = new PreviewFrame({
  blobId: BlobId.make("d1-frame"),
  bytes: 48_213,
  width: 1280,
  height: 800,
  capturedAt: at,
  app: figmaRef,
  window: new AppWindow({ id: "4312", title: "Untitled" }),
});

const status = (state: ComputerUseState) => new ComputerUseStatus({ state, checkedAt: at });

describe("computer use on the wire", () => {
  test.each(["app", "headed-input"] as const)(
    "a requested %s approval keeps its app, icon and session through an event",
    (kind) => {
      const event = DomainEvent.cases.ApprovalRequested.make({ request: request(kind) });
      const back = overJson(DomainEvent, event);

      expect(back).toEqual(event);
      expect(DomainEvent.guards.ApprovalRequested(back) && back.request.app).toEqual(figma);
    }
  );

  test("an approval logged before computer use decodes with no app", () => {
    const legacy =
      '{"_tag":"ApprovalRequested","request":{"id":"r","sessionId":"s","turnId":"t",' +
      '"kind":"command","title":"ls","detail":null,"options":[],"openedAt":"2026-01-01T00:00:00Z"}}';

    const event = decodeEvent(legacy);

    expect(DomainEvent.guards.ApprovalRequested(event) && "app" in event.request).toBe(false);
  });

  test("a Tool Call logged before computer use decodes with it null; a linked one survives", () => {
    const legacy =
      '{"_tag":"TurnItemCompleted","sessionId":"s","turnId":"t","item":{"_tag":"ToolCall",' +
      '"id":"c","name":"click","input":{},"output":null,"status":"completed"}}';

    expect(decodeEvent(legacy)).toMatchObject({ item: { computerUse: null } });

    const linked = TurnItem.cases.ToolCall.make({
      id: "c",
      name: "click",
      kind: "mcp",
      mcp: { server: "polaris_desktop", tool: "click" },
      computerUse: new ComputerUseCall({
        app: figmaRef,
        window: new AppWindow({ id: "4312", title: null }),
        headed: true,
      }),
      input: { ref: "@e4" },
      output: null,
      status: "running",
    });

    expect(overJson(TurnItem, linked)).toEqual(linked);
  });

  test("every status, with each reason for setup, survives the Host feed", () => {
    const states = [
      ComputerUseState.cases.NoDesktop.make({}),
      ComputerUseState.cases.Off.make({}),
      ComputerUseState.cases.Ready.make({}),
      ...[
        ComputerUseSetup.cases.MacPermissions.make({ accessibility: true, screenRecording: false }),
        ComputerUseSetup.cases.LinuxPackages.make({
          packages: ["at-spi2-core"],
          command: "sudo apt install at-spi2-core",
        }),
        ComputerUseSetup.cases.AccessibilityBus.make({}),
      ].map((setup) => ComputerUseState.cases.NeedsSetup.make({ setup })),
    ];

    const items = [
      ...states.map((state) => ComputerUseItem.cases.Status.make({ status: status(state) })),
      ComputerUseItem.cases.AllowedApps.make({
        apps: [new AllowedApp({ app: figma, allowedAt: at })],
      }),
      ComputerUseItem.cases.ControlledApps.make({
        apps: [new ControlledApp({ app: figmaRef, sessionId: session, since: at })],
      }),
    ];

    expect(items.map((item) => overJson(ComputerUseItem, item))).toEqual(items);
  });

  test("a macOS status off the wire reports each permission on its own", () => {
    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(ComputerUseStatus))(
      `{"state":{"_tag":"NeedsSetup","setup":{"_tag":"MacPermissions","accessibility":false,` +
        `"screenRecording":true}},"checkedAt":"${at}"}`
    );

    expect(decoded.state).toEqual(
      ComputerUseState.cases.NeedsSetup.make({
        setup: ComputerUseSetup.cases.MacPermissions.make({
          accessibility: false,
          screenRecording: true,
        }),
      })
    );
  });

  test("frames, idle items and the RPC payloads survive", () => {
    const items = [
      PreviewItem.cases.Frame.make({ frame }),
      PreviewItem.cases.Idle.make({ reason: "screen-locked" }),
    ];

    expect(items.map((item) => overJson(PreviewItem, item))).toEqual(items);

    const watch = { sessionId: session, maxEdgePx: 320, link: "remote" as const };
    const remove = { appId: figma.id };
    const open = { permission: "screen-recording" as const };

    expect(overJson(WatchPreview.payloadSchema, watch)).toEqual(watch);
    expect(overJson(RemoveAllowedApp.payloadSchema, remove)).toEqual(remove);
    expect(overJson(OpenComputerUseSetup.payloadSchema, open)).toEqual(open);
  });
});

describe("computer use caps", () => {
  const icon = Schema.decodeUnknownSync(AppIcon);

  test("an icon is a PNG within the byte cap", () => {
    expect(icon(PNG)).toBe(PNG);
    // A JPEG's first bytes.
    expect(() => icon("/9j/4AAQSkZJRgABAQAAAQABAAD/")).toThrow("Expected a PNG");
    expect(() => icon(`${PNG.slice(0, 40)}!`)).toThrow();

    // The PNG signature, then zeros up to `bytes`.
    const sized = (bytes: number) =>
      Buffer.concat([Buffer.from(PNG, "base64").subarray(0, 8), Buffer.alloc(bytes - 8)]).toString(
        "base64"
      );

    expect(() => icon(sized(APP_ICON_MAX_BYTES))).not.toThrow();
    expect(() => icon(sized(APP_ICON_MAX_BYTES + 1))).toThrow("The icon is too large");
  });

  test("an app id is never empty", () => {
    expect(() => Schema.decodeUnknownSync(DesktopApp)({ id: "", name: "", icon: null })).toThrow();
  });

  test("a frame above the size or byte cap is refused", () => {
    const decode = Schema.decodeUnknownSync(PreviewFrame);
    const wire = Schema.encodeSync(PreviewFrame)(frame);

    expect(decode(wire)).toEqual(frame);
    expect(() => decode({ ...wire, width: PREVIEW_MAX_EDGE_PX + 1 })).toThrow();
    expect(() => decode({ ...wire, bytes: PREVIEW_MAX_FRAME_BYTES + 1 })).toThrow();
  });

  test("the edge a Client asks for is clamped, and null asks for the largest", () => {
    expect([null, 40, 320, 320.4, 4000, Number.NaN].map(previewEdge)).toEqual([
      1280, 160, 320, 320, 1280, 1280,
    ]);
  });
});

describe("computer use access", () => {
  const rpcs = [...DaemonRpcs.requests.keys()].filter((tag) => tag.startsWith("computerUse."));

  test("the capabilities survive hello", () => {
    const names: ReadonlyArray<string> = ["computer-use", "computer-use.preview"];

    expect(Schema.decodeUnknownSync(CapabilityList)(names)).toEqual([
      "computer-use",
      "computer-use.preview",
    ]);
  });

  test("an Extension is refused every computer use RPC, whatever its Grant", () => {
    const pairing = new Pairing({
      id: PairingId.make("pair_1"),
      name: "Raycast",
      grant: ["read", "approve", "turn", "start", "voice"],
      createdAt: at,
      lastUsedAt: null,
      revokedAt: null,
    });

    expect(rpcs).toHaveLength(10);
    expect(rpcs.filter((rpc) => decideAccess(pairing, rpc, null) === null)).toEqual([]);
  });

  test("a Linked Device reads the status, an app and the latest screenshot, and changes nothing", () => {
    expect(rpcs.filter((rpc) => decideDeviceAccess(rpc, null) === null).sort()).toEqual([
      "computerUse.app",
      "computerUse.preview.latest",
      "computerUse.status",
      "computerUse.watch",
    ]);
  });
});
