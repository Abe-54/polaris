import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const importUrl = (path: string) => {
  if (path.startsWith("file:")) return pathToFileURL(fileURLToPath(path)).href;

  return isAbsolute(path) ? pathToFileURL(path).href : path;
};

const tokenMatches = (options: string) => [...options.matchAll(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g)];

const tokens = (options: string) =>
  [...options.matchAll(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g)].map(([token]) =>
    token.replace(/"((?:\\.|[^"\\])*)"/g, (_match, value: string) => value.replace(/\\(.)/g, "$1"))
  );

/** Append one quoted Node preload, preserving other options and equivalent existing imports. */
export const appendNodeImport = (options: string | undefined, path: string): string => {
  const target = importUrl(path);

  if (isInstrumentationImport(target)) options = stripNodeInstrumentation(options ?? "");
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

const isInstrumentationImport = (value: string) =>
  value.includes("#polaris-instrumentation=") ||
  /[/\\]node-instrumentation[/\\][^/\\]+[/\\]register\.mjs(?:[?#]|$)/.test(value);

/** Fail soft even if a shell outlives extraction, or inherits this path inside a container. */
export const instrumentationImport = (path: string) => {
  const url = importUrl(path);
  const code = `await import(${JSON.stringify(url)}).catch(()=>{})`;

  return `data:text/javascript,${encodeURIComponent(code)}#polaris-instrumentation=${encodeURIComponent(url)}`;
};

export const stripNodeInstrumentation = (options: string) => {
  const matches = tokenMatches(options);
  const args = tokens(options);
  const removed = new Set<number>();

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const separate = arg === "--import";
    const value = separate ? args[index + 1] : arg.slice("--import=".length);

    if ((separate || arg.startsWith("--import=")) && value && isInstrumentationImport(value)) {
      removed.add(index);

      if (separate) removed.add(index + 1);
    }
  }

  if (removed.size === 0) return options;

  let result = "";
  let end = 0;

  for (const [index, match] of matches.entries()) {
    result += options.slice(end, match.index);

    if (!removed.has(index)) result += match[0];

    end = match.index + match[0].length;
  }

  return (result + options.slice(end)).trim();
};
