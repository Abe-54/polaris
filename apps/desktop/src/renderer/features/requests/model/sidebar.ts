/**
 * The Requests tab's list (DESIGN.md, Requests → Sidebar): one group per file, filtered by the
 * well's words against method, name, URL and file.
 */
import type { HttpRequest, RequestFile } from "@polaris/protocol";

export interface FileGroup {
  readonly path: string;
  readonly requests: ReadonlyArray<HttpRequest>;
  /** Lines the Daemon couldn't read as a Request. */
  readonly parseErrors: number;
}

const matches = (request: HttpRequest, words: ReadonlyArray<string>) => {
  const haystack = `${request.method} ${request.name} ${request.url} ${request.file}`.toLowerCase();

  return words.every((word) => haystack.includes(word));
};

/** Files in path order; with a filter, only files with a matching Request, holding just those. */
export const fileGroups = (
  files: ReadonlyArray<RequestFile>,
  filter: string
): ReadonlyArray<FileGroup> => {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);

  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({
      path: file.path,
      requests: file.requests.filter((r) => matches(r, words)),
      parseErrors: file.parseErrors.length,
    }))
    .filter((group) => words.length === 0 || group.requests.length > 0);
};

export const requestCount = (files: ReadonlyArray<RequestFile>) =>
  files.reduce((n, file) => n + file.requests.length, 0);

export const filesLabel = (n: number) => (n === 1 ? "1 file" : `${n} files`);
