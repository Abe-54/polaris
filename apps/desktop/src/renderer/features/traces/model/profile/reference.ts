/**
 * ⌘L's text for a Profile (DESIGN.md, Traces → Profile): the recording, its hottest functions and
 * the selected frame, as a reference an agent can look up by id, appended like a trace's.
 */
import type { ProfileDetail } from "@polaris/protocol";
import { formatDuration } from "../format.ts";
import { functionPath, processLabel, shareLabel } from "./labels.ts";

const HOTTEST = 3;

const where = (detail: ProfileDetail, index: number, checkout: string | null) => {
  const fn = detail.hotFunctions[index];

  if (fn === undefined) return "an unknown function";
  const path = functionPath(fn, checkout);
  const place = path === null ? "native" : fn.line === null ? path : `${path}:${fn.line}`;

  return `\`${fn.name}\` (${place})`;
};

export const profileReference = (
  detail: ProfileDetail,
  frame: { readonly functionIndex: number; readonly durationMs: number } | null,
  checkout: string | null
): string => {
  const { profile } = detail;
  const recorded = formatDuration(profile.durationMs);

  const hottest = detail.hotFunctions
    .slice(0, HOTTEST)
    .map((fn, i) => `${where(detail, i, checkout)} ${shareLabel(fn.totalMs, profile.durationMs)}`);

  const facts = [
    `${profile.runtime}, pid ${profile.pid}`,
    `${recorded} recorded`,
    profile.turn === null ? "between turns" : `turn ${profile.turn.number}`,
    ...(profile.status === "completed" ? [] : [profile.status]),
  ];

  const head = `Profile \`${profile.id}\` in this checkout: \`${processLabel(profile)}\` (${facts.join(", ")})`;
  const lines = [head, ...(hottest.length === 0 ? [] : [`Hottest: ${hottest.join(", ")}`])];

  if (frame !== null)
    lines.push(
      `Frame: ${where(detail, frame.functionIndex, checkout)}, ${formatDuration(frame.durationMs)}`
    );

  return lines.join("\n");
};
