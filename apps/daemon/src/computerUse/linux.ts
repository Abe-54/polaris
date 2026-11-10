/**
 * Linux setup: at-spi2-core installed (its D-Bus service file), then the accessibility bus
 * answering on the desktop's session bus with its registry, which is what agent-desktop reads.
 */
import { ComputerUseSetup } from "@polaris/protocol";
import type { Desktop } from "./desktop.ts";
import type { Env, HostProbe } from "./probe.ts";

export const A11Y_PACKAGE = "at-spi2-core";

/** Each package manager Polaris knows, first found wins, with how it installs a package. */
const INSTALLERS: ReadonlyArray<readonly [string, (name: string) => string]> = [
  ["apt-get", (name) => `sudo apt-get install -y ${name}`],
  ["dnf", (name) => `sudo dnf install -y ${name}`],
  ["zypper", (name) => `sudo zypper install -y ${name}`],
  ["pacman", (name) => `sudo pacman -S --needed ${name}`],
  ["apk", (name) => `sudo apk add ${name}`],
];

export const installCommand = (probe: HostProbe, name: string): string | null => {
  const installer = INSTALLERS.find(([command]) => probe.has(command));

  return installer === undefined ? null : installer[1](name);
};

interface BusTool {
  readonly command: string;
  readonly getAddress: ReadonlyArray<string>;
  /** Parses the bus address out of the reply. */
  readonly address: RegExp;
  readonly ping: (address: string) => ReadonlyArray<string>;
}

const REGISTRY = "org.a11y.atspi.Registry";

const REGISTRY_ROOT = "/org/a11y/atspi/accessible/root";

const BUS_TOOLS: ReadonlyArray<BusTool> = [
  {
    command: "busctl",
    getAddress: ["--user", "call", "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress"],
    address: /^s "(.+)"\s*$/m,
    ping: (address) => [
      `--address=${address}`,
      "call",
      REGISTRY,
      REGISTRY_ROOT,
      "org.freedesktop.DBus.Peer",
      "Ping",
    ],
  },
  {
    command: "dbus-send",
    getAddress: [
      "--session",
      "--print-reply",
      "--dest=org.a11y.Bus",
      "/org/a11y/bus",
      "org.a11y.Bus.GetAddress",
    ],
    address: /string "(.+)"/,
    ping: (address) => [
      `--bus=${address}`,
      "--print-reply",
      `--dest=${REGISTRY}`,
      REGISTRY_ROOT,
      "org.freedesktop.DBus.Peer.Ping",
    ],
  },
];

/** Whether the accessibility bus runs and its registry answers; null when no tool can tell. */
const busAnswers = async (probe: HostProbe, env: Env): Promise<boolean | null> => {
  const tool = BUS_TOOLS.find((candidate) => probe.has(candidate.command));

  if (tool === undefined) return null;

  const reply = await probe.run([tool.command, ...tool.getAddress], env);
  const address = tool.address.exec(reply.stdout)?.[1];

  if (reply.code !== 0 || address === undefined) return false;

  return (await probe.run([tool.command, ...tool.ping(address)], env)).code === 0;
};

/** What a Linux desktop still needs before agent-desktop can read its apps, or null. */
export const linuxSetup = async (
  probe: HostProbe,
  desktop: Extract<Desktop, { platform: "linux" }>
): Promise<ComputerUseSetup | null> => {
  const installed = await Promise.all(probe.paths.a11yServices.map(probe.exists));

  if (!installed.includes(true))
    return ComputerUseSetup.cases.LinuxPackages.make({
      packages: [A11Y_PACKAGE],
      command: installCommand(probe, A11Y_PACKAGE),
    });

  return (await busAnswers(probe, desktop.env)) === false
    ? ComputerUseSetup.cases.AccessibilityBus.make({})
    : null;
};
