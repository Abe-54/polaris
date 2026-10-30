// A research lexer for the tested cases; X must implement the product boundary with regression tests.
function quoted(text, offset, quote, backslash) {
  let i = offset + 1;
  let value = "";
  while (i < text.length) {
    if (backslash && text[i] === "\\") { i += 2; continue; }
    if (text[i] !== quote) { value += text[i++]; continue; }
    if (text[i + 1] === quote) { value += quote; i += 2; continue; }
    return { end: i + 1, value };
  }
  throw new Error("Unclosed quote");
}

function blockEnd(text, offset, postgres) {
  let depth = 1;
  let i = offset + 2;
  while (i < text.length && depth) {
    if (postgres && text.slice(i, i + 2) === "/*") { depth++; i += 2; }
    else if (text.slice(i, i + 2) === "*/") { depth--; i += 2; }
    else i++;
  }
  if (depth) throw new Error("Unclosed block comment");
  return i;
}

function literalAt(text, i, postgres, noBackslashEscapes, ansiQuotes) {
  const quote = text[i];
  if (["'", '"', "`"].includes(quote)) {
    const escapedPg = /[eE]/.test(text[i - 1] ?? "") && !/[a-z0-9_$]/i.test(text[i - 2] ?? "");
    const backslash = postgres ? quote === "'" && escapedPg : !noBackslashEscapes && quote !== "`" && !(ansiQuotes && quote === '"');
    const result = quoted(text, i, quote, backslash);
    return { end: result.end, token: quote === "`" ? result.value.toUpperCase() : "LITERAL" };
  }
  if (postgres && text[i] === "$" && !/[a-z0-9_$]/i.test(text[i - 1] ?? "")) {
    const delimiter = text.slice(i).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0];
    if (delimiter) {
      const end = text.indexOf(delimiter, i + delimiter.length);
      if (end === -1) throw new Error("Unclosed dollar quote");
      return { end: end + delimiter.length, token: "LITERAL" };
    }
  }
  return null;
}

export function tokenize(text, dialect, noBackslashEscapes = false, ansiQuotes = false) {
  const postgres = dialect === "postgres";
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.slice(i, i + 2) === "/*") {
      if (!postgres && /^\/\*(?:!|[mM]!)/.test(text.slice(i))) throw new Error("Executable comment");
      i = blockEnd(text, i, postgres); continue;
    }
    const lineComment = text.slice(i, i + 2) === "--" && (postgres || /\s/.test(text[i + 2] ?? " "));
    if (lineComment || (!postgres && text[i] === "#")) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1; continue;
    }
    const literal = literalAt(text, i, postgres, noBackslashEscapes, ansiQuotes);
    if (literal) { tokens.push(literal.token); i = literal.end; continue; }
    const word = text.slice(i).match(/^[a-z_][a-z0-9_$]*/i)?.[0];
    tokens.push(word ? word.toUpperCase() : text[i]);
    i += word?.length ?? 1;
  }
  return tokens;
}

export function strictGuard(text, dialect, noBackslashEscapes = false, ansiQuotes = false) {
  try {
    const tokens = tokenize(text, dialect, noBackslashEscapes, ansiQuotes);
    const semicolons = tokens.filter(token => token === ";").length;
    if (semicolons > 1 || (semicolons === 1 && tokens.at(-1) !== ";")) return false;
    if (!tokens.length) return false;
    if (dialect === "postgres") return true;
    const first = tokens.find(token => token !== "(");
    if (!["SELECT", "WITH", "TABLE", "VALUES", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"].includes(first)) return false;
    if (tokens.includes("LOAD_FILE")) return false;
    return !tokens.some((token, i) => token === "INTO" && ["OUTFILE", "DUMPFILE"].includes(tokens[i + 1]));
  } catch { return false; }
}

export function combinedGuard(text, sqlMode) {
  if (/\/\*!|\/\*\+|OUTFILE|DUMPFILE|LOAD_FILE/i.test(text)) return false;
  if (sqlMode === null && /[\\"]/.test(text)) return false;
  const modes = new Set((sqlMode ?? "").split(","));
  return strictGuard(text, "mysql", modes.has("NO_BACKSLASH_ESCAPES"), modes.has("ANSI_QUOTES"));
}
