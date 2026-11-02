/**
 * Linear's GraphQL API as the ci-red OAuth app: a client-credentials token per run, never stored.
 * The scopes stay fixed, since requesting others revokes the app's other tokens.
 */
import { Schema } from "effect";
import type { Fetch } from "./github.ts";
import { type OpenIssue, TITLE_PREFIX } from "./plan.ts";

export const TOKEN_URL = "https://api.linear.app/oauth/token";

export const GRAPHQL_URL = "https://api.linear.app/graphql";

export const SCOPES = "read,issues:create,comments:create";

export const TEAM_KEY = "ENG";

export const PROJECT_NAME = "Polaris";

export const LABEL_NAME = "ci-red";

const Token = Schema.Struct({ access_token: Schema.String });

const decodeToken = Schema.decodeUnknownSync(Token);

/** A token for this run, from the app's client id and secret (HTTP Basic). */
export const requestToken = async (
  clientId: string,
  clientSecret: string,
  fetch: Fetch
): Promise<string> => {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPES }).toString(),
  });

  if (!response.ok)
    throw new Error(`Linear token: HTTP ${response.status} ${await response.text()}`);

  return decodeToken(await response.json()).access_token;
};

const Nodes = <S extends Schema.Top>(node: S) => Schema.Struct({ nodes: Schema.Array(node) });

const Id = Schema.Struct({ id: Schema.String });

const Team = Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String });

const Comment = Schema.Struct({ body: Schema.String, createdAt: Schema.String });

const Issue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  comments: Nodes(Comment),
});

export const ContextData = Schema.Struct({
  teams: Nodes(Team),
  projects: Nodes(Id),
  issueLabels: Nodes(Id),
  issues: Nodes(Issue),
});

export type ContextData = typeof ContextData.Type;

const Errors = Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String })));

const decodeContext = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ data: Schema.optional(ContextData), errors: Errors }))
);

const decodeMutation = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ errors: Errors }))
);

const CONTEXT = `query CiRedContext($team: String!, $project: String!, $label: String!, $prefix: String!) {
  teams(filter: { key: { eq: $team } }) { nodes { id key name } }
  projects(filter: { name: { eq: $project } }) { nodes { id } }
  issueLabels(filter: { name: { eq: $label } }) { nodes { id } }
  issues(first: 100, filter: {
    team: { key: { eq: $team } }
    title: { startsWith: $prefix }
    state: { type: { nin: ["completed", "canceled"] } }
  }) { nodes { id identifier title url comments(first: 100) { nodes { body createdAt } } } }
}`;

const CREATE_ISSUE = `mutation CiRedIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { identifier url } }
}`;

const CREATE_COMMENT = `mutation CiRedComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

/** Where new issues go, and the open ci-red issues. */
export interface LinearContext {
  readonly teamId: string;
  readonly projectId: string | undefined;
  readonly labelId: string | undefined;
  readonly open: ReadonlyArray<OpenIssue>;
}

const latest = (comments: ReadonlyArray<typeof Comment.Type>) =>
  comments.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.body;

export const toContext = (data: ContextData): LinearContext => {
  const team = data.teams.nodes.find((node) => node.key === TEAM_KEY);

  if (!team) throw new Error(`Linear: no team with key ${TEAM_KEY} is visible to the app`);
  console.log(`Linear team ${team.key} (${team.name}): ${team.id}`);

  return {
    teamId: team.id,
    projectId: data.projects.nodes[0]?.id,
    labelId: data.issueLabels.nodes[0]?.id,
    open: data.issues.nodes.map(({ comments, ...issue }) => ({
      ...issue,
      lastComment: latest(comments.nodes),
    })),
  };
};

export interface IssueInput {
  readonly teamId: string;
  readonly title: string;
  readonly description: string;
  readonly projectId: string | undefined;
  readonly labelIds: ReadonlyArray<string> | undefined;
}

interface CommentInput {
  readonly issueId: string;
  readonly body: string;
}

type Variables = Readonly<Record<string, string>> | { readonly input: IssueInput | CommentInput };

/** The GraphQL calls the ci-red script makes. */
export interface Linear {
  readonly context: () => Promise<LinearContext>;
  readonly createIssue: (input: IssueInput) => Promise<void>;
  readonly comment: (issueId: string, body: string) => Promise<void>;
}

export const linearClient = (token: string, fetch: Fetch): Linear => {
  /** The response's JSON text, for the caller's schema. */
  const post = async (query: string, variables: Variables): Promise<string> => {
    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) throw new Error(`Linear: HTTP ${response.status} ${await response.text()}`);

    return response.text();
  };

  const mutate = async (query: string, input: IssueInput | CommentInput) => {
    const { errors } = decodeMutation(await post(query, { input }));

    if (errors?.length) throw new Error(`Linear: ${errors.map((e) => e.message).join("; ")}`);
  };

  return {
    context: async () => {
      const variables = {
        team: TEAM_KEY,
        project: PROJECT_NAME,
        label: LABEL_NAME,
        prefix: TITLE_PREFIX,
      };

      const { data, errors } = decodeContext(await post(CONTEXT, variables));

      if (!data || errors?.length)
        throw new Error(`Linear: ${errors?.map((e) => e.message).join("; ") ?? "no data"}`);

      return toContext(data);
    },
    createIssue: (input) => mutate(CREATE_ISSUE, input),
    comment: (issueId, body) => mutate(CREATE_COMMENT, { issueId, body }),
  };
};
