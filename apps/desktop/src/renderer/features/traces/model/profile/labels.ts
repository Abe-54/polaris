/**
 * How the sidebar and the profile panel write a Profile (DESIGN.md, Traces → Sidebar, Profile):
 * its process, how it was made, and a function's place in the code.
 */
import type { Profile, ProfileFunction } from "@polaris/protocol";
import { formatDuration } from "../format.ts";

const pad = (n: number) => n.toString().padStart(2, "0");

const clock = (iso: string) => {
  const at = new Date(iso);

  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

/** "ledger-api · bun" when the Daemon names the service, else the command it ran. */
export const processLabel = (profile: Profile): string =>
  profile.service === undefined ? profile.command : `${profile.service} · ${profile.runtime}`;

const ORIGIN: Record<NonNullable<Profile["origin"]>, (byAgent: boolean) => string> = {
  restart: (byAgent) => `Restarted with profiling by ${byAgent ? "the agent" : "you"}`,
  command: () => "Whole command",
  attach: () => "Attached while it ran",
};

/** How the recording was made, or, from a Daemon that doesn't say, when. */
export const originLabel = (profile: Profile): string => {
  if (profile.status === "failed") return "Recording failed";
  const made = profile.origin === undefined ? null : ORIGIN[profile.origin](profile.turn !== null);

  if (profile.status === "recording") return made === null ? "Recording…" : `${made} · recording`;

  if (made !== null) return made;

  return profile.turn === null
    ? `Recorded between turns · ${clock(profile.startedAt)}`
    : `Recorded in turn ${profile.turn.number} · ${clock(profile.startedAt)}`;
};

/** The duration lane: the recorded length, or a dash while it can't be known. */
export const lengthLabel = (profile: Profile): string =>
  profile.status === "completed" || profile.durationMs > 0
    ? formatDuration(profile.durationMs)
    : "–";

const RUNTIME_FILE = /^(node|bun):/;

const FILE_URL = /^file:\/\//;

/** A function's file relative to the checkout when inside it; null for a native frame. */
export const functionPath = (fn: ProfileFunction, checkout: string | null): string | null => {
  if (fn.file === null || fn.file === "") return null;
  const plain = fn.file.replace(FILE_URL, "");

  if (checkout === null || !plain.startsWith("/")) return plain;
  const root = checkout.endsWith("/") ? checkout : `${checkout}/`;

  return plain.startsWith(root) ? plain.slice(root.length) : plain;
};

/** Whether the Editor can open it: a file in the checkout, not the runtime's or a dependency's. */
export const opensInEditor = (fn: ProfileFunction, checkout: string | null): boolean => {
  const path = functionPath(fn, checkout);

  return (
    path !== null &&
    !path.startsWith("/") &&
    !RUNTIME_FILE.test(path) &&
    !path.includes("node_modules/")
  );
};

/** "fx.ts:23", "(native)", "(node:tls)": where a function is, short. */
export const placeLabel = (fn: ProfileFunction, checkout: string | null): string => {
  const path = functionPath(fn, checkout);

  if (path === null) return "(native)";

  if (RUNTIME_FILE.test(path)) return `(${path})`;
  const name = path.slice(path.lastIndexOf("/") + 1);

  return fn.line === null ? name : `${name}:${fn.line}`;
};

/** A function's total time as a share of the recording: "58%", "<1%". */
export const shareLabel = (totalMs: number, recordedMs: number): string => {
  if (recordedMs <= 0) return "–";
  const share = Math.min(1, totalMs / recordedMs) * 100;

  return share > 0 && share < 1 ? "<1%" : `${Math.round(share)}%`;
};
