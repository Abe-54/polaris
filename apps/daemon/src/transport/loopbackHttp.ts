/** Shared DNS-rebinding and browser-origin checks for the Daemon's local HTTP listeners. */
const safeOrigin = (request: Request): boolean => {
  const origin = request.headers.get("origin");

  if (origin === null) return true;

  try {
    const url = new URL(origin);

    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.host === new URL(request.url).host
    );
  } catch {
    return false;
  }
};

export const loopbackRequest = (
  request: Request,
  options: {
    readonly port?: number;
    readonly localhost?: boolean;
    readonly rejectOrigin?: boolean;
  } = {}
): boolean => {
  const url = new URL(request.url);

  if (url.protocol !== "http:") return false;

  if (url.hostname !== "127.0.0.1" && !(options.localhost && url.hostname === "localhost"))
    return false;

  if (options.port !== undefined && url.port !== String(options.port)) return false;
  const host = request.headers.get("host");

  if (host !== null && host !== url.host) return false;

  return options.rejectOrigin ? !request.headers.has("origin") : safeOrigin(request);
};
