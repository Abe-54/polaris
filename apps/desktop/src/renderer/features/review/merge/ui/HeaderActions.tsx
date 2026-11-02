/**
 * A pull request header's right side: Reviewers, the checkout chip, Merge and the primary
 * slot (Submit review), with the palette's "Merge #88…" and "Request reviewers on #88…".
 */
import { type ReactNode, useEffect } from "react";
import type { OpenPull } from "../../../../../shared/api.ts";
import type { PullDetailView } from "../../../../../shared/github.ts";
import { useApp, useCommands } from "../../../../shell/hooks.ts";
import type { Held } from "../../checkout/actions.ts";
import { openPanel } from "../data/panels.ts";
import { usePullActions } from "../data/store.ts";
import { mergeButton } from "../model/merge.ts";
import { linkedSessionOf } from "../model/local.ts";
import { MergeAction } from "./MergeAction.tsx";
import { Reviewers } from "./Reviewers.tsx";

/** What, when it changes, makes the merge state worth asking GitHub again. */
const signatureOf = (detail: PullDetailView | null) =>
  detail === null
    ? ""
    : [
        detail.state,
        detail.isDraft,
        detail.headRefOid,
        detail.baseRefOid,
        JSON.stringify(detail.checks ?? null),
        detail.timeline?.length ?? 0,
      ].join(":");

const usePaletteCommands = (number: number, merge: boolean, request: boolean) => {
  const registry = useCommands();

  useEffect(() => {
    return registry.contribute([
      ...(merge
        ? [
            {
              id: "review.merge",
              title: `Merge #${number}…`,
              palette: {
                group: "workspace" as const,
                keywords: ["pull request", "squash", "rebase", "github"],
              },
              handler: { run: () => openPanel("merge") },
            },
          ]
        : []),
      ...(request
        ? [
            {
              id: "review.requestReviewers",
              title: `Request reviewers on #${number}…`,
              palette: {
                group: "workspace" as const,
                keywords: ["pull request", "reviewer", "ask", "github"],
              },
              handler: { run: () => openPanel("reviewers") },
            },
          ]
        : []),
    ]);
  }, [registry, number, merge, request]);
};

export interface HeaderActionsProps {
  readonly pull: OpenPull;
  readonly detail: PullDetailView | null;
  readonly checkout: Held | null;
  /** The checkout chip. */
  readonly chip: ReactNode;
  /** The primary slot (Submit review). */
  readonly primary: ReactNode;
}

export const HeaderActions = ({ pull, detail, checkout, chip, primary }: HeaderActionsProps) => {
  const state = usePullActions(pull, signatureOf(detail));
  const actions = state.kind === "ok" ? state.view : null;
  const models = useApp((s) => s.hostModels);
  const hosts = useApp((s) => s.hosts);
  const labelOf = (key: string) => hosts.find((h) => h.key === key)?.label ?? key;
  const session = linkedSessionOf(models, labelOf, pull);
  const open = actions?.merge.state === "open";

  usePaletteCommands(
    pull.number,
    mergeButton(actions?.merge ?? null).kind !== "hidden",
    open && actions?.reviewers.canRequest === true
  );

  return (
    <>
      {open && (
        <Reviewers pull={pull} view={actions.reviewers} viewer={actions.merge.viewerLogin} />
      )}
      {chip}
      <MergeAction
        pull={pull}
        actions={actions}
        commits={detail?.commits ?? 0}
        checkout={checkout}
        session={session}
      />
      {primary}
    </>
  );
};
