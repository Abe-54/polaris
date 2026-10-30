/**
 * The HTTP proxy protocol as Chromium speaks it to a remote Host's partition: CONNECT for
 * https and every WebSocket, absolute-URI requests for plain http. Each request carries
 * `Proxy-Authorization` with the proxy's secret, which Electron's `login` event supplies.
 */
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Data } from "effect";

/** The user name in the proxy's Basic credential; the secret is the password. */
export const PROXY_USER = "polaris";

/** A request head larger than this is refused unread. */
export const MAX_HEAD_BYTES = 16 * 1024;

const HEAD_END = Buffer.from("\r\n\r\n");

export type Head = Data.TaggedEnum<{
  NeedMore: Record<never, never>;
  TooLarge: Record<never, never>;
  Done: { readonly lines: ReadonlyArray<string>; readonly rest: Uint8Array };
}>;

export const Head = Data.taggedEnum<Head>();

/** The request line and header lines once the head has arrived, and the bytes after it. */
export const splitHead = (bytes: Uint8Array): Head => {
  const end = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(HEAD_END);

  if (end === -1) return bytes.length > MAX_HEAD_BYTES ? Head.TooLarge() : Head.NeedMore();

  if (end > MAX_HEAD_BYTES) return Head.TooLarge();

  return Head.Done({
    lines: Buffer.from(bytes.subarray(0, end)).toString("latin1").split("\r\n"),
    rest: bytes.subarray(end + HEAD_END.length),
  });
};

/** The `Proxy-Authorization` value a request must carry, byte for byte. */
export const proxyCredential = (secret: string): Uint8Array =>
  Buffer.from(`Basic ${Buffer.from(`${PROXY_USER}:${secret}`).toString("base64")}`);

const headerName = (line: string) => line.slice(0, line.indexOf(":")).trim().toLowerCase();

const headerValue = (line: string) => line.slice(line.indexOf(":") + 1).trim();

/** Exactly one `Proxy-Authorization` header, equal to `expected`, compared in constant time. */
export const authorized = (lines: ReadonlyArray<string>, expected: Uint8Array): boolean => {
  const given = lines.slice(1).filter((line) => headerName(line) === "proxy-authorization");

  if (given.length !== 1) return false;
  const value = Buffer.from(headerValue(given[0]!), "latin1");

  return value.length === expected.length && timingSafeEqual(value, expected);
};

export type ProxyRequest = Data.TaggedEnum<{
  /** CONNECT: a byte tunnel once the proxy answers 200. */
  Tunnel: { readonly hostname: string; readonly port: number };
  /**
   * An absolute-URI request, its head rewritten for the origin server, and how many body
   * bytes follow it; null for an upgrade, whose connection then carries its own protocol.
   */
  Forward: {
    readonly hostname: string;
    readonly port: number;
    readonly head: Uint8Array;
    readonly body: number | null;
  };
  Invalid: Record<never, never>;
}>;

export const ProxyRequest = Data.taggedEnum<ProxyRequest>();

/** Brackets come off IPv6 literals; names stay exactly as sent. */
const bare = (host: string) =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65_535;

const tunnel = (authority: string): ProxyRequest => {
  const colon = authority.lastIndexOf(":");
  const hostname = bare(authority.slice(0, colon));
  const port = Number(authority.slice(colon + 1));

  return colon > 0 && hostname !== "" && validPort(port)
    ? ProxyRequest.Tunnel({ hostname, port })
    : ProxyRequest.Invalid();
};

/** Hop-by-hop and proxy headers never reach the origin server, the credential above all. */
const DROPPED = new Set(["proxy-authorization", "proxy-connection", "connection", "keep-alive"]);

/**
 * The body's length from `Content-Length`, 0 without one; chunked request bodies are refused,
 * since the proxy relays exactly one request per connection and must know where it ends.
 */
const bodyLength = (headers: ReadonlyArray<string>): number | null => {
  if (headers.some((line) => headerName(line) === "transfer-encoding")) return null;

  const lengths = headers.flatMap((line) =>
    headerName(line) === "content-length" ? [headerValue(line)] : []
  );

  if (lengths.length === 0) return 0;

  return lengths.length === 1 && /^\d{1,15}$/.test(lengths[0]!) ? Number(lengths[0]) : null;
};

/**
 * The origin-form request for the Host. One request per connection (`Connection: close`),
 * so the response's bytes can be relayed unread, and nothing after this request's body is
 * sent on; an upgrade keeps `Connection: Upgrade` and the whole connection.
 */
const forward = (method: string, target: string, lines: ReadonlyArray<string>): ProxyRequest => {
  const url = URL.parse(target);

  if (url === null || url.protocol !== "http:" || url.hostname === "")
    return ProxyRequest.Invalid();
  const port = url.port === "" ? 80 : Number(url.port);
  const headers = lines.slice(1).filter((line) => !DROPPED.has(headerName(line)));
  const upgrade = headers.some((line) => headerName(line) === "upgrade");
  const body = upgrade ? null : bodyLength(headers);

  if (!upgrade && body === null) return ProxyRequest.Invalid();

  const head = [
    `${method} ${url.pathname}${url.search} HTTP/1.1`,
    ...headers,
    upgrade ? "Connection: Upgrade" : "Connection: close",
    "",
    "",
  ].join("\r\n");

  return ProxyRequest.Forward({
    hostname: bare(url.hostname),
    port,
    head: Buffer.from(head, "latin1"),
    body,
  });
};

/** The request line, read only once the credential has checked out. */
export const parseRequest = (lines: ReadonlyArray<string>): ProxyRequest => {
  const [method, target, version, ...extra] = lines[0]!.split(" ");

  if (
    method === undefined ||
    target === undefined ||
    !/^HTTP\/1\.[01]$/.test(version ?? "") ||
    extra.length > 0
  )
    return ProxyRequest.Invalid();

  return method === "CONNECT" ? tunnel(target) : forward(method, target, lines);
};

/** Whether a target is an IP literal rather than a name. */
export const isIpLiteral = (hostname: string) => isIP(hostname) !== 0;

/** The statuses the proxy answers with when it doesn't relay. */
export type ProxyStatus = 400 | 403 | 502 | 503 | 504;

const REASONS: Readonly<Record<ProxyStatus, string>> = {
  400: "Bad Request",
  403: "Forbidden",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

const closing = (lines: ReadonlyArray<string>): Uint8Array =>
  Buffer.from([...lines, "Content-Length: 0", "Connection: close", "", ""].join("\r\n"));

/** A response that ends the connection. */
export const proxyResponse = (status: ProxyStatus): Uint8Array =>
  closing([`HTTP/1.1 ${status} ${REASONS[status]}`]);

/** The 407 asking for the credential, in this proxy's own realm, which `login` must name. */
export const proxyChallenge = (realm: string): Uint8Array =>
  closing([
    "HTTP/1.1 407 Proxy Authentication Required",
    `Proxy-Authenticate: Basic realm="${realm}"`,
  ]);

export type ResponseScreen = Data.TaggedEnum<{
  NeedMore: Record<never, never>;
  /** Every head through the final one, without proxy auth headers, then the rest as sent. */
  Pass: { readonly bytes: Uint8Array };
  /** A 407, an unreadable status or a misreadable head, or heads too long: the proxy answers 502. */
  Refuse: Record<never, never>;
}>;

export const ResponseScreen = Data.taggedEnum<ResponseScreen>();

/** A status code as Chromium reads a status line: any case, a little junk, any HTTP version. */
const STATUS = /http(?:\/[\d.]*)?[ \t]*(\d+)/i;

/** Headers Chromium reads only from a proxy; from the Host they'd pass for this proxy's own. */
const PROXY_AUTH_HEADER = /^proxy-authenticat(?:e|ion-info)[ \t]*:/i;

const PROXY_AUTH_NAME = /proxy-authenticat/i;

const TAB = 0x09;

const LF = 0x0a;

const CR = 0x0d;

/** Whether the head has bytes Chromium drops or splits lines at (NUL, a bare CR, other controls). */
const misreadable = (head: string) => {
  for (let i = 0; i < head.length; i++) {
    const code = head.charCodeAt(i);
    const control = code < 0x20 || code === 0x7f;

    if (control && code !== TAB && code !== LF && !(code === CR && head.charCodeAt(i + 1) === LF))
      return true;
  }

  return false;
};

const headEnd = (text: string, from: number) => {
  const crlf = text.indexOf("\n\r\n", from);
  const lf = text.indexOf("\n\n", from);
  const ends = [crlf === -1 ? -1 : crlf + 3, lf === -1 ? -1 : lf + 2].filter((at) => at !== -1);

  return ends.length === 0 ? -1 : Math.min(...ends);
};

/** A head without its proxy auth headers, and without the lines folded into them. */
const withoutProxyAuth = (head: string) => {
  let dropping = false;

  return head
    .split("\n")
    .filter((line, index) => {
      dropping = index > 0 && (PROXY_AUTH_HEADER.test(line) || (dropping && /^[ \t]/.test(line)));

      return !dropping;
    })
    .join("\n");
};

/**
 * Screens the start of a forwarded response, head by head through the final one: Chromium takes
 * a 407 or a proxy auth header on a proxy connection as this proxy's own, so none may pass.
 */
export const screenResponse = (bytes: Uint8Array): ResponseScreen => {
  const text = Buffer.from(bytes).toString("latin1");
  const heads: Array<string> = [];

  for (let at = 0; ;) {
    const end = headEnd(text, at);

    if (end === -1)
      return bytes.length > MAX_HEAD_BYTES ? ResponseScreen.Refuse() : ResponseScreen.NeedMore();
    const head = text.slice(at, end);
    const code = Number(STATUS.exec(head.slice(0, head.indexOf("\n")))?.[1] ?? 0);

    const stripped = withoutProxyAuth(head);

    // Any proxy auth header left after stripping is one we misread.
    if (code === 407 || code < 100 || misreadable(head) || PROXY_AUTH_NAME.test(stripped))
      return ResponseScreen.Refuse();
    heads.push(stripped);

    // Interim heads (100 Continue, 103 Early Hints) come before the final one; 101 is final.
    if (code >= 200 || code === 101) {
      const screened = Buffer.from(heads.join(""), "latin1");

      return ResponseScreen.Pass({ bytes: Buffer.concat([screened, bytes.subarray(end)]) });
    }

    at = end;
  }
};

export const TUNNEL_ESTABLISHED: Uint8Array = Buffer.from(
  "HTTP/1.1 200 Connection Established\r\n\r\n"
);
