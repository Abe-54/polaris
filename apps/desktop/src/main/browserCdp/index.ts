/**
 * The CDP side of the Browser in main (ENG-616, ADR 0092): serves the Daemon's `browser.host`
 * streams with a facade over the session's tabs (`README.md`). `Browsers` (`../browser`)
 * plugs in through the `CdpTabs` port.
 */
import type { LiveSession } from "@polaris/client";
import { Effect, Stream } from "effect";
import { type BrowserHostDeps, serveBrowserHost } from "./host.ts";

export { cdpFacade, type CdpFacade, type CdpFacadeInput, type CdpVersions } from "./facade.ts";

export type { CdpDebuggee, CdpTabs, OpenTabInput, TabRef } from "./ports.ts";

export { REFUSED_DOMAINS, REFUSED_METHODS, refusalOf } from "./refusals.ts";

export { serveBrowserHost, type BrowserHostDeps } from "./host.ts";

export { cdpTabsOf } from "./adapter.ts";

export { electronCdpVersions } from "./versions.ts";

/**
 * Hosts Browsers on every live session of a Host that supports `browser.host`; a new
 * connection starts over, as the Daemon forgets the old one's streams with it.
 */
export const hostBrowsers = (
  sessions: Stream.Stream<LiveSession | null>,
  deps: BrowserHostDeps
): Effect.Effect<void> =>
  sessions.pipe(
    Stream.switchMap((session) =>
      session === null || !session.capabilities.includes("browser.host")
        ? Stream.empty
        : Stream.fromEffectDrain(serveBrowserHost(session, deps))
    ),
    Stream.runDrain
  );
