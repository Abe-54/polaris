/**
 * A stand-in for expo-device-hub, run as a process by the hub tests: the same flags, state
 * file, token gate, device routes and input barrier. `FAKE_HUB_*` steer it (below).
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

/** `{ simulators: [{ id, name, version, booted }] }`, shared with the test's `listIos`. */
const devicesPath = process.env.FAKE_HUB_DEVICES ?? "";

/** One line per event: `start <pid>`, `boot <id>`, `shutdown <id>`, `barrier`, `term <pid>`. */
const logPath = process.env.FAKE_HUB_LOG ?? "";

/** While this file exists, input barriers are never answered. */
const wedgePath = process.env.FAKE_HUB_WEDGE ?? "";

const flag = (name: string) => process.argv[process.argv.indexOf(name) + 1] ?? "";

const port = Number(flag("--port"));

const token = crypto.randomUUID();

const statePath = join(process.env.EXPO_DEVICE_HUB_STATE_DIR ?? ".", `server-${port}.json`);

const Devices = Schema.fromJsonString(
  Schema.Struct({
    simulators: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        version: Schema.String,
        booted: Schema.Boolean,
      })
    ),
  })
);

const DeviceBody = Schema.fromJsonString(
  Schema.Struct({ id: Schema.optional(Schema.String), udid: Schema.optional(Schema.String) })
);

const Barrier = Schema.fromJsonString(Schema.Struct({ requestId: Schema.Number }));

const log = (line: string) => appendFileSync(logPath, `${line}\n`);

const readDevices = () => Schema.decodeUnknownSync(Devices)(readFileSync(devicesPath, "utf8"));

const setBooted = (id: string, booted: boolean) => {
  const simulators = readDevices().simulators.map((device) =>
    device.id === id ? { ...device, booted } : device
  );

  writeFileSync(devicesPath, JSON.stringify({ simulators }));
};

const authorized = (request: Request) => request.headers.get("authorization") === `Bearer ${token}`;

const frame = (tag: number, body: Readonly<Record<string, number | boolean>>) => {
  const json = new TextEncoder().encode(JSON.stringify(body));
  const out = new Uint8Array(json.length + 1);
  out[0] = tag;
  out.set(json, 1);

  return out;
};

const deviceRoute = async (request: Request, path: string) => {
  const body = Schema.decodeUnknownSync(DeviceBody)(await request.text());
  const id = body.id ?? body.udid ?? "";
  const booting = path === "/api/devices/boot";
  log(`${booting ? "boot" : "shutdown"} ${id}`);
  setBooted(id, booting);

  return Response.json({ ok: true });
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (request, srv) => {
    const path = new URL(request.url).pathname;

    if (path === "/healthz") return Response.json({ status: "ok" });

    if (!authorized(request)) return new Response("unauthorized", { status: 401 });

    if (path === "/vendor/serve-sim/helper/ws")
      return srv.upgrade(request, { data: undefined })
        ? undefined
        : new Response(null, { status: 400 });

    if (path === "/api/devices")
      return Response.json({ ...readDevices(), emulators: [], errors: [] });

    if (
      [
        "/api/devices/boot",
        "/vendor/serve-sim/grid/api/shutdown",
        "/api/devices/shutdown",
      ].includes(path)
    )
      return deviceRoute(request, path);

    return new Response("not found", { status: 404 });
  },
  websocket: {
    open: (socket) => {
      socket.send(new Uint8Array([0x83]));
      socket.send(frame(0x82, { inputUnavailable: false }));
    },
    message: (socket, message) => {
      if (!(message instanceof Uint8Array) || message[0] !== 0x11) return;
      log("barrier");

      if (existsSync(wedgePath)) return;

      const { requestId } = Schema.decodeUnknownSync(Barrier)(
        new TextDecoder().decode(message.subarray(1))
      );

      socket.send(frame(0x91, { requestId, ok: true }));
    },
  },
});

writeFileSync(
  statePath,
  JSON.stringify({ pid: process.pid, port: server.port, url: server.url.href, token })
);

log(`start ${process.pid}`);

process.on("SIGTERM", () => {
  log(`term ${process.pid}`);
  rmSync(statePath, { force: true });
  process.exit(0);
});
