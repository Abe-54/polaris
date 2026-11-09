import { RequestAuth, type HttpHeader } from "@polaris/protocol";
import { Match } from "effect";

const isAuthorization = (header: HttpHeader) => header.name.toLowerCase() === "authorization";

/** `Bearer x`, or Basic as `user:password` / `user password`; base64 Basic stays a header. */
export const authFromValue = (value: string): RequestAuth | undefined => {
  const bearer = /^Bearer\s+(\S.*?)\s*$/i.exec(value);

  if (bearer?.[1]) return RequestAuth.cases.Bearer.make({ token: bearer[1] });
  const basic = /^Basic\s+(\S+?)(?::|\s+)(.*?)\s*$/i.exec(value);

  if (basic?.[1] !== undefined && basic[2] !== undefined)
    return RequestAuth.cases.Basic.make({ user: basic[1], password: basic[2] });

  return undefined;
};

/** Takes the first Authorization header out as `auth` when it is Bearer or plain Basic. */
export const authFromHeaders = (headers: ReadonlyArray<HttpHeader>) => {
  const index = headers.findIndex(isAuthorization);
  const header = headers[index];
  const auth = header ? authFromValue(header.value) : undefined;

  if (!auth) return { headers: [...headers], auth };

  return { headers: headers.filter((_, at) => at !== index), auth };
};

/** The Authorization header value for `auth`; Basic is written `user:password`, as REST Client reads it. */
export const authorizationValue = (auth: RequestAuth) =>
  Match.valueTags(auth, {
    Bearer: ({ token }) => `Bearer ${token}`,
    Basic: ({ user, password }) => `Basic ${user}:${password}`,
  });

/** Basic credentials encoded for the wire, once variables are resolved. */
export const encodedAuthorization = (auth: RequestAuth) =>
  Match.valueTags(auth, {
    Bearer: ({ token }) => `Bearer ${token}`,
    Basic: ({ user, password }) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
  });
