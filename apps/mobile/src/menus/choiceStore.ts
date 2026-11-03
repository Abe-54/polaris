export interface Choice {
  readonly title: string | undefined;
  readonly message: string | undefined;
  readonly options: ReadonlyArray<string>;
  readonly onChoose: (index: number) => void;
  readonly onCancel: () => void;
}

const queue: Choice[] = [];

const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

export const currentChoice = (): Choice | null => queue[0] ?? null;

export const subscribeChoice = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

/** Queue requests even before the host mounts, so promise-based callers always get an answer. */
export const showChoice = (choice: Choice) => {
  queue.push(choice);
  notify();
};

/** Clear before invoking user code; repeated presses and dismissal events settle only once. */
export const finishChoice = (choice: Choice, index: number | null) => {
  if (currentChoice() !== choice) return;

  if (index !== null && (!Number.isInteger(index) || index < 0 || index >= choice.options.length))
    return;

  queue.shift();
  notify();

  if (index === null) choice.onCancel();
  else choice.onChoose(index);
};
