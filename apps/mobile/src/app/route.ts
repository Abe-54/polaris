/** A screen on the navigation stack; plain TypeScript so scripts can import it without JSX. */
export type Route =
  | { readonly screen: "tabs" }
  | { readonly screen: "hosts" }
  | {
      readonly screen: "thread";
      readonly hostId: string;
      readonly sessionId: string;
      /** Just started from New session: its celestial rises into the header (MX-AS). */
      readonly rise?: true;
    }
  /** A new agent session; `workspaceId` preselects one, `hostId` a Host. */
  | {
      readonly screen: "newSession";
      readonly workspaceId: string | null;
      readonly hostId?: string;
    }
  | { readonly screen: "constellation"; readonly hostId: string; readonly constellationId: string }
  | {
      readonly screen: "review";
      readonly hostId: string;
      readonly sessionId: string;
      readonly turnId: string | null;
    }
  | { readonly screen: "link" };
