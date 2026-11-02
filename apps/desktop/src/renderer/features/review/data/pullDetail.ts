/**
 * A pull request's detail from GitHub (`github.pull.detail`: title, refs, files with their
 * Viewed state, threads, the pending review), shared by everything in its Review: the
 * header, the file list, and the comments and submit dialog that plug in (M2-F).
 */
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { IpcError, OpenPull } from "../../../../shared/api.ts";
import type { PullDetailView } from "../../../../shared/github.ts";
import { polaris } from "../../bridge.ts";
import { settlePull } from "./viewedStore.ts";

export type PullDetail =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly detail: PullDetailView }
  | { readonly kind: "failed"; readonly error: IpcError };

const details = createStore<Readonly<Record<string, PullDetail>>>(() => ({}));

export const pullKey = (pull: Pick<OpenPull, "repo" | "number">) =>
  `${pull.repo.owner}/${pull.repo.name}#${pull.number}`.toLowerCase();

const store = (detail: PullDetailView) => {
  const viewed = new Map(detail.files.map((f) => [f.path, f.viewed === "viewed"]));

  settlePull(detail.id, (path) => viewed.get(path) ?? false);
  details.setState({
    [pullKey({ repo: repoOf(detail.repo), number: detail.number })]: { kind: "ok", detail },
  });
};

const repoOf = (repo: string) => {
  const [owner = "", name = ""] = repo.split("/");

  return { owner, name };
};

/**
 * The cached details main refreshes on its poll (`github.details`), while a Review is open:
 * Overview's timeline, commits and checks follow GitHub without fetching per view.
 */
export const useDetailsFeed = () => {
  useEffect(() => {
    return polaris().subscribe(
      "github.details",
      {},
      {
        items: (batches) => {
          for (const batch of batches) for (const detail of batch) store(detail);
        },
      }
    );
  }, []);
};

/**
 * Fetches the detail again (after a comment, a submit, or new commits), past main's cache
 * unless `refresh` is false; keeps the last while it loads.
 */
export const refreshPullDetail = async (
  pull: Pick<OpenPull, "repo" | "number">,
  refresh = true
) => {
  const key = pullKey(pull);

  const result = await polaris().request("github.pull.detail", {
    pull: { repo: pull.repo, number: pull.number },
    refresh,
  });

  if (result.ok) {
    store(result.value);
  } else if (details.getState()[key]?.kind !== "ok") {
    details.setState({ [key]: { kind: "failed", error: result.error } });
  }
};

/** The pull request's detail, fetched when first asked for. */
export const usePullDetail = (pull: Pick<OpenPull, "repo" | "number">): PullDetail => {
  const current = useStore(details, (s) => s[pullKey(pull)]);
  const { owner, name } = pull.repo;
  const { number } = pull;

  useEffect(() => {
    void refreshPullDetail({ repo: { owner, name }, number }, false);
  }, [owner, name, number]);

  return current ?? { kind: "loading" };
};

/** The detail if something in this Review already loaded it; never fetches. */
export const useLoadedPullDetail = (
  pull: Pick<OpenPull, "repo" | "number">
): PullDetailView | null =>
  useStore(details, (s) => {
    const current = s[pullKey(pull)];

    return current?.kind === "ok" ? current.detail : null;
  });
