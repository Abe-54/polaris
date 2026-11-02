/** Where "Clone on…" puts a repository and how it fetches it. Pure. */

/** `~/code/<name>`, then `~/code/<name>-2`… */
export const clonePath = (homeDir: string, name: string, attempt: number) =>
  `${homeDir.replace(/\/+$/, "")}/code/${name}${attempt <= 1 ? "" : `-${attempt}`}`;

export type CloneTransport = "ssh" | "https";

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

const SSH_HOST = /^(?:ssh:\/\/)?[^@/\s]+@([^:/\s]+)/i;

/** The code host a remote reaches over ssh (`git@H:…`, `ssh://git@H/…`); null for any other. */
const sshHostOf = (remote: string): string | null => {
  const url = remote.trim();
  const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();

  if (scheme !== undefined && scheme !== "ssh") return null;

  return SSH_HOST.exec(url)?.[1]?.toLowerCase() ?? null;
};

/** ssh when one of the Host's remotes reaches `codeHost` over ssh, else https, as its fetches choose. */
export const cloneTransport = (remotes: ReadonlyArray<string>, codeHost: string): CloneTransport =>
  remotes.some((remote) => sshHostOf(remote) === codeHost.toLowerCase()) ? "ssh" : "https";

export const cloneUrl = (
  codeHost: string,
  owner: string,
  name: string,
  transport: CloneTransport
) =>
  transport === "ssh"
    ? `git@${codeHost}:${owner}/${name}.git`
    : `https://${codeHost}/${owner}/${name}.git`;

/** The preferred transport's URL first, the other as the fallback. */
export const cloneUrls = (
  codeHost: string,
  owner: string,
  name: string,
  preferred: CloneTransport
): ReadonlyArray<string> =>
  (preferred === "ssh" ? (["ssh", "https"] as const) : (["https", "ssh"] as const)).map(
    (transport) => cloneUrl(codeHost, owner, name, transport)
  );

/** Single-quoted for `sh`. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Tries each URL in turn; a failed `git clone` removes the folder it made. */
export const cloneCommand = (urls: ReadonlyArray<string>, path: string) => {
  const parent = path.slice(0, path.lastIndexOf("/"));
  const clones = urls.map((url) => `git clone ${shellQuote(url)} ${shellQuote(path)}`);

  return `mkdir -p ${shellQuote(parent)} && { ${clones.join(" || ")}; }`;
};
