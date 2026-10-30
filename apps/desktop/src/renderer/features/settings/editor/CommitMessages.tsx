/**
 * SR-02's Commit messages card: what a draft looks like, from the workspace's last real commit
 * or a static example, and who drafts it (the Harness and Model chips).
 */
import { Kicker, SettingsCard, SettingsWell } from "@polaris/ui";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { polaris } from "../../bridge.ts";

export interface CommitPreview {
  readonly subject: string;
  readonly body: string;
}

/** Shown while the workspace has no commit to read. */
export const EXAMPLE_COMMIT: CommitPreview = {
  subject: "fix(daemon): a cancel reaches queued requests",
  body: "Queued requests now see the cancel before they start, so a stopped turn never runs late work.",
};

/** The preview's message and its kicker: the real commit when there is one, else the example. */
export const commitPreview = (lastCommit: CommitPreview | null) =>
  lastCommit === null
    ? { kicker: "A draft looks like", message: EXAMPLE_COMMIT }
    : { kicker: "Like your last commit", message: lastCommit };

/** A git checkout on a Host whose Daemon answers `git.log`. */
export interface CommitSource {
  readonly hostKey: string;
  readonly cwd: string;
}

/** The source's newest commit; null while it loads, and when the read fails or finds none. */
export const useLastCommit = (source: CommitSource | null): CommitPreview | null => {
  const hostKey = source?.hostKey ?? null;
  const cwd = source?.cwd ?? null;
  const key = hostKey === null || cwd === null ? null : `${hostKey}\0${cwd}`;
  const [read, setRead] = useState<{ key: string; commit: CommitPreview | null } | null>(null);

  useEffect(() => {
    if (key === null || hostKey === null || cwd === null) return;
    let live = true;

    void polaris()
      .request("git.log", { hostKey, cwd, limit: 1 })
      .then((result) => {
        const last = result.ok ? result.value.commits[0] : undefined;

        if (live) setRead({ key, commit: last === undefined ? null : last });
      });

    return () => {
      live = false;
    };
  }, [key, hostKey, cwd]);

  return read?.key === key ? read.commit : null;
};

export const CommitMessagesCard = ({
  lastCommit,
  chooser,
}: {
  /** The workspace's last commit (`useLastCommit`); null shows the example. */
  readonly lastCommit: CommitPreview | null;
  /** The Harness and Model chips (CommitMessagesChoice). */
  readonly chooser: ReactNode;
}) => {
  const preview = commitPreview(lastCommit);

  return (
    <SettingsCard
      title="Commit messages"
      aside="Drafted from staged changes"
      status="A small model keeps it quick"
      className="h-full"
    >
      <SettingsWell className="flex-1">
        <div
          data-testid="commit-preview"
          className="px-panel flex flex-1 flex-col gap-1.5 py-[calc(var(--spacing-panel)-2px)]"
        >
          <Kicker className="text-text-subtle">{preview.kicker}</Kicker>
          <p className="text-text-default font-mono text-[12px] leading-[18px]">
            {preview.message.subject}
          </p>
          {preview.message.body === "" ? null : (
            <p className="text-text-subtle line-clamp-3 font-mono text-[12px] leading-[18px]">
              {preview.message.body}
            </p>
          )}
        </div>
        <div className="px-panel flex flex-wrap items-center gap-x-3 gap-y-2 py-[calc(var(--spacing-gap)+4px)]">
          <span className="text-body text-text-default flex-1 whitespace-nowrap">Drafted by</span>
          <div className="flex min-w-0 shrink items-center">{chooser}</div>
        </div>
      </SettingsWell>
    </SettingsCard>
  );
};
