/** Where paths inside a view live: its Host and the folder they are relative to. */
import type { WorkspaceId } from "@polaris/protocol";
import { createContext, useContext, useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export interface EditorPlace {
  readonly hostKey: string;
  /** A session's cwd, a Review Checkout, a Worktree; relative paths resolve against it. */
  readonly root: string | null;
  readonly workspaceId?: WorkspaceId | null;
  /** The Host runs Windows: a drive path (`C:\…`) is absolute there; elsewhere it is a URL. */
  readonly windows?: boolean;
}

export const EditorPlaceContext = createContext<EditorPlace | null>(null);

export const EditorPlaceProvider = EditorPlaceContext.Provider;

export const useEditorPlace = (): EditorPlace | null => useContext(EditorPlaceContext);

/** The open Review's place (its Review Checkout, or the session's cwd): what ⌘P searches in Review. */
const reviewPlace = createStore<{ readonly place: EditorPlace | null }>(() => ({ place: null }));

export const useReviewPlace = (): EditorPlace | null => useStore(reviewPlace, (s) => s.place);

/** Publishes the Review's place while it is mounted. */
export const usePublishReviewPlace = (place: EditorPlace | null) => {
  const { hostKey, root, workspaceId } = place ?? { hostKey: null, root: null, workspaceId: null };

  useEffect(() => {
    if (hostKey === null) return undefined;
    reviewPlace.setState({ place: { hostKey, root, workspaceId: workspaceId ?? null } });

    return () => reviewPlace.setState({ place: null });
  }, [hostKey, root, workspaceId]);
};
