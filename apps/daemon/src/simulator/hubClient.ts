/**
 * The Daemon's calls to a running hub (routes in docs/research/2026-11-09-simulator-hub-spike.md).
 * It never loads `/vendor/serve-sim/` itself, which spawns a helper that outlives the hub.
 */
import type { SimulatorPlatform } from "@polaris/protocol";
import { Option, Schema } from "effect";
import type { HubEndpoint } from "./hubProcess.ts";
import { HubDevices } from "./hubDevices.ts";

/** The hub boots through `simctl`, which waits for the boot to finish: 44 s in the D2 probe. */
const BOOT_TIMEOUT_MS = 240_000;

const SHUTDOWN_TIMEOUT_MS = 90_000;

const LIST_TIMEOUT_MS = 90_000;

const ADMIT_TIMEOUT_MS = 5_000;

const BARRIER_TIMEOUT_MS = 2_000;

export class HubRequestError extends Error {}

const HubResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.optional(Schema.String) }))),
});

const base = (endpoint: HubEndpoint) => `http://127.0.0.1:${endpoint.port}`;

/** A request body: the hub's routes take flat JSON objects of strings. */
type HubBody = Readonly<Record<string, string>>;

const requestOf = (endpoint: HubEndpoint, timeoutMs: number, body?: HubBody): RequestInit => {
  const authorization = `Bearer ${endpoint.token}`;
  const signal = AbortSignal.timeout(timeoutMs);

  if (body === undefined) return { method: "GET", headers: { authorization }, signal };

  return {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  };
};

/** The hub's answer to `path` decoded with `schema`; null when it isn't that shape. */
const call = async <A, I>(
  endpoint: HubEndpoint,
  path: string,
  timeoutMs: number,
  schema: Schema.Codec<A, I>,
  body?: HubBody
): Promise<A | null> => {
  const response = await fetch(
    `${base(endpoint)}${path}`,
    requestOf(endpoint, timeoutMs, body)
  ).catch((error) => {
    throw new HubRequestError(`the hub didn't answer ${path} (${String(error)})`);
  });

  const text = await response.text().catch(() => "");
  const decoded = Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text));

  if (!response.ok && decoded === null)
    throw new HubRequestError(`the hub answered ${path} with ${response.status}`);

  return decoded;
};

/** Only the hub's messages: its `error` fields are stack traces with the Host's paths. */
const failureOf = (result: typeof HubResult.Type) =>
  result.errors
    ?.map((error) => error.message)
    .filter((message) => message !== undefined)
    .join("; ") ||
  result.error ||
  "the hub refused";

const expectOk = (path: string, result: typeof HubResult.Type | null) => {
  if (result === null) throw new HubRequestError(`the hub's answer to ${path} wasn't understood`);

  if (!result.ok) throw new HubRequestError(failureOf(result));
};

export interface HubDevice {
  readonly platform: SimulatorPlatform;
  readonly id: string;
  readonly name: string;
}

/** The hub's device list; null when its `simctl` call failed and the list can't be trusted. */
export const listDevices = async (endpoint: HubEndpoint): Promise<HubDevices | null> => {
  const devices = await call(endpoint, "/api/devices", LIST_TIMEOUT_MS, HubDevices);

  if (devices === null) return null;

  const appleFailed = (devices.errors ?? []).some((error) =>
    JSON.stringify(error).includes("[apple-utils]")
  );

  return appleFailed ? null : devices;
};

/** Boots `device`; the hub answers once it is booted. */
export const bootDevice = async (endpoint: HubEndpoint, device: HubDevice) => {
  expectOk(
    "boot",
    await call(endpoint, "/api/devices/boot", BOOT_TIMEOUT_MS, HubResult, { ...device })
  );
};

/** An iOS Simulator through serve-sim, which closes its capture first: `simctl` hangs otherwise. */
export const shutdownDevice = async (endpoint: HubEndpoint, device: HubDevice) => {
  if (device.platform === "ios")
    expectOk(
      "shutdown",
      await call(endpoint, "/vendor/serve-sim/grid/api/shutdown", SHUTDOWN_TIMEOUT_MS, HubResult, {
        udid: device.id,
      })
    );
  else
    expectOk(
      "shutdown",
      await call(endpoint, "/api/devices/shutdown", SHUTDOWN_TIMEOUT_MS, HubResult, { ...device })
    );
};

const healthy = (endpoint: HubEndpoint) =>
  fetch(`${base(endpoint)}/healthz`, { signal: AbortSignal.timeout(ADMIT_TIMEOUT_MS) }).then(
    (response) => response.ok,
    () => false
  );

/** An input frame: `[tag][JSON]`. */
const frame = (tag: number, body: Readonly<Record<string, number>>) => {
  const json = new TextEncoder().encode(JSON.stringify(body));
  const out = new Uint8Array(json.length + 1);
  out[0] = tag;
  out.set(json, 1);

  return out;
};

const BarrierReply = Schema.fromJsonString(
  Schema.Struct({ requestId: Schema.Number, ok: Schema.Boolean })
);

const decodeBarrier = Schema.decodeUnknownOption(BarrierReply);

const ConfigFrame = Schema.fromJsonString(
  Schema.Struct({ inputUnavailable: Schema.optional(Schema.Boolean) })
);

const decodeConfig = Schema.decodeUnknownOption(ConfigFrame);

type Verdict = "live" | "wedged" | "unknown";

const verdictOf = (bytes: Uint8Array, inputUnavailable: boolean): Verdict | null => {
  if (bytes[0] !== 0x91) return null;
  const reply = Option.getOrNull(decodeBarrier(new TextDecoder().decode(bytes.subarray(1))));

  if (reply?.ok === true) return "live";

  return inputUnavailable ? "unknown" : "wedged";
};

/**
 * One input socket to `udid`: admitted (`0x83`), a no-op scroll, then a barrier (`0x11`) that
 * must come back (`0x91 ok`). A socket never admitted has no capture session: not a wedge.
 */
export const inputBarrier = (endpoint: HubEndpoint, udid: string): Promise<Verdict> =>
  new Promise((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${endpoint.port}/vendor/serve-sim/helper/ws?device=${encodeURIComponent(udid)}`,
      { headers: { authorization: `Bearer ${endpoint.token}` } }
    );

    socket.binaryType = "arraybuffer";
    let inputUnavailable = false;
    let timer = setTimeout(() => finish("unknown"), ADMIT_TIMEOUT_MS);

    const finish = (verdict: Verdict) => {
      clearTimeout(timer);
      socket.close();
      resolve(verdict);
    };

    socket.addEventListener("close", () => finish("unknown"));
    socket.addEventListener("error", () => finish("unknown"));
    socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);

      if (bytes[0] === 0x82)
        inputUnavailable =
          Option.getOrNull(decodeConfig(new TextDecoder().decode(bytes.subarray(1))))
            ?.inputUnavailable === true;

      if (bytes[0] === 0x83) {
        clearTimeout(timer);
        timer = setTimeout(() => finish("wedged"), BARRIER_TIMEOUT_MS);
        socket.send(frame(0x0b, { dx: 0, dy: 0 }));
        socket.send(frame(0x11, { requestId: 1 }));
      }

      const verdict = verdictOf(bytes, inputUnavailable);

      if (verdict !== null) finish(verdict);
    });
  });

/** False when the hub doesn't answer `/healthz` or any iOS Simulator's input is wedged. */
export const hubLive = async (
  endpoint: HubEndpoint,
  iosIds: ReadonlyArray<string>
): Promise<boolean> => {
  if (!(await healthy(endpoint))) return false;
  const verdicts = await Promise.all(iosIds.map((id) => inputBarrier(endpoint, id)));

  return !verdicts.includes("wedged");
};
