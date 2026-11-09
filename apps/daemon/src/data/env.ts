import { unquote } from "./literals.ts";

/** The env files a directory's tools load, later ones over earlier ones. */
export const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"];

/** `KEY=value` lines of a dotenv file; values that interpolate other variables are left out. */
export const envValues = (text: string) => {
  const values: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);

    if (match?.[1] && match[2] !== undefined) {
      const value = unquote(match[2]);

      if (!/\$(?:\{|[A-Za-z_])/.test(value)) values[match[1]] = value;
    }
  }

  return values;
};
