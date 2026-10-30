/**
 * Host addresses on a Workspace's Browser partition (`browser/views.ts` makes it, with no
 * permissions and the app's TLS distrust): where they go, and the certificates they may show.
 */
import type { Session } from "electron";
import { chromiumVerdict } from "../tls/distrust.ts";
import { remoteProxyConfig } from "./bypass.ts";

/** Where the partition's Host addresses go: this machine's loopback, or the proxy. */
export type PartitionRoute =
  | { readonly kind: "local" }
  | { readonly kind: "remote"; readonly proxyPort: number };

export const configurePartition = async (
  session: Session,
  route: PartitionRoute,
  isHostAddress: (hostname: string) => boolean
) => {
  await session.setProxy(
    route.kind === "local" ? { mode: "direct" } : remoteProxyConfig(route.proxyPort)
  );
  // The pool may hold sockets from a proxy config this partition had before.
  await session.closeAllConnections();

  // A Host address's bytes never leave Polaris's link and the Host's loopback (ADR 0093);
  // every other name keeps the distrust check `browser/views.ts` installed.
  session.setCertificateVerifyProc((request, callback) =>
    callback(isHostAddress(request.hostname) ? 0 : chromiumVerdict(request))
  );
};

/**
 * A removed Host's partition: Host-address certificates lose their pass and pooled sockets to
 * the old proxy close. The proxy settings stay on the retired proxy, which refuses everything.
 */
export const retirePartition = async (session: Session) => {
  session.setCertificateVerifyProc((request, callback) => callback(chromiumVerdict(request)));
  await session.closeAllConnections();
};
