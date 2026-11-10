import { expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { detectDesktop } from "./desktop.ts";
import { fakeHost } from "./host.testing.ts";

/** `loginctl show-session` on lucas-rpi (labwc): an SSH session, then the seat's Wayland one. */
const RPI_SESSIONS = `Type=tty
Active=yes
Remote=yes
Seat=
Display=

Type=wayland
Active=yes
Remote=no
Seat=seat0
Display=`;

/** A headless VM reached over SSH: sessions, none on a seat. */
const HEADLESS_SESSIONS = `Type=tty
Active=yes
Remote=yes
Seat=
Display=

Type=unspecified
Active=yes
Remote=no
Seat=
Display=`;

const loginctl = (sessions: string) => [
  { when: "show-user", stdout: "Sessions=2 3\n" },
  { when: "show-session", stdout: `${sessions}\n` },
];

test("a live WAYLAND_DISPLAY in the Daemon's environment is a Wayland desktop it can reach", async () => {
  const host = fakeHost();
  const runtime = join(host.root, "run", "1000");
  await host.listen(join(runtime, "wayland-0"));
  host.file(join(runtime, "bus"));

  const desktop = await detectDesktop(
    host.probe({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" } })
  );

  // DISPLAY :0 has no live X socket here, so it isn't passed on.
  expect(desktop).toEqual({
    platform: "linux",
    display: "wayland",
    env: {
      XDG_RUNTIME_DIR: runtime,
      WAYLAND_DISPLAY: "wayland-0",
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtime, "bus")}`,
    },
  });
});

test("a WAYLAND_DISPLAY whose compositor is gone is no desktop", async () => {
  const host = fakeHost();
  host.file(join(host.root, "run", "1000", "wayland-0"));

  const probe = host.probe({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } });

  expect(await detectDesktop(probe)).toBeNull();
});

test.each([
  [":0", true],
  ["unix:0.0", true],
  ["localhost:10.0", false],
])("DISPLAY=%s with X0 listening is an X11 desktop: %s", async (display, found) => {
  const host = fakeHost();
  await host.listen(join(host.root, "x11", "X0"));

  const desktop = await detectDesktop(
    host.probe({ platform: "linux", env: { DISPLAY: display, XDG_RUNTIME_DIR: host.root } })
  );

  expect(desktop === null ? null : desktop.platform === "linux" && desktop.display).toBe(
    found ? "x11" : null
  );
});

test("a service started without its display finds the seat's Wayland session through logind", async () => {
  const host = fakeHost();
  const runtime = join(host.root, "run", "1000");
  host.file(join(runtime, "wayland-1"));
  await host.listen(join(runtime, "wayland-0"));
  host.command("loginctl", loginctl(RPI_SESSIONS));

  const desktop = await detectDesktop(host.probe({ platform: "linux" }));

  expect(desktop).toEqual({
    platform: "linux",
    display: "wayland",
    env: { XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: "wayland-0" },
  });

  expect(host.calls("loginctl")).toEqual([
    "show-user 1000 -p Sessions",
    "show-session 2 3 -p Type -p Active -p Remote -p Seat -p Display",
  ]);
});

test("a headless Host with only SSH sessions has no desktop", async () => {
  const host = fakeHost();
  host.command("loginctl", loginctl(HEADLESS_SESSIONS));

  expect(await detectDesktop(host.probe({ platform: "linux" }))).toBeNull();
});

/** An xrdp session: graphical and active, but remote and on no seat. */
const XRDP_SESSIONS = `Type=x11
Active=yes
Remote=yes
Seat=
Display=:10`;

test("a remote graphical session on no seat isn't this Host's desktop", async () => {
  const host = fakeHost();
  await host.listen(join(host.root, "x11", "X10"));
  host.command("loginctl", loginctl(XRDP_SESSIONS));

  expect(await detectDesktop(host.probe({ platform: "linux" }))).toBeNull();
});

test("a Linux Host without logind or a display has no desktop", async () => {
  expect(await detectDesktop(fakeHost().probe({ platform: "linux" }))).toBeNull();
});

test.each([
  ["the user logged in at the screen", 1000, true],
  ["someone else, or the login window", 0, false],
])("a Mac whose console belongs to %s has a desktop: %s", async (_, owner, found) => {
  const host = fakeHost();
  const console = host.file(join(host.root, "console"));
  const self = process.getuid?.() ?? 0;
  chmodSync(console, 0o600);

  const desktop = await detectDesktop(
    host.probe({ platform: "darwin", uid: owner === 1000 ? self : self + 1 })
  );

  expect(desktop).toEqual(found ? { platform: "macos" } : null);
});

/** `tasklist /FO CSV /NH` answering the Daemon's own PID in `session`, and Explorer's. */
const tasklist = (session: string, explorer: boolean) => [
  { when: "PID eq", stdout: `"polaris.exe","4242","Console","${session}","80,000 K"\r\n` },
  {
    when: "explorer",
    stdout: explorer
      ? `"explorer.exe","900","Console","${session}","90,000 K"\r\n`
      : "INFO: No tasks are running which match the specified criteria.\r\n",
  },
];

test.each([
  ["an interactive session with Explorer", "1", true, true],
  ["session 0, as a service", "0", true, false],
  ["an interactive session without Explorer", "2", false, false],
])("Windows: a Daemon in %s has a desktop: %s", async (_, session, explorer, found) => {
  const host = fakeHost();
  host.command("tasklist", tasklist(session, explorer));

  const desktop = await detectDesktop(host.probe({ platform: "win32" }));

  expect(desktop).toEqual(found ? { platform: "windows" } : null);
});
