/**
 * Whether this Host has a desktop session computer use can reach, found by the Daemon itself
 * before asking agent-desktop, which answers the same with no desktop and with no AT-SPI.
 */
import { isAbsolute, join } from "node:path";
import { defined, type HostProbe } from "./probe.ts";

/**
 * A desktop session. On Linux `env` is what agent-desktop needs to reach it (the display,
 * the runtime directory, the session bus), from the Daemon's environment or the seat session.
 */
export type Desktop =
  | { readonly platform: "macos" }
  | { readonly platform: "windows" }
  | {
      readonly platform: "linux";
      readonly display: "wayland" | "x11";
      readonly env: Readonly<Record<string, string>>;
    };

/** `:0`, `:1.0` or `unix:0` is display 0 on this Host; `localhost:10.0` (SSH forwarding) isn't. */
export const localX11Display = (display: string | undefined): number | null => {
  const match = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display ?? "");

  return match === null ? null : Number(match[1]);
};

const runtimeDir = (probe: HostProbe) =>
  probe.env.XDG_RUNTIME_DIR ?? join(probe.paths.runtimeRoot, String(probe.uid ?? ""));

const liveX11 = async (probe: HostProbe, display: string | undefined) => {
  const number = localX11Display(display);

  return number !== null && (await probe.listening(join(probe.paths.x11, `X${number}`)));
};

const sessionBus = async (probe: HostProbe, runtime: string) => {
  if (probe.env.DBUS_SESSION_BUS_ADDRESS !== undefined)
    return { DBUS_SESSION_BUS_ADDRESS: probe.env.DBUS_SESSION_BUS_ADDRESS };
  const bus = join(runtime, "bus");

  return (await probe.exists(bus)) ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` } : {};
};

const linuxDesktop = async (
  probe: HostProbe,
  display: "wayland" | "x11",
  found: { readonly wayland?: string | undefined; readonly x11?: string | undefined }
): Promise<Desktop> => {
  const runtime = runtimeDir(probe);

  const env = defined({
    XDG_RUNTIME_DIR: runtime,
    WAYLAND_DISPLAY: found.wayland,
    DISPLAY: found.x11,
    ...(await sessionBus(probe, runtime)),
  });

  return { platform: "linux", display, env };
};

/** A live WAYLAND_DISPLAY or DISPLAY in the Daemon's own environment. */
const fromEnvironment = async (probe: HostProbe): Promise<Desktop | null> => {
  const wayland = probe.env.WAYLAND_DISPLAY;
  const x11 = (await liveX11(probe, probe.env.DISPLAY)) ? probe.env.DISPLAY : undefined;

  if (wayland !== undefined && wayland !== "") {
    const socket = isAbsolute(wayland) ? wayland : join(runtimeDir(probe), wayland);

    if (await probe.listening(socket)) return linuxDesktop(probe, "wayland", { wayland, x11 });
  }

  return x11 === undefined ? null : linuxDesktop(probe, "x11", { x11 });
};

type Fields = Readonly<Record<string, string>>;

/** `loginctl show-session a b -p …` prints one `Key=value` block per session. */
export const sessionBlocks = (text: string): ReadonlyArray<Fields> =>
  text
    .split(/\n\s*\n/)
    .map((block) =>
      Object.fromEntries(
        block
          .split("\n")
          .map((line) => /^(\w+)=(.*)$/.exec(line.trim()))
          .filter((match) => match !== null)
          .map((match) => [match[1] ?? "", match[2] ?? ""])
      )
    )
    .filter((fields) => Object.keys(fields).length > 0);

const GRAPHICAL = new Set(["wayland", "x11", "mir"]);

/** An active, local session on a seat that runs a display server. */
export const isGraphicalSeat = (session: Fields): boolean =>
  GRAPHICAL.has(session.Type ?? "") &&
  session.Active === "yes" &&
  session.Remote !== "yes" &&
  (session.Seat ?? "") !== "";

const liveWayland = async (probe: HostProbe) => {
  const runtime = runtimeDir(probe);

  const sockets = (await probe.list(runtime))
    .filter((name) => /^wayland-\d+$/.test(name))
    .toSorted();

  for (const name of sockets) if (await probe.listening(join(runtime, name))) return name;

  return undefined;
};

/** The user's graphical seat session from logind, for a service started without its display. */
const fromLogind = async (probe: HostProbe): Promise<Desktop | null> => {
  if (probe.uid === null || !probe.has("loginctl")) return null;

  const user = await probe.run(["loginctl", "show-user", String(probe.uid), "-p", "Sessions"]);
  const ids = (/^Sessions=(.*)$/m.exec(user.stdout)?.[1] ?? "").split(/\s+/).filter(Boolean);

  if (user.code !== 0 || ids.length === 0) return null;

  const fields = ["Type", "Active", "Remote", "Seat", "Display"].flatMap((p) => ["-p", p]);
  const shown = await probe.run(["loginctl", "show-session", ...ids, ...fields]);
  const session = sessionBlocks(shown.stdout).find(isGraphicalSeat);

  if (session === undefined) return null;

  const x11 = (await liveX11(probe, session.Display)) ? session.Display : undefined;

  return session.Type === "x11"
    ? linuxDesktop(probe, "x11", { x11 })
    : linuxDesktop(probe, "wayland", { wayland: await liveWayland(probe), x11 });
};

/** `tasklist /FO CSV /NH` rows: image, PID, session name, session number, memory. */
export const tasklistRows = (text: string): ReadonlyArray<ReadonlyArray<string>> =>
  text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('"'))
    .map((line) => [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? ""));

/** Windows: the Daemon runs in an interactive session (not session 0) with Explorer in it. */
const windowsDesktop = async (probe: HostProbe): Promise<Desktop | null> => {
  const csv = ["/FO", "CSV", "/NH"];
  const own = await probe.run(["tasklist", ...csv, "/FI", `PID eq ${probe.pid}`]);
  const session = tasklistRows(own.stdout)[0]?.[3];

  if (session === undefined || session === "0") return null;

  const filters = ["/FI", "IMAGENAME eq explorer.exe", "/FI", `SESSION eq ${session}`];
  const shell = await probe.run(["tasklist", ...csv, ...filters]);

  return tasklistRows(shell.stdout).some((row) => row[0]?.toLowerCase() === "explorer.exe")
    ? { platform: "windows" }
    : null;
};

/** The desktop computer use would act on, or null when this Host has none. */
export const detectDesktop = async (probe: HostProbe): Promise<Desktop | null> => {
  switch (probe.platform) {
    case "darwin":
      // The console belongs to whoever is logged in at the screen; root at the login window.
      return probe.uid !== null && (await probe.ownerUid(probe.paths.console)) === probe.uid
        ? { platform: "macos" }
        : null;
    case "linux":
      return (await fromEnvironment(probe)) ?? (await fromLogind(probe));
    case "win32":
      return windowsDesktop(probe);
    default:
      return null;
  }
};
