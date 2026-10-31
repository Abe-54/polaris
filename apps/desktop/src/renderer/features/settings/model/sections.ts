/** The Settings nav (DESIGN.md, Settings): its groups, their sections, and each page's one line. */
import { clientCopy } from "../../../../shared/clientCopy.ts";
import type { SettingsSection } from "../../../routes/selection.ts";

export interface SectionInfo {
  readonly id: SettingsSection;
  readonly title: string;
  /** The page's one `body` line: what it controls. */
  readonly blurb: string;
  /** Words the K menu matches on besides the title. */
  readonly keywords: ReadonlyArray<string>;
}

interface GroupSource {
  readonly title: string;
  readonly sections: ReadonlyArray<SectionInfo>;
}

const GROUPS: ReadonlyArray<GroupSource> = [
  {
    title: "General",
    sections: [
      {
        id: "appearance",
        title: "Appearance",
        blurb: `How Polaris looks on ${clientCopy().machine}. These settings stay on ${clientCopy().machine}; hosts don't share them.`,
        keywords: [
          "theme",
          "dark",
          "light",
          "density",
          "text size",
          "font",
          "motion",
          "colourblind",
        ],
      },
      {
        id: "sessions",
        title: "Sessions",
        blurb:
          "How new agent sessions start and what happens around them. Worktree setup is saved on its Host.",
        keywords: [
          "worktree",
          "setup",
          "dependencies",
          "branch",
          "prefix",
          "in place",
          "output",
          "notifications",
          "needs you",
          "review requested",
          "archive",
          "hidden",
          "remove workspace",
          "accept",
          "commit",
          "main",
        ],
      },
      {
        id: "editor",
        title: "Editor",
        blurb: `How files edit and save in Edit mode. These settings stay on ${clientCopy().machine}.`,
        keywords: [
          "vim",
          "autosave",
          "save",
          "keys",
          "code",
          "language",
          "formatter",
          "LSP",
          "trust",
          "SDK",
          "interpreter",
        ],
      },
      {
        id: "traces",
        title: "Traces",
        blurb:
          "What each workspace's traces do: copy into Polaris, forward to your collector, and instrument automatically. Saved on its host.",
        keywords: [
          "opentelemetry",
          "otel",
          "otlp",
          "tracing",
          "spans",
          "forward",
          "exporter",
          "collector",
          "axiom",
          "instrument",
          "node",
          "deno",
          "retention",
        ],
      },
    ],
  },
  {
    title: "Agents",
    sections: [
      {
        id: "harnesses",
        title: "Harnesses",
        blurb:
          "The agent programs Polaris drives on each host. Each harness keeps its own sign-in; Polaris never reads your keys or tokens.",
        keywords: ["claude", "codex", "opencode", "sign in", "model", "effort", "permissions"],
      },
      {
        id: "constellations",
        title: "Constellations",
        blurb:
          "What a lead's workers start on when it doesn't say. The lead's own choice for a task comes first; you can still change a worker afterwards.",
        keywords: [
          "constellation",
          "lead",
          "worker",
          "task",
          "backend",
          "infrastructure",
          "frontend",
          "ui",
          "design",
          "model",
        ],
      },
      {
        id: "usage",
        title: "Usage",
        blurb:
          "Tokens from every harness on every host, read from each harness's own logs. Cost is an estimate unless the harness reports it.",
        keywords: ["tokens", "cost", "plan limits", "rate limit"],
      },
    ],
  },
  {
    title: "Machines",
    sections: [
      {
        id: "hosts",
        title: "Hosts",
        blurb: "The machines Polaris connects to over SSH.",
        keywords: ["machines", "ssh", "daemon", "add a host"],
      },
      {
        id: "attachments",
        title: "Attachments",
        blurb:
          "Pasted and dropped files are staged on the host that runs the session. Choose when each host deletes them.",
        keywords: ["files", "images", "staging", "cleanup", "clear", "disk"],
      },
      {
        id: "extensions",
        title: "Extensions",
        blurb:
          "Apps and devices that act on a host for you, like Raycast or your glasses. Each pairing allows only what you grant, and you can revoke it at any time.",
        keywords: [
          "pair",
          "pairing",
          "grant",
          "token",
          "qr",
          "raycast",
          "glasses",
          "revoke",
          "sdk",
        ],
      },
      {
        id: "devices",
        title: "Devices",
        blurb:
          "Your phone, linked once, reaches every host below through the Polaris Relay. The relay carries only encrypted traffic; unlinking a device cuts it off at once.",
        keywords: ["phone", "mobile", "link", "qr", "relay", "remote", "unlink", "iphone"],
      },
      {
        id: "voice",
        title: "Voice",
        blurb:
          "Extensions that listen, such as smart glasses, send audio to a host, which transcribes it with Deepgram using that host's own key. Keys stay on their hosts and are never shown again.",
        keywords: ["deepgram", "speech", "transcription", "dictation", "microphone", "key"],
      },
    ],
  },
  {
    title: "Review",
    sections: [
      {
        id: "reviewer",
        title: "Reviewer",
        blurb:
          "The agent that writes its part of every risk summary. It reads the review checkout on the host that holds it, and never edits anything.",
        keywords: ["review", "risk summary", "model", "effort", "codex", "claude", "override"],
      },
      {
        id: "github",
        title: "GitHub accounts",
        blurb: `Accounts ${clientCopy().machine} uses to list pull requests and send reviews. Tokens stay ${clientCopy().tokenStore}; hosts fetch code with their own git credentials.`,
        keywords: ["github", "account", "owner", "organization", "sign in", "sso", "access"],
      },
    ],
  },
];

export interface SectionGroup {
  readonly title: string;
  readonly sections: ReadonlyArray<SettingsSection>;
}

export const SECTION_GROUPS: ReadonlyArray<SectionGroup> = GROUPS.map((g) => ({
  title: g.title,
  sections: g.sections.map((s) => s.id),
}));

export const SECTIONS: ReadonlyArray<SectionInfo> = [
  ...GROUPS.flatMap((g) => g.sections),
  {
    id: "about",
    title: "About",
    blurb: `Polaris on ${clientCopy().machine}.`,
    keywords: ["update", "version", "release", "restart"],
  },
];

const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

export const sectionInfo = (id: SettingsSection): SectionInfo => {
  const found = BY_ID.get(id);

  if (found === undefined) throw new Error(`no settings section ${id}`);

  return found;
};
