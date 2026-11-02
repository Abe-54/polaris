import type { OpenOptions } from "../../harness/HarnessDriver.ts";
import { visualizeGuidance } from "@polaris/visualization";

export const POLARIS_PREAMBLE_VERSION = 4;

type InstructionOptions = Pick<OpenOptions, "readOnly" | "constellation" | "constellations">;

const context = [
  `Polaris context · v${POLARIS_PREAMBLE_VERSION}`,
  "You are running inside Polaris, an IDE and agent orchestrator. The user watches and steers this agent session from the Desktop App.",
  "A constellation is a graph of tasks and dependencies. Its lead maps work and reviews workers' claims. A task is a unit of work; an attempt is one try. A claim reports completed work for review, not acceptance. A gate is a task that waits for all its dependencies to be accepted.",
  "Review: the user examines changes and a risk summary; the Reviewer is the chosen harness and model writing findings.",
  "Workspaces: your agent session belongs to a registered directory, usually a git repository. Follow its AGENTS.md when changing code.",
  "Hosts: each machine runs a Daemon that owns its agent sessions; hosts may be remote.",
  "Only the user grants approvals.",
  "What the user sees: images you open with view_image or Read show in the conversation, and Markdown images and links in your replies that name absolute paths on this host open in the app (images in a viewer, other files in its editor). Images a tool returns only to you, such as image() inside exec, never reach the user, and HTML files on the host don't open in its browser: show an image by viewing it or linking its path.",
];

export const sessionAttachments = (options: InstructionOptions) =>
  options.readOnly === true
    ? []
    : (options.constellations ??
      (options.constellation === undefined ? [] : [options.constellation]));

/** Short capability-aware context; role skills follow it in the same instruction field. */
export const polarisPreamble = (options: InstructionOptions): string => {
  const attachments = sessionAttachments(options);

  const name = (index: number, tool: string) =>
    `mcp__polaris${index === 0 ? "" : `_${index}`}__${tool}`;

  const plan = attachments.findIndex((a) => a.tools.some((t) => t.name === "plan"));
  const claim = attachments.findIndex((a) => a.tools.some((t) => t.name === "claim"));

  const history = attachments.findIndex((a) => a.tools.some((t) => t.name === "search_history"));

  const features: string[] = [];

  if (plan !== -1)
    features.push(
      `Constellations: the user may ask you to lead one. Call ${name(plan, "plan")} with start to create it, or operations to map its tasks; use ${name(plan, "status")} for detail. Nest related tasks with parent (F1–F3 under fix round F), to any depth; group names the broad area. Parents are containers, never workers or gates.`
    );

  if (claim !== -1)
    features.push(
      `Constellations: follow your worker assignment and submit its report with ${name(claim, "claim")}; use ${name(claim, "block")} when waiting on Tasks, ${name(claim, "waiting_on")} before ending a Turn to wait on your own background work, and ${name(claim, "ask")} for decisions or answers. Your worker skill explains the fields.`
    );

  if (history !== -1)
    features.push(
      `History: when you need earlier work from this session (lost to compaction) or from past sessions, search it with ${name(history, "search_history")} rather than guessing; open a match with ${name(history, "read_history")} and find sessions with ${name(history, "sessions")}.`
    );

  const visuals = attachments.find((a) => a.tools.some((t) => t.name === "visualize"));

  if (visuals !== undefined) features.push(visualizeGuidance(visuals.visuals ?? "rich"));

  return [...context, ...features].join("\n");
};

export const polarisInstructions = (options: InstructionOptions): string =>
  [polarisPreamble(options), ...sessionAttachments(options).map((a) => a.instructions)]
    .filter((text) => text.length > 0)
    .join("\n\n");

export const polarisContextWithoutTools = () =>
  `${polarisPreamble({})}\nConstellations need Codex or Claude Code.`;
