/** Fixture logs for the Usage index tests: Claude transcripts and Codex rollouts on disk. */
import { tempDir } from "../platform/tempDir.testing.ts";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export interface FixtureHost {
  readonly root: string;
  readonly home: string;
  readonly env: Record<string, string>;
  readonly claudeProjects: string;
  readonly codexSessions: string;
  /** Appends each value as one JSON line; returns `path`. */
  readonly append: (path: string, ...lines: ReadonlyArray<object>) => string;
  /** Appends raw text as one line (malformed lines, huge lines). */
  readonly appendText: (path: string, text: string) => string;
  readonly cleanup: () => void;
}

const appendLine = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${text}\n`);

  return path;
};

export const fixtureHost = (): FixtureHost => {
  const root = tempDir("polaris-usage-");
  const home = join(root, "home");
  const claudeProjects = join(home, ".claude", "projects");
  const codexSessions = join(home, ".codex", "sessions");
  mkdirSync(claudeProjects, { recursive: true });
  mkdirSync(codexSessions, { recursive: true });

  return {
    root,
    home,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    claudeProjects,
    codexSessions,
    append: (path, ...lines) =>
      appendLine(path, lines.map((line) => JSON.stringify(line)).join("\n")),
    appendText: (path, text) => appendLine(path, text),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

export interface ClaudeFixture {
  readonly session?: string;
  readonly ts: string;
  readonly msg?: string;
  readonly req?: string | null;
  readonly model?: string;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly sidechain?: boolean;
  readonly speed?: string;
  /** Of `cacheWrite`, the part cached for an hour (written as the 5m / 1h split). */
  readonly cacheWrite1h?: number;
  readonly costUSD?: number;
}

interface ClaudeLineJson {
  type: "assistant";
  sessionId: string;
  timestamp: string;
  version: string;
  requestId?: string;
  isSidechain?: boolean;
  costUSD?: number;
  message: {
    id: string;
    model: string;
    role: "assistant";
    content: ReadonlyArray<{ type: "text"; text: string }>;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
      cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
      speed?: string;
    };
  };
}

/** One assistant line of a Claude Code transcript. */
export const claudeLine = (f: ClaudeFixture): ClaudeLineJson => {
  const line: ClaudeLineJson = {
    type: "assistant",
    sessionId: f.session ?? "s1",
    timestamp: f.ts,
    version: "2.1.284",
    message: {
      id: f.msg ?? "msg_1",
      model: f.model ?? "claude-opus-5-5",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      usage: {
        input_tokens: f.input ?? 10,
        output_tokens: f.output ?? 20,
        cache_read_input_tokens: f.cacheRead ?? 100,
        cache_creation_input_tokens: f.cacheWrite ?? 5,
      },
    },
  };

  if (f.req !== null) line.requestId = f.req ?? `req_${f.msg ?? "1"}`;

  if (f.sidechain !== undefined) line.isSidechain = f.sidechain;

  if (f.costUSD !== undefined) line.costUSD = f.costUSD;

  if (f.speed !== undefined) line.message.usage.speed = f.speed;

  if (f.cacheWrite1h !== undefined) {
    line.message.usage.cache_creation = {
      ephemeral_5m_input_tokens: (f.cacheWrite ?? 5) - f.cacheWrite1h,
      ephemeral_1h_input_tokens: f.cacheWrite1h,
    };
  }

  return line;
};

interface CodexMetaPayload {
  id: string;
  timestamp: string;
  forked_from_id?: string;
}

export const codexMeta = (id: string, ts: string, forkedFrom?: string) => {
  const payload: CodexMetaPayload = { id, timestamp: ts };

  if (forkedFrom !== undefined) payload.forked_from_id = forkedFrom;

  return { timestamp: ts, type: "session_meta", payload };
};

export const codexTurnContext = (ts: string, model: string) => ({
  timestamp: ts,
  type: "turn_context",
  payload: { model },
});

export interface CodexUsageFixture {
  readonly input: number;
  readonly cached?: number;
  readonly output: number;
  readonly reasoning?: number;
}

const codexUsage = (u: CodexUsageFixture) => ({
  input_tokens: u.input,
  cached_input_tokens: u.cached ?? 0,
  output_tokens: u.output,
  reasoning_output_tokens: u.reasoning ?? 0,
  total_tokens: u.input + u.output,
});

interface CodexTokenInfo {
  total_token_usage: ReturnType<typeof codexUsage>;
  last_token_usage?: ReturnType<typeof codexUsage>;
}

/** A `token_count` event: the cumulative total, and optionally this Turn's delta. */
export const codexTokenCount = (ts: string, total: CodexUsageFixture, last?: CodexUsageFixture) => {
  const info: CodexTokenInfo = { total_token_usage: codexUsage(total) };

  if (last !== undefined) info.last_token_usage = codexUsage(last);

  return { timestamp: ts, type: "event_msg", payload: { type: "token_count", info } };
};

/** Codex's thread settings event: the service tier later Turns run at. */
export const codexSettings = (ts: string, serviceTier: string) => ({
  timestamp: ts,
  type: "event_msg",
  payload: { type: "thread_settings_applied", thread_settings: { service_tier: serviceTier } },
});
