/**
 * The host page's Resources… (spec §8): its resources with who holds each, the queue, Release
 * past the hold limit, Add and Remove. Workers at once is Capacity's own stepper. Hidden on a
 * Daemon that doesn't manage resources.
 */
import type { ResourceLease } from "@polaris/protocol";
import { Button, cn, Input } from "@polaris/ui";
import { useMemo, useState } from "react";
import { age } from "../../../shell/copy.ts";
import { useApp } from "../../../shell/hooks.ts";
import { useNow } from "../../../shell/useNow.ts";
import type { Plain } from "../../../store/plain.ts";
import { useAllConstellations } from "../../sessions/source.ts";
import {
  holdLine,
  RESOURCE_NAME,
  resourceRows,
  type ResourceRow,
  validCapacity,
} from "../model/resources.ts";
import { useHostResources } from "../resources.ts";

type Run = ReturnType<typeof useHostResources>["run"];

/** A lease's holder: its Attempt's Task id, else its session's title. */
const useHolderName = (hostKey: string) => {
  const views = useAllConstellations();
  const sessions = useApp((s) => s.hostModels[hostKey]?.sessions);

  return useMemo(() => {
    const tasks = new Map<string, string>(
      Object.values(views)
        .flat()
        .flatMap((v) => v.constellation.attempts.map((a) => [a.id, a.taskId]))
    );

    return (lease: Plain<ResourceLease>) =>
      (lease.attemptId == null ? undefined : tasks.get(lease.attemptId)) ??
      (lease.sessionId == null ? null : (sessions?.get(lease.sessionId)?.session.title ?? null));
  }, [views, sessions]);
};

const Resource = ({
  hostKey,
  row,
  run,
  now,
}: {
  readonly hostKey: string;
  readonly row: ResourceRow;
  readonly run: Run;
  readonly now: number;
}) => (
  <li className="flex flex-col gap-1 py-2" data-testid="host-resource" data-resource={row.name}>
    <div className="flex items-center gap-3">
      <span className="text-code-inline text-text-strong font-mono">{row.name}</span>
      <span className="text-caption text-text-subtle">
        {row.capacity === 1 ? "one at a time" : `${row.capacity} at a time`}
      </span>
      <span className="text-caption text-text-subtle min-w-0 flex-1 truncate">{holdLine(row)}</span>
      <Button
        variant="ghost"
        size="xs"
        disabled={row.holders.length > 0 || row.waiting > 0}
        title={
          row.holders.length > 0 || row.waiting > 0
            ? "It's held or has a queue; remove it once it's free"
            : undefined
        }
        onClick={() => void run(`Couldn't remove ${row.name}`, (c) => c.remove(hostKey, row.name))}
      >
        Remove
      </Button>
    </div>
    {row.holders.map((h) => (
      <div key={h.leaseId} className="text-caption flex items-center gap-2 pl-3">
        <span className={cn("truncate", h.overdue ? "text-text-default" : "text-text-subtle")}>
          {h.who} · <span className="font-mono">{h.command}</span> · {age(h.since, now)}
          {h.overdue ? ` · past its ${Math.round(row.holdLimitMs / 60_000)}m limit` : ""}
        </span>
        {h.overdue ? (
          <Button
            size="xs"
            onClick={() =>
              void run(`Couldn't release ${row.name}`, (c) => c.release(hostKey, h.leaseId))
            }
          >
            Release
          </Button>
        ) : null}
      </div>
    ))}
  </li>
);

const AddResource = ({ hostKey, run }: { readonly hostKey: string; readonly run: Run }) => {
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("1");
  const n = Number(capacity);
  const ok = RESOURCE_NAME.test(name) && validCapacity(n);

  const add = async () => {
    if (!ok) return;

    if (await run(`Couldn't add ${name}`, (c) => c.declare(hostKey, { name, capacity: n }))) {
      setName("");
      setCapacity("1");
    }
  };

  return (
    <form
      className="flex items-center gap-2 pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <Input
        aria-label="Resource name"
        placeholder="bench"
        value={name}
        onChange={(e) => setName(e.target.value.trim())}
        className="h-7 w-40 font-mono"
      />
      <Input
        aria-label="How many at a time"
        type="number"
        min={1}
        value={capacity}
        onChange={(e) => setCapacity(e.target.value)}
        className="h-7 w-16"
      />
      <Button type="submit" size="xs" disabled={!ok}>
        Add resource
      </Button>
    </form>
  );
};

export const HostResources = ({ hostKey }: { readonly hostKey: string }) => {
  const { state, run } = useHostResources(hostKey);
  const nameOf = useHolderName(hostKey);
  const now = useNow(60_000);

  if (state.kind !== "loaded") return null;
  const { snapshot } = state;
  const rows = resourceRows(snapshot, nameOf);

  return (
    <div className="flex flex-col gap-0.5" data-testid="host-resources">
      <span className="text-caption text-text-subtle">
        Things only so many commands may use at once. A command takes one with{" "}
        <span className="font-mono">polaris lease &lt;name&gt; -- &lt;command&gt;</span> and holds
        it while it runs; others queue in order.
      </span>
      {rows.length === 0 ? (
        <p className="text-caption text-text-subtle pt-1.5">None on this host.</p>
      ) : (
        <ul className="divide-hairline flex flex-col divide-y">
          {rows.map((row) => (
            <Resource key={row.name} hostKey={hostKey} row={row} run={run} now={now} />
          ))}
        </ul>
      )}
      <AddResource hostKey={hostKey} run={run} />
    </div>
  );
};
