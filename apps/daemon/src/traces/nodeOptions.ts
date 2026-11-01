import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const importUrl = (path: string) => {
  if (path.startsWith("file:")) return pathToFileURL(fileURLToPath(path)).href;

  return isAbsolute(path) ? pathToFileURL(path).href : path;
};

const tokens = (options: string) =>
  [...options.matchAll(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g)].map(([token]) =>
    token.replace(/"((?:\\.|[^"\\])*)"/g, (_match, value: string) => value.replace(/\\(.)/g, "$1"))
  );

/** Append one quoted Node preload, preserving other options and equivalent existing imports. */
export const appendNodeImport = (options: string | undefined, path: string): string => {
  const target = importUrl(path);
  const args = tokens(options ?? "");

  const exists = args.some((arg, index) => {
    const value = arg === "--import" ? args[index + 1] : arg.replace(/^--import=/, "");

    return (
      (arg === "--import" || arg.startsWith("--import=")) &&
      value !== undefined &&
      importUrl(value) === target
    );
  });

  if (exists) return options ?? "";

  return `${options ? `${options} ` : ""}--import ${JSON.stringify(target)}`;
};
