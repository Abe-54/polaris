/**
 * The proxy rules of a remote Host's Browser partition. Chromium never consults a PAC script
 * for loopback, `<-loopback>` or not, so the partition sends everything to its proxy
 * and bypasses the complement of the Host addresses (ADR 0093).
 */
const LOCALHOST = "localhost";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Characters of a canonical hostname, as Chromium's URL parser leaves them. */
const NAME_CHARS = `${LETTERS}0123456789-_.`;

/**
 * Glob rules matching every name that ends `…c` + a proper suffix of `name`, `c` not the
 * character `name` has there, plus the proper suffixes themselves. `firstBefore` limits `c`
 * when the suffix is a single character, as digits there could match an IPv4 literal.
 */
const notEndingWith = (name: string, firstBefore: string): ReadonlyArray<string> => {
  const rules: Array<string> = [];

  for (let k = 1; k <= name.length; k++) {
    const suffix = name.slice(-k);
    const expected = k === name.length ? "." : name.at(-k - 1)!;
    const before = k === 1 ? firstBefore : NAME_CHARS;

    for (const c of before) if (c !== expected) rules.push(`*${c}${suffix}`);

    // A rule starting with "." would mean "*." to Chromium: skip the bare ".".
    if (k < name.length && !suffix.startsWith(".")) rules.push(suffix);
  }

  return rules;
};

/**
 * Glob rules for every hostname that is not `localhost` or a `*.localhost` name, with or
 * without a trailing dot. Chromium matches them against IPv4 literals too, so none ends in a
 * digit; IPv6 literals keep their brackets, so none ends in `]`.
 */
const nameRules = (): ReadonlyArray<string> => [
  ...Array.from(`${LETTERS.replace("t", "")}-_`, (c) => `*${c}`),
  ...notEndingWith(LOCALHOST, NAME_CHARS),
  ...notEndingWith(`${LOCALHOST}.`, `${LETTERS}-_`),
];

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
export const PROXY_BYPASS_RULES = ["<-loopback>", ...nameRules(), ...IP_RULES].join(",");

/** The `session.setProxy` config of a remote Host's partition. */
export const remoteProxyConfig = (proxyPort: number) => ({
  mode: "fixed_servers" as const,
  proxyRules: `http://127.0.0.1:${proxyPort}`,
  proxyBypassRules: PROXY_BYPASS_RULES,
});
