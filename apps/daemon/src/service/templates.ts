/**
 * User-service definitions for the Daemon, as pure functions of their inputs.
 * The service always runs `~/.polaris/bin/current/polaris serve`, so an
 * upgrade only repoints the `current` symlink. On macOS that `polaris` links
 * into the version's app bundle (`bundle.ts`), which names the process.
 */
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from "@polaris/protocol/endpoint";
import { DESKTOP_BUNDLE_ID } from "./bundle.ts";

export { LAUNCHD_LABEL, SYSTEMD_UNIT };

export interface ServiceSpec {
  /** Absolute path of the stable launcher, `~/.polaris/bin/current/polaris`. */
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  /** `POLARIS_HOME`, passed through so a non-default home keeps working. */
  readonly home: string;
  readonly logDir: string;
  /** Extra environment for the Daemon (e.g. PATH so Harnesses are found). */
  readonly env: Readonly<Record<string, string>>;
}

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** `POLARIS_HOME` plus the spec's environment, sorted by name. */
const sortedEnv = (spec: ServiceSpec): Array<[string, string]> =>
  Object.entries({ POLARIS_HOME: spec.home, ...spec.env }).sort(([a], [b]) => (a < b ? -1 : 1));

/** A launchd LaunchAgent for `~/Library/LaunchAgents/<label>.plist`. */
export const launchdPlist = (spec: ServiceSpec, label: string = LAUNCHD_LABEL): string => {
  const string = (value: string) => `<string>${xmlEscape(value)}</string>`;

  const envEntries = sortedEnv(spec)
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      ${string(value)}`)
    .join("\n");

  const argv = [spec.program, ...spec.args].map((arg) => `      ${string(arg)}`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${string(label)}
    <key>ProgramArguments</key>
    <array>
${argv}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>AssociatedBundleIdentifiers</key>
    <array>
      ${string(DESKTOP_BUNDLE_ID)}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    ${string(`${spec.logDir}/daemon.out.log`)}
    <key>StandardErrorPath</key>
    ${string(`${spec.logDir}/daemon.err.log`)}
  </dict>
</plist>
`;
};

/** systemd quotes: wrap in double quotes, escape backslash, quote, `%` and `$`. */
const systemdQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;

/** A systemd `--user` unit for `~/.config/systemd/user/polaris.service`. */
export const systemdUnit = (spec: ServiceSpec): string => {
  const envLines = sortedEnv(spec)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");

  const execStart = [spec.program, ...spec.args].map(systemdQuote).join(" ");

  return `[Unit]
Description=Polaris Daemon
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
${envLines}
Restart=always
RestartSec=2
StandardOutput=append:${spec.logDir}/daemon.out.log
StandardError=append:${spec.logDir}/daemon.err.log

[Install]
WantedBy=default.target
`;
};

/** Marks the lines Polaris adds to crontab and shell profiles, so uninstall finds them. */
export const SUPERVISOR_MARKER = "# polaris-supervisor";

/** POSIX sh single-quoting. */
export const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The fallback supervisor for Linux Hosts without a `systemd --user` bus
 * (minimal containers, SSH sessions without pam_systemd, non-systemd
 * distributions): `~/.polaris/bin/polaris-supervise`, a POSIX sh script.
 *
 * Without arguments it detaches itself (setsid when available, else nohup)
 * and returns at once. `--foreground` is the supervisor proper: single
 * instance through `supervisor.pid`, runs `polaris serve`, restarts it when it
 * exits (1 s backoff doubling to 60 s; reset after a minute of uptime), and
 * gives up quietly when the Daemon exits 75 (another Daemon already runs) or
 * the binary is gone (uninstalled). SIGTERM stops it and its Daemon.
 */
export const supervisorScript = (spec: ServiceSpec): string => {
  const exports = sortedEnv(spec)
    .map(([key, value]) => `${key}=${shQuote(value)}; export ${key}`)
    .join("\n");

  const serve = [spec.program, ...spec.args].map(shQuote).join(" ");

  return `#!/bin/sh
${SUPERVISOR_MARKER}: keeps the Polaris Daemon running on a Host without systemd --user.
# Written by \`polaris install\`; started by it, by cron @reboot and by the login profile.
${exports}
LOGS=${shQuote(spec.logDir)}
PIDFILE="$POLARIS_HOME/supervisor.pid"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }

if [ "$1" != "--foreground" ]; then
  running && exit 0
  mkdir -p "$LOGS"
  if command -v setsid >/dev/null 2>&1; then
    setsid "$0" --foreground </dev/null >>"$LOGS/supervisor.log" 2>&1 &
  else
    nohup "$0" --foreground </dev/null >>"$LOGS/supervisor.log" 2>&1 &
  fi
  exit 0
fi

running && exit 0
echo $$ >"$PIDFILE"
child=
trap 'rm -f "$PIDFILE"; [ -n "$child" ] && kill "$child" 2>/dev/null; exit 0' TERM INT HUP
delay=1
while :; do
  [ -x ${shQuote(spec.program)} ] || { rm -f "$PIDFILE"; exit 0; }
  started=$(date +%s)
  ${serve} >>"$LOGS/daemon.out.log" 2>>"$LOGS/daemon.err.log" &
  child=$!
  wait "$child"
  code=$?
  child=
  if [ "$code" = 75 ]; then rm -f "$PIDFILE"; exit 0; fi
  if [ $(( $(date +%s) - started )) -ge 60 ]; then delay=1; fi
  echo "$(date): polaris serve exited $code; restarting in \${delay}s"
  sleep "$delay"
  delay=$(( delay * 2 )); [ "$delay" -gt 60 ] && delay=60
done
`;
};

/** The line added to crontab and login profiles to start the supervisor. */
export const supervisorStartLine = (script: string, trigger: "cron" | "profile"): string =>
  trigger === "cron"
    ? `@reboot ${shQuote(script)} ${SUPERVISOR_MARKER}`
    : `[ -x ${shQuote(script)} ] && ${shQuote(script)} >/dev/null 2>&1 ${SUPERVISOR_MARKER}`;
