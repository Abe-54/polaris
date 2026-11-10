/** What the glasses show for each screen. */
import type { ApprovalRequest, HostView } from "@polaris/sdk";
import { type AppState, type Voice, VOICE_CHOICES } from "./app.ts";
import type { MenuItem } from "./menu.ts";
import {
  HEADER_HEIGHT,
  HEIGHT,
  type ListBox,
  MAX_TEXT,
  type Page,
  type TextBox,
  WIDTH,
} from "./page.ts";
import {
  bytesOf,
  clip,
  findRow,
  rowLabel,
  type SessionKey,
  type SessionRow,
  sessionRows,
  STATE_LABEL,
  tail,
  titleOf,
} from "./sessions.ts";

const MAX_ROWS = 20;

const VOICE_LIST_HEIGHT = 96;

const full = (content: string): Page => ({
  texts: [
    {
      id: 1,
      name: "main",
      x: 0,
      y: 0,
      width: WIDTH,
      height: HEIGHT,
      capture: true,
      content: clip(content, MAX_TEXT),
    },
  ],
  lists: [],
});

const header = (content: string): TextBox => ({
  id: 1,
  name: "header",
  x: 0,
  y: 0,
  width: WIDTH,
  height: HEADER_HEIGHT,
  capture: false,
  content: clip(content, 80),
});

const list = (items: ReadonlyArray<string>, y: number): ListBox => ({
  id: 2,
  name: "list",
  x: 0,
  y,
  width: WIDTH,
  height: HEIGHT - y,
  capture: true,
  items,
});

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const hostProblems = (hosts: ReadonlyArray<HostView>) =>
  hosts.flatMap((host) => {
    if (host.error !== null) return [`Can't reach ${host.hostName}`];

    if (!host.connected) return [`Reconnecting to ${host.hostName}…`];

    return [];
  });

const sessionsHeader = (state: AppState, rows: ReadonlyArray<SessionRow>) => {
  if (state.notice !== null) return state.notice;

  if (state.hosts.length === 0) return "Connecting…";
  const needsYou = rows.filter((row) => row.entry.session.state === "needs-you").length;

  const parts = [
    ...hostProblems(state.hosts),
    needsYou > 0
      ? `${needsYou} need${needsYou === 1 ? "s" : ""} you`
      : plural(rows.length, "agent session", "agent sessions"),
  ];

  return parts.join(" · ");
};

const sessionsPage = (state: AppState): Page => {
  const rows = sessionRows(state.hosts);
  const manyHosts = state.hosts.length > 1;

  if (rows.length === 0)
    return full(
      `${sessionsHeader(state, rows)}\n\n${state.hosts.length === 0 ? "" : "No agent sessions. Start one in Polaris."}`.trim()
    );

  return {
    texts: [header(sessionsHeader(state, rows))],
    lists: [
      list(
        rows.slice(0, MAX_ROWS).map((row) => rowLabel(row, manyHosts)),
        HEADER_HEIGHT
      ),
    ],
  };
};

/** CU4: an app approval asks "Use ‹app›?", headed input "Take mouse and keyboard?" with its app. */
const approvalLine = (approval: ApprovalRequest): string => {
  const app = approval.app?.name;

  switch (approval.kind) {
    case "app":
      return app === undefined ? `${approval.title}?` : `Use ${app}?`;
    case "headed-input":
      return app === undefined ? "Take mouse and keyboard?" : `Take mouse and keyboard? · ${app}`;
    case "question":
      return `Question: ${approval.title}`;
    default:
      return `Approval: ${approval.title}`;
  }
};

const sessionBody = (row: SessionRow) => {
  const { session, pendingApprovals, lastTurnPreview } = row.entry;
  const approval = pendingApprovals[0];

  if (approval !== undefined)
    return [
      approvalLine(approval),
      ...(approval.detail === null ? [] : [approval.detail]),
      ...(pendingApprovals.length > 1 ? [`and ${pendingApprovals.length - 1} more`] : []),
    ].join("\n");

  if (session.state === "failed" && session.lastError !== null)
    return `Error: ${session.lastError}`;

  if (session.lastReplyPreview) return `Last reply: ${session.lastReplyPreview}`;

  if (lastTurnPreview !== null) return `Last turn: ${lastTurnPreview}`;

  return "No turns yet";
};

/** "Idle · Plan · Mac": a planning session says so, in the Desktop App's word. */
const statusLine = (row: SessionRow) =>
  [
    STATE_LABEL[row.entry.session.state],
    ...(row.entry.session.permissionMode === "plan" ? ["Plan"] : []),
    row.hostName,
  ].join(" · ");

const SESSION_HINT = "Tap: actions · hold: speak · double-tap: back";

const sessionPage = (state: AppState, row: SessionRow): Page => {
  const top = [
    clip(titleOf(row.entry), 200),
    clip(statusLine(row), 200),
    ...(state.notice === null ? [] : [clip(state.notice, 200)]),
  ].join("\n");

  const bottom = `\n\n${SESSION_HINT}`;

  return full(
    `${top}\n\n${clip(sessionBody(row), MAX_TEXT - bytesOf(top) - bytesOf(bottom) - 2)}${bottom}`
  );
};

const menuPage = (row: SessionRow, items: ReadonlyArray<MenuItem>): Page =>
  items.length === 0
    ? full(`${titleOf(row.entry)}\n\nNothing to do here now.\n\nDouble-tap: back`)
    : {
        texts: [header(titleOf(row.entry))],
        lists: [
          list(
            items.map((item) => item.label),
            HEADER_HEIGHT
          ),
        ],
      };

const heard = (voice: Voice) => `${voice.finalText}${voice.interimText}`.trim();

const voicePage = (voice: Voice): Page => {
  const text = tail(heard(voice), 600);

  switch (voice.phase) {
    case "listening":
      return full(`Listening · release or tap to stop\n\n${text}`.trim());
    case "finishing":
      return full(`Finishing…\n\n${text}`.trim());
    case "review":
    case "failed": {
      const body =
        voice.phase === "review" ? tail(voice.finalText.trim(), 300) : (voice.error ?? "");

      const y = HEIGHT - VOICE_LIST_HEIGHT;

      return {
        texts: [{ ...header(""), height: y, content: clip(body, MAX_TEXT) }],
        lists: [list(VOICE_CHOICES[voice.phase], y)],
      };
    }
  }
};

const UNPAIRED = [
  "Pair with Polaris",
  "",
  "Open this app on your phone in the Even app, then scan or paste a pairing string from Polaris: Settings → Extensions.",
].join("\n");

const rowFor = (state: AppState, key: SessionKey) => findRow(state.hosts, key);

export const layout = (state: AppState): Page => {
  if (!state.paired) return full(UNPAIRED);
  const screen = state.screen;

  if (screen.kind === "sessions") return sessionsPage(state);
  const row = rowFor(state, screen.key);

  if (row === undefined) return sessionsPage(state);

  switch (screen.kind) {
    case "session":
      return sessionPage(state, row);
    case "menu":
      return menuPage(row, screen.items);
    case "voice":
      return voicePage(screen.voice);
  }
};
