/**
 * The VARIABLES footer (DESIGN.md, Requests → Request pane; Paper Q1): each variable the open
 * Request uses as the Daemon resolves it, "local origin" where it applies, secrets masked.
 */
import type { ResolvedVariable } from "@polaris/protocol";
import type { Loaded } from "../../data/hooks.tsx";

const SOURCE = {
  env: "http-client.env.json",
  dotenv: ".env",
  file: "this file",
} as const;

const Value = ({ variable }: { readonly variable: ResolvedVariable }) => {
  if (variable.masked)
    return (
      <span className="text-caption text-text-subtle min-w-0 truncate font-mono">
        {`•••••••• from ${SOURCE[variable.source]}`}
      </span>
    );

  if (variable.value === undefined)
    return <span className="text-caption text-text-faint min-w-0 truncate">not set</span>;

  return (
    <span
      className="text-caption text-text-default min-w-0 truncate font-mono"
      title={variable.value}
    >
      {variable.value}
    </span>
  );
};

const Row = ({ variable }: { readonly variable: ResolvedVariable }) => (
  <div className="gap-row-x flex h-6 shrink-0 items-center" data-testid="requests-variable">
    <span
      className="text-caption text-starlight w-40 shrink-0 truncate font-mono"
      title={variable.name}
    >
      {variable.name}
    </span>
    <Value variable={variable} />
    {variable.origin === undefined ? null : (
      <span className="text-caption text-text-faint shrink-0">{`${variable.origin} origin`}</span>
    )}
  </div>
);

export const Variables = ({
  environment,
  variables,
}: {
  readonly environment: string | null;
  readonly variables: Loaded<ReadonlyArray<ResolvedVariable>>;
}) => {
  if (variables.status === "ready" && variables.value.length === 0) return null;

  return (
    <section
      aria-label="Variables"
      className="border-hairline px-panel flex max-h-[30%] shrink-0 flex-col gap-1 overflow-y-auto border-t pt-3 pb-3.5"
      data-testid="requests-variables"
    >
      <h2 className="flex h-5 shrink-0 items-center gap-2">
        <span className="text-micro text-text-subtle font-mono font-semibold tracking-[0.06em]">
          VARIABLES
        </span>
        <span className="text-caption text-text-faint font-mono">
          {environment === null ? SOURCE.env : `${SOURCE.env} · ${environment}`}
        </span>
      </h2>
      {variables.status === "failed" ? (
        <p className="text-caption text-text-subtle">{variables.error.message}</p>
      ) : null}
      {variables.status === "ready"
        ? variables.value.map((variable) => <Row key={variable.name} variable={variable} />)
        : null}
    </section>
  );
};
