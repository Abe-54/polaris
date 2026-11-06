import type { WindowOpenHandlerResponse } from "electron";
import { externalUrl } from "../shared/externalUrl.ts";

/** Web popups leave Polaris through the default browser; no popup becomes an app window. */
export const externalWindowOpenHandler =
  (openExternal: (url: string) => Promise<void>) =>
  ({ url }: { readonly url: string }) => {
    const target = externalUrl(url);

    if (target !== null)
      void openExternal(target).catch((error) =>
        console.warn("Could not open link in browser", error)
      );

    return { action: "deny" } satisfies WindowOpenHandlerResponse;
  };
