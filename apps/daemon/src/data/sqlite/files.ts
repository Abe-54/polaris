/** SQLite file URLs (`file:`, `sqlite:`) and where their files are relative to the checkout. */
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The scheme a configuration value uses for a SQLite file. */
export const isSqliteUrl = (url: string) => /^(?:file|sqlite3?):/i.test(url.trim());

/**
 * The absolute file a `file:` or `sqlite:` URL names, resolving a relative path against `base`.
 * Undefined for in-memory databases, interpolated values and relative paths without a base.
 */
export function sqliteFile(url: string, base?: string): string | undefined {
  const match = /^(?:file|sqlite3?):(.*)$/is.exec(url.trim());

  if (!match) return undefined;
  let path = match[1]!.split(/[?#]/)[0]!;

  if (path.startsWith("//localhost/")) path = path.slice("//localhost".length);
  else if (path.startsWith("//")) path = path.slice(2);

  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }

  if (!path || path === ":memory:" || /[\0\r\n]/.test(path) || /\$(?:\{|[A-Za-z_])/.test(path))
    return undefined;

  if (isAbsolute(path)) return resolve(path);

  return base === undefined ? undefined : resolve(base, path);
}

/** Symlinks resolve first, so a link inside the checkout to a file elsewhere is not Local. */
export async function realFile(file: string) {
  try {
    return await realpath(file);
  } catch {
    try {
      return join(await realpath(dirname(file)), basename(file));
    } catch {
      return file;
    }
  }
}

/** A SQLite file inside the (real) checkout is a Local Data Source; anywhere else is Remote. */
export async function fileLocality(checkout: string, file: string): Promise<"local" | "remote"> {
  const path = relative(checkout, await realFile(file));

  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
    ? "local"
    : "remote";
}
