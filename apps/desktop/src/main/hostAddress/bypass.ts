/**
 * The proxy rules of a remote Host's Browser partition. Chromium never consults a PAC script
 * for loopback, `<-loopback>` or not, so the partition sends everything to its proxy
 * and bypasses the complement of the Host addresses (ADR 0093), the Host's hosts-file
 * loopback names included (ENG-621).
 */
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Characters of a canonical hostname, as Chromium's URL parser leaves them. */
const NAME_CHARS = `${LETTERS}0123456789-_.`;

/** A suffix in the trie of protected names: itself only (`exact`), or every name ending in it. */
interface Node {
  readonly children: Map<string, Node>;
  covers: "exact" | "suffix" | null;
}

const node = (): Node => ({ children: new Map(), covers: null });

const protectedTrie = (extraNames: ReadonlyArray<string>): Node => {
  const root = node();

  const protect = (text: string, covers: "exact" | "suffix") => {
    let at = root;

    for (const c of text.split("").reverse()) {
      const next = at.children.get(c) ?? node();

      at.children.set(c, next);
      at = next;
    }

    if (at.covers !== "suffix") at.covers = covers;
  };

  for (const name of ["localhost", "localhost."]) protect(name, "exact");

  for (const suffix of [".localhost", ".localhost."]) protect(suffix, "suffix");

  for (const name of extraNames)
    if (name.split("").every((c) => NAME_CHARS.includes(c)) && !name.startsWith(".")) {
      protect(name, "exact");
      protect(`${name}.`, "exact");
    }

  return root;
};

/**
 * Glob rules for every hostname outside the trie: below each suffix, `*` + a character the
 * trie lacks there + the suffix, and the suffix itself unless protected. Chromium matches
 * globs against IPv4 literals too, so no rule ends in a digit (such names reach the proxy).
 */
const nameRules = (extraNames: ReadonlyArray<string>): ReadonlyArray<string> => {
  const rules: Array<string> = [];

  const walk = (at: Node, suffix: string) => {
    if (at.covers === "suffix" || /\d\.?$/.test(suffix)) return;
    const before = suffix === "" || suffix === "." ? `${LETTERS}-_` : NAME_CHARS;

    for (const c of before) if (!at.children.has(c)) rules.push(`*${c}${suffix}`);

    // A rule starting with "." would mean "*." to Chromium: skip such suffixes.
    if (suffix !== "" && !suffix.startsWith(".") && at.covers === null) rules.push(suffix);

    for (const [c, child] of at.children) walk(child, `${c}${suffix}`);
  };

  walk(protectedTrie(extraNames), "");

  return rules;
};

/** IPv4 outside 0.0.0.0/8 and 127.0.0.0/8; IPv6 outside ::/8 (::1, IPv4-mapped loopback). */
const IP_RULES = [
  "1.0.0.0/8",
  "2.0.0.0/7",
  "4.0.0.0/6",
  "8.0.0.0/5",
  "16.0.0.0/4",
  "32.0.0.0/3",
  "64.0.0.0/3",
  "96.0.0.0/4",
  "112.0.0.0/5",
  "120.0.0.0/6",
  "124.0.0.0/7",
  "126.0.0.0/8",
  "128.0.0.0/1",
  "100::/8",
  "200::/7",
  "400::/6",
  "800::/5",
  "1000::/4",
  "2000::/3",
  "4000::/2",
  "8000::/1",
];

/**
 * `<-loopback>` first, so Chromium's implicit loopback bypass doesn't send Host addresses to
 * the Client's own loopback. Anything left proxied that isn't a Host address (a name ending
 * in a digit, `0.0.0.0`) reaches the proxy, which loads it directly or refuses it.
 */
export const proxyBypassRules = (extraNames: ReadonlyArray<string> = []) =>
  ["<-loopback>", ...nameRules(extraNames), ...IP_RULES].join(",");

/** The `session.setProxy` config of a remote Host's partition; `names` from its hosts file. */
export const remoteProxyConfig = (proxyPort: number, names: ReadonlyArray<string> = []) => ({
  mode: "fixed_servers" as const,
  proxyRules: `http://127.0.0.1:${proxyPort}`,
  proxyBypassRules: proxyBypassRules(names),
});
