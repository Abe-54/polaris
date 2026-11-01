const framing = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);

const transport = new Set(["content-type", "content-encoding", "user-agent"]);

const credential =
  /auth|cookie|api[-_]?key|token|secret|password|credential|^x-(?:axiom|honeycomb)-/i;

export interface ForwardHeaderPolicy {
  readonly passesAppHeaders: boolean;
  readonly launchHeaderNames: ReadonlyArray<string>;
}

/** Both URLs have already passed collector endpoint validation. */
export const sameCollectorOrigin = (
  target: string | null | undefined,
  original: string | null | undefined
) => target != null && original != null && new URL(target).origin === new URL(original).origin;

const excluded = (headers: Headers) =>
  new Set([
    ...framing,
    ...(headers
      .get("connection")
      ?.split(",")
      .map((name) => name.trim().toLowerCase()) ?? []),
  ]);

/** Incoming credentials stay with the app's original origin; configured values take precedence. */
export const forwardHeaders = (
  incoming: Headers,
  configured: Readonly<Record<string, string>>,
  policy: ForwardHeaderPolicy
) => {
  const headers = new Headers();
  const launchNames = new Set(policy.launchHeaderNames.map((name) => name.toLowerCase()));
  const incomingExcluded = excluded(incoming);

  incoming.forEach((value, key) => {
    if (incomingExcluded.has(key)) return;

    if (
      !policy.passesAppHeaders &&
      (credential.test(key) || (launchNames.has(key) && !transport.has(key)))
    )
      return;
    headers.set(key, value);
  });

  const configuredHeaders = new Headers(configured);
  const configuredExcluded = excluded(configuredHeaders);
  configuredHeaders.forEach((value, key) => {
    if (!configuredExcluded.has(key)) headers.set(key, value);
  });

  return headers;
};

/** Static configured/launch credential names only; transport headers carry no UI metadata. */
export const forwardHeaderNames = (
  configured: Readonly<Record<string, string>>,
  policy: ForwardHeaderPolicy
) => {
  const names = Object.keys(configured);

  if (policy.passesAppHeaders) names.push(...policy.launchHeaderNames);

  return [...new Set(names.map((name) => name.toLowerCase()))]
    .filter((name) => !framing.has(name) && !transport.has(name))
    .sort();
};
