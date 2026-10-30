/**
 * Settings → Attachments, pure: the cleanup choices a select offers, their
 * words, edits to a Host's settings (the default, a Workspace's override), and the disk-use bar.
 */
import type { AttachmentCleanup, AttachmentSettings, AttachmentUsage } from "@polaris/protocol";
import type { Plain } from "../../../shared/api.ts";
import { formatSize } from "./model.ts";

export type CleanupSettings = Plain<AttachmentSettings>;

/** A select's value for a policy: "on-archive", "after-days:7", "never". */
export const policyKey = (policy: AttachmentCleanup): string =>
  policy.kind === "after-days" ? `after-days:${policy.days}` : policy.kind;

export const policyOf = (key: string): AttachmentCleanup | null => {
  if (key === "on-archive" || key === "never") return { kind: key };

  const days = /^after-days:(\d+)$/.exec(key)?.[1];

  return days === undefined || Number(days) < 1 ? null : { kind: "after-days", days: Number(days) };
};

export const policyLabel = (policy: AttachmentCleanup): string => {
  switch (policy.kind) {
    case "on-archive":
      return "When the session is archived";
    case "after-days":
      return policy.days === 1 ? "After 1 day" : `After ${policy.days} days`;
    case "never":
      return "Never, until cleared";
  }
};

const DAYS = [1, 7, 30, 90];

/** The choices, including an unusual day count already in effect so it still shows. */
export const policyChoices = (current: AttachmentCleanup): ReadonlyArray<AttachmentCleanup> => {
  const days =
    current.kind === "after-days" && !DAYS.includes(current.days)
      ? [...DAYS, current.days].sort((a, b) => a - b)
      : DAYS;

  return [
    { kind: "on-archive" },
    ...days.map((d): AttachmentCleanup => ({ kind: "after-days", days: d })),
    { kind: "never" },
  ];
};

/** The select value for "follow the host's default" on a Workspace row. */
export const USE_DEFAULT = "default";

export const withDefault = (settings: CleanupSettings, policy: AttachmentCleanup) => ({
  ...settings,
  default: policy,
});

/** Sets a Workspace's override, or drops it (null) so the Workspace follows the default. */
export const withWorkspace = (
  settings: CleanupSettings,
  workspaceId: string,
  policy: AttachmentCleanup | null
): CleanupSettings => {
  const workspaces = Object.fromEntries(
    Object.entries(settings.workspaces).filter(([id]) => id !== workspaceId)
  );

  return {
    ...settings,
    workspaces: policy === null ? workspaces : { ...workspaces, [workspaceId]: policy },
  };
};

export const filesLine = (files: number) => (files === 1 ? "1 file" : `${files} files`);

export const amountLine = (
  amount: { readonly bytes: number; readonly files: number } | undefined
) =>
  amount === undefined || amount.files === 0
    ? "Nothing staged"
    : `${formatSize(amount.bytes)} in ${filesLine(amount.files)}`;

/** A narrow select's closed label: "When archived", "After 7 days", "Never". */
export const policyShort = (policy: AttachmentCleanup): string => {
  switch (policy.kind) {
    case "on-archive":
      return "When archived";
    case "never":
      return "Never";
    case "after-days":
      return policyLabel(policy);
  }
};

export interface UsageSegment {
  /** A Workspace id, or "other" for the rest. */
  readonly key: string;
  readonly label: string;
  readonly bytes: number;
}

/** Workspaces drawn in the disk-use bar before the rest join "Other". */
const BAR_WORKSPACES = 3;

/**
 * The disk-use bar, largest first: up to three Workspaces, then "Other" for the rest and for
 * what is staged under Workspaces this Host no longer lists.
 */
export const usageSegments = (
  workspaces: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  usage: Plain<AttachmentUsage>
): ReadonlyArray<UsageSegment> => {
  const named = workspaces
    .flatMap((w) => {
      const bytes = usage.workspaces[w.id]?.bytes ?? 0;

      return bytes > 0 ? [{ key: w.id, label: w.name, bytes }] : [];
    })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, BAR_WORKSPACES);

  const rest = usage.total.bytes - named.reduce((sum, s) => sum + s.bytes, 0);

  return rest > 0 ? [...named, { key: "other", label: "Other", bytes: rest }] : named;
};
