export const unquote = (value: string) => {
  const trimmed = value.trim();

  const quoted = /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*(?:#.*)?$/.exec(trimmed)?.[1];

  if (quoted) return quoted.slice(1, -1);

  return trimmed.replace(/\s+#.*$/, "").trim();
};

/** A small literal reader: dynamic code, calls, spreads and interpolated strings are ignored. */
export const properties = (text: string) => {
  const result: Record<string, string> = {};

  const pattern =
    /(?:^|[,;\n])\s*(?:["']([\w]+)["']|\b([\w]+))\s*[:=]\s*(?:"([^"\n]*)"|'([^'\n]*)'|\b(\d+)\b)(?=\s*(?:[,;\n]|$))/g;

  for (const match of text.matchAll(pattern)) {
    const value = match[3] ?? match[4] ?? match[5];
    const key = match[1] ?? match[2];

    if (key && value !== undefined && !value.includes("${")) result[key] = value;
  }

  return result;
};

/** A target containing an expression must not fall back to a different, local target. */
export const literalTarget = (text: string) => {
  const fields = properties(text);

  const keys = [
    ...text.matchAll(
      /(?:^|[,;\n])\s*["']?(ENGINE|NAME|USER|PASSWORD|HOST|PORT|url|host|port|user|username|password|database)["']?\s*:/g
    ),
  ];

  if (keys.some((match) => match[1] && fields[match[1]] === undefined)) return undefined;

  return fields;
};

/** Balanced blocks keep one database's fields from being mixed with the next one's. */
export const blocks = (text: string): string[] => {
  const result: string[] = [];
  let start = -1;
  let depth = 0;
  let quote = "";

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") {
      if (depth++ === 0) start = i + 1;
    } else if (char === "}" && --depth === 0) result.push(text.slice(start, i));
  }

  return result;
};

/** Resume after a block, including an unterminated one, so malformed input is scanned once. */
export const namedBlocks = (text: string, pattern: RegExp) => {
  const result: { name: string; body: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    const start = pattern.lastIndex;
    const end = blockEnd(text, start);
    pattern.lastIndex = end;

    if (end <= text.length && match[1])
      result.push({ name: match[1], body: text.slice(start, end - 1) });
  }

  return result;
};

const blockEnd = (text: string, start: number) => {
  let depth = 1;
  let quote = "";

  for (let end = start; end < text.length; end++) {
    const char = text[end];

    if (quote) {
      if (char === "\\") end++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return end + 1;
  }

  return text.length + 1;
};
