/** Settings (Paper MX-G) as data: the theme cards' copy and the Hosts and Motion rows' lines. */
import type { ConnectionState } from "@polaris/protocol";
import { Match } from "effect";
import { shortHostName } from "../home/model/format.ts";
import type { MotionPreference, ThemeName } from "../theme";

export const THEME_CARDS: ReadonlyArray<{
  readonly name: ThemeName;
  readonly title: string;
  readonly caption: string;
}> = [
  { name: "midnight", title: "Midnight", caption: "Stars only, black ground" },
  { name: "moonlit", title: "Moonlit", caption: "A pixel moon, softer ground" },
];

export interface HostsLine {
  readonly names: string;
  /** "+ 2", the Hosts past the named ones; it stays in view when the names truncate. */
  readonly more: string | null;
  /** "1 reconnecting" in needs you's colour; null when every Host is fine. */
  readonly note: string | null;
}

const SHOWN = 2;

/** "mac-studio, lucas-rpi" "+ 2" "1 reconnecting": the first names, the rest counted. */
export const hostsLine = (
  hosts: ReadonlyArray<{ readonly name: string; readonly state: ConnectionState }>
): HostsLine => {
  if (hosts.length === 0) return { names: "No hosts yet", more: null, note: null };

  const names = hosts.slice(0, SHOWN).map((host) => shortHostName(host.name));
  const rest = hosts.length - SHOWN;
  const count = (state: ConnectionState) => hosts.filter((host) => host.state === state).length;

  const notes = [
    [count("needs-attention"), "needs attention"],
    [count("reconnecting"), "reconnecting"],
    [count("offline"), "offline"],
  ] as const;

  const note = notes.find(([n]) => n > 0);

  return {
    names: names.join(", "),
    more: rest > 0 ? `+ ${rest}` : null,
    note: note === undefined ? null : `${note[0]} ${note[1]}`,
  };
};

export const MOTION_CHOICES: ReadonlyArray<{
  readonly motion: MotionPreference;
  readonly label: string;
}> = [
  { motion: "system", label: "Follow Reduce Motion" },
  { motion: "reduced", label: "Reduced" },
  { motion: "full", label: "Full" },
];

export const motionLine = (motion: MotionPreference): string =>
  Match.value(motion).pipe(
    Match.when("system", () => "Follows Reduce Motion"),
    Match.when("reduced", () => "Reduced, always"),
    Match.when("full", () => "Full, even with Reduce Motion on"),
    Match.exhaustive
  );

/** What each connected Host says of Developer Mode, for the read-only row. */
export interface HostDeveloperMode {
  readonly stored: boolean;
  readonly effective: boolean;
}

/** Developer Mode as the Hosts store it; the phone only shows it (ENG-709). */
export const developerModeLine = (modes: ReadonlyArray<HostDeveloperMode>): string => {
  if (modes.length === 0) return "Set in Polaris on your computer";

  if (modes.some((mode) => mode.stored)) return "On · set in Polaris on your computer";

  const tracing = modes.filter((mode) => mode.effective).length;

  return tracing === 0 ? "Off" : `Off · on for now on ${tracing} of ${modes.length} hosts`;
};
