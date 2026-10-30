/**
 * Settings → Editor → Languages (DESIGN.md, Settings: Editor · languages; Paper L4):
 * one row per offered Language Integration on the picked Host, from its catalog and
 * `languages.host.state`. Facts the protocol doesn't give are left out, never guessed.
 */
import * as P from "@polaris/protocol";
import { Match, Predicate } from "effect";
import { LANGUAGES, LANGUAGE_IDS, type LanguageId } from "../../editor/model/language.ts";
import { rowKeyOf } from "./rowKey.ts";

type Catalog = P.LanguageCatalog;

type Integration = Catalog["integrations"][number];

type Availability = P.LanguageHostToolState;

type Requirement = Availability["prerequisites"][number]["requirement"];

/** The release gate: rows only for integrations offered on this Polaris; absent means not. */
export const offered = (integration: Integration) => integration.offered === true;

export interface Fact {
  readonly label: string;
  readonly value: string;
  readonly mono: boolean;
  readonly note?: string;
}

export interface LanguageRow {
  /** Row identity; web languages remain distinct when they share an installation. */
  readonly id: string;
  readonly name: string;
  readonly monogram: string;
  readonly state: string;
  readonly syntaxIds: ReadonlyArray<P.LanguageSyntaxId>;
  readonly facts: ReadonlyArray<Fact>;
}

export interface RowContext {
  /** "this Mac" or the Host's name, for running text. */
  readonly host: string;
  readonly downloadAutomatically: boolean;
}

const NAMES = new Map<string, string>([
  ["typescript", "TypeScript and JavaScript"],
  ["html", "HTML"],
  ["css", "CSS"],
  ["bash", "Shell"],
  ["php", "PHP"],
  ["sql", "SQL"],
  ["yaml", "YAML"],
  ["actions", "GitHub Actions"],
]);

const MONOGRAMS = new Map<string, string>([
  ["typescript", "TS"],
  ["python", "PY"],
  ["rust", "RS"],
  ["bash", "SH"],
  ["css", "{}"],
  ["html", "{}"],
  ["yaml", "YM"],
  ["actions", "YM"],
  ["prisma", "PR"],
  ["lua", "LU"],
]);

/** What the row adds after "Ready" for an integration with something to say. */
const READY_NOTES = new Map<string, string>([
  ["typescript", "uses each project's TypeScript once you trust it"],
  ["php", "uses the project's Composer and php-cs-fixer once you trust it"],
  ["go", "starts once you trust the workspace"],
]);

const ROLE_LABELS = {
  primary: "Language server",
  lint: "Linter",
  expressions: "Expressions",
} as const;

const BY_DOCUMENT_ID = new Map<string, LanguageId>(
  LANGUAGE_IDS.map((id) => [LANGUAGES[id].documentLanguageId, id])
);

const SYNTAX_IDS = new Set<string>(P.LanguageSyntaxId.literals);

const isSyntaxId = (id: string): id is P.LanguageSyntaxId => SYNTAX_IDS.has(id);

export const syntaxIdsOf = (integration: Integration): ReadonlyArray<P.LanguageSyntaxId> =>
  integration.languageIds.flatMap((documentId) => {
    const id = BY_DOCUMENT_ID.get(documentId);

    return id !== undefined && isSyntaxId(id) ? [id] : [];
  });

const nameOf = (integration: Integration) => {
  const named = NAMES.get(integration.id);

  if (named !== undefined) return named;
  const first = syntaxIdsOf(integration)[0];

  return first === undefined ? integration.id : LANGUAGES[first].name;
};

const listed = (names: ReadonlyArray<string>) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const versionOf = (availability: Availability | undefined, pinned: string) =>
  availability === undefined
    ? pinned
    : Match.value(availability.state).pipe(
        Match.tag("Installed", (installed) => installed.version),
        Match.orElse(() => availability.pinnedVersion)
      );

const versionWords = (version: string) =>
  version === "present" ? "" : version.replace(/^>=\s*/, "") + " or newer";

/** A required prerequisite the Host lacks, in words; Polaris's own tools (its Node) download. */
const missingPrerequisite = (
  facts: ReadonlyArray<Availability>,
  host: string,
  downloaded: ReadonlySet<string>
) => {
  const fact = facts
    .flatMap((availability) => availability.prerequisites)
    .find(
      (p) => p.requirement.required && p.presence === "missing" && !downloaded.has(p.requirement.id)
    );

  if (fact === undefined) return null;
  const version = versionWords(fact.requirement.version);

  return `Needs ${fact.requirement.executable}${version ? ` ${version}` : ""} on ${host}`;
};

const installState = (facts: ReadonlyArray<Availability>) => {
  const installing = facts.find((f) => Predicate.isTagged(f.state, "Downloading"));

  if (installing !== undefined) return `Setting up · downloading ${installing.toolId}`;
  const failed = facts.find((f) => Predicate.isTagged(f.state, "Failed"));

  if (failed !== undefined) return `Couldn't download ${failed.toolId}`;

  return null;
};

const notDownloaded = (
  servers: ReadonlyArray<string>,
  syntax: P.LanguageSyntaxId | undefined,
  auto: boolean
) => {
  if (!auto) return "Not downloaded yet · downloading is off";
  const extension = syntax === undefined ? undefined : LANGUAGES[syntax].extensions[0];
  const file = extension === undefined ? "file" : `.${extension} file`;
  const verb = servers.length > 1 ? "arrive" : "arrives";

  return `Not downloaded yet · ${listed(servers)} ${verb} with your first ${file}`;
};

/** A developer tool is never downloaded: it is ready once its Prerequisites are on the Host. */
const ready = (fact: Availability, developer: ReadonlySet<string>) =>
  Predicate.isTagged(fact.state, "Installed") ||
  (developer.has(fact.toolId) &&
    fact.prerequisites.every((p) => !p.requirement.required || p.presence === "present"));

const stateOf = (
  integrationId: string,
  servers: ReadonlyArray<string>,
  syntaxIds: ReadonlyArray<P.LanguageSyntaxId>,
  facts: ReadonlyArray<Availability>,
  context: RowContext,
  developer: ReadonlySet<string>,
  downloaded: ReadonlySet<string>
) => {
  const urgent = installState(facts) ?? missingPrerequisite(facts, context.host, downloaded);

  if (urgent !== null) return urgent;

  if (facts.length > 0 && facts.every((f) => ready(f, developer))) {
    const note = READY_NOTES.get(integrationId);

    return note === undefined ? "Ready" : `Ready · ${note}`;
  }

  return facts.length === 0
    ? "Not checked yet"
    : notDownloaded(servers, syntaxIds[0], context.downloadAutomatically);
};

const runtimeFact = (
  requirement: Requirement,
  availability: ReadonlyMap<string, Availability>,
  tools: ReadonlyMap<string, Catalog["tools"][number]>,
  prerequisite: Availability["prerequisites"][number] | undefined,
  host: string
): Fact => {
  const managed = tools.get(requirement.executable);

  if (managed !== undefined)
    return {
      label: "Runs on",
      value: `${requirement.executable} ${versionOf(availability.get(managed.id), managed.version)}`,
      mono: true,
      note: "Polaris's own",
    };

  const detected = prerequisite?.version ?? null;

  return {
    label: "Runs on",
    value: detected === null ? requirement.executable : `${requirement.executable} ${detected}`,
    mono: true,
    note: Match.value(prerequisite?.presence ?? "unknown").pipe(
      Match.when("present", () => `from ${host}`),
      Match.when("missing", () => `not found on ${host}`),
      Match.orElse(() => `not checked on ${host}`)
    ),
  };
};

const FORMATTER_NOTES = {
  managed: "pinned by Polaris, using the project's config",
  developer: "yours, on the host",
  configured: "set under Advanced",
} as const;

const factsOf = (
  group: ReadonlyArray<Integration>,
  catalog: Catalog,
  availability: ReadonlyMap<string, Availability>,
  host: string
): ReadonlyArray<Fact> => {
  const tools = new Map(catalog.tools.map((tool) => [tool.id, tool]));

  const providers = [
    ...new Map(group.flatMap((i) => i.providers).map((p) => [p.tool, p])).values(),
  ];

  const facts: Fact[] = [];

  for (const provider of providers) {
    const tool = tools.get(provider.tool);

    if (tool === undefined) continue;
    facts.push(
      tool.distribution === "developer"
        ? {
            label: ROLE_LABELS[provider.role],
            value: tool.id,
            mono: true,
            note: `yours, on ${host}`,
          }
        : {
            label: ROLE_LABELS[provider.role],
            value: `${tool.id} ${versionOf(availability.get(tool.id), tool.version)}`,
            mono: true,
          }
    );
  }

  const older = group.some((i) => i.id === "typescript")
    ? tools.get("typescript-language-server")
    : undefined;

  if (older !== undefined)
    facts.push({
      label: "TypeScript 6 and older",
      value: `${older.id} ${versionOf(availability.get(older.id), older.version)}`,
      mono: true,
      note: "after Trust, on Polaris's own Node",
    });

  const primary = tools.get(providers[0]?.tool ?? "");
  const server = primary?.requirements.find((r) => r.scope === "server");

  if (primary !== undefined && server !== undefined) {
    const prerequisite = availability
      .get(primary.id)
      ?.prerequisites.find((p) => p.requirement.id === server.id);

    facts.push(runtimeFact(server, availability, tools, prerequisite, host));
  }

  const formatter = group[0]?.formatter;

  if (formatter !== undefined)
    facts.push({
      label: "Formatter",
      value: formatter.tool,
      mono: true,
      note: FORMATTER_NOTES[formatter.source],
    });

  return facts;
};

export const languageRows = (
  catalog: Catalog,
  availability: ReadonlyArray<Availability>,
  context: RowContext
): ReadonlyArray<LanguageRow> => {
  const byTool = new Map(availability.map((a) => [a.toolId, a]));

  const developer = new Set(
    catalog.tools.filter((tool) => tool.distribution === "developer").map((tool) => tool.id)
  );

  const downloaded = new Set(
    catalog.tools.filter((tool) => tool.distribution !== "developer").map((tool) => tool.id)
  );

  const groups = new Map<string, Integration[]>();

  for (const integration of catalog.integrations.filter(offered)) {
    const key = rowKeyOf(integration);

    groups.set(key, [...(groups.get(key) ?? []), integration]);
  }

  return [...groups.entries()].flatMap(([key, group]) => {
    const first = group[0];

    if (first === undefined) return [];
    const syntaxIds = [...new Set(group.flatMap(syntaxIdsOf))];
    const servers = [...new Set(group.flatMap((i) => i.providers.map((p) => p.tool)))];

    const facts = servers.flatMap((id) => {
      const fact = byTool.get(id);

      return fact === undefined ? [] : [fact];
    });

    const row: LanguageRow = {
      id: key,
      name: listed([...new Set(group.map(nameOf))].sort((a, b) => a.length - b.length)),
      monogram: MONOGRAMS.get(first.id) ?? nameOf(first).slice(0, 2).toUpperCase(),
      state: stateOf(first.id, servers, syntaxIds, facts, context, developer, downloaded),
      syntaxIds,
      facts: factsOf(group, catalog, byTool, context.host),
    };

    return [row];
  });
};

/** Most-used first, so the foot line names the languages people look for. */
const SYNTAX_ORDER: ReadonlyArray<LanguageId> = [
  "python",
  "go",
  "rust",
  "java",
  "csharp",
  "c",
  "cpp",
  "ruby",
];

const NOT_LANGUAGES = new Set<LanguageId>(["markdown", "plain", "diff"]);

/** Languages the editor highlights that no offered integration serves (Markdown has its own row). */
export const syntaxOnly = (catalog: Catalog): ReadonlyArray<string> => {
  const served = new Set<string>(catalog.integrations.filter(offered).flatMap(syntaxIdsOf));
  const rank = (id: LanguageId) => SYNTAX_ORDER.indexOf(id) >>> 0;

  return LANGUAGE_IDS.filter((id) => !served.has(id) && !NOT_LANGUAGES.has(id))
    .sort((a, b) => rank(a) - rank(b))
    .map((id) => LANGUAGES[id].name);
};

/** The Languages card's footer (SR-02): "Java · C# · C · C++ +12 highlight only". */
export const syntaxOnlyLine = (names: ReadonlyArray<string>) => {
  if (names.length === 0) return null;
  const more = names.length > 4 ? ` +${names.length - 4}` : "";

  return `${names.slice(0, 4).join(" · ")}${more} highlight only`;
};

/** Off means every language of the row has an explicit empty provider list. */
export const rowEnabled = (
  row: LanguageRow,
  records: Readonly<Partial<Record<P.LanguageSyntaxId, P.LanguageSettingsPatch>>>
) =>
  row.syntaxIds.length === 0 || !row.syntaxIds.every((id) => records[id]?.providers?.length === 0);
