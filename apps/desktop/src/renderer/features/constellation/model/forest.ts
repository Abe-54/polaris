/**
 * Siblings as a dependency forest, as dagr draws them (ENG-685): a Task hangs under the sibling
 * it depends on that comes last among them; its other deps read "← X" on its row.
 */

export interface Placed<T> {
  readonly item: T;
  /** The sibling it hangs under, if any. */
  readonly host: string | null;
  readonly under: ReadonlyArray<Placed<T>>;
}

export interface Sibling {
  readonly id: string;
  readonly deps: ReadonlyArray<string>;
  /** Hangs under a dep (Gates keep their place after their inputs). */
  readonly nests: boolean;
  /** Takes dependents under it (only leaf Tasks do; Gates and parents don't). */
  readonly hosts: boolean;
}

/** The sibling a Task hangs under: its dep that is declared last among the hosting siblings. */
const hostOf = (s: Sibling, order: ReadonlyMap<string, number>, hosts: ReadonlySet<string>) => {
  if (!s.nests) return null;
  let best: string | null = null;

  for (const dep of s.deps) {
    if (dep === s.id || !hosts.has(dep)) continue;

    if (best === null || (order.get(dep) ?? 0) > (order.get(best) ?? 0)) best = dep;
  }

  return best;
};

/** Roots and dependents both in declaration order; anything a cycle would strand stays a root. */
export const arrange = <T>(
  items: ReadonlyArray<T>,
  sibling: (item: T) => Sibling
): ReadonlyArray<Placed<T>> => {
  const all = items.map((item) => ({ item, s: sibling(item) }));
  const order = new Map(all.map(({ s }, n) => [s.id, n]));
  const hosts = new Set(all.flatMap(({ s }) => (s.hosts ? [s.id] : [])));
  const hostById = new Map(all.map(({ s }) => [s.id, hostOf(s, order, hosts)]));
  const dependents = new Map<string, Array<(typeof all)[number]>>();

  for (const entry of all) {
    const host = hostById.get(entry.s.id) ?? null;

    if (host !== null) dependents.set(host, [...(dependents.get(host) ?? []), entry]);
  }

  const placed = new Set<string>();

  const place = (entry: (typeof all)[number], host: string | null): Placed<T> => {
    placed.add(entry.s.id);

    const under = (dependents.get(entry.s.id) ?? []).flatMap((d) =>
      placed.has(d.s.id) ? [] : [place(d, entry.s.id)]
    );

    return { item: entry.item, host, under };
  };

  const roots = all.flatMap((e) => (hostById.get(e.s.id) === null ? [place(e, null)] : []));

  for (const entry of all) if (!placed.has(entry.s.id)) roots.push(place(entry, null));

  return roots;
};

/** Every item in a placed subtree, itself first. */
export const flatten = <T>(p: Placed<T>): ReadonlyArray<T> => [
  p.item,
  ...p.under.flatMap((u) => flatten(u)),
];
