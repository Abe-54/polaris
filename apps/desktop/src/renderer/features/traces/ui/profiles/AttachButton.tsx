import { useState } from "react";
import type { TracesSessionKey } from "../../model/session.ts";
import { useProfilesApi } from "../../data/profiles.tsx";
import { selectProfile } from "../../model/profile/store.ts";

/** A request opens the existing approval card; the button itself never authorizes attach. */
export const AttachButton = ({
  at,
  pid,
  service,
}: {
  readonly at: TracesSessionKey;
  readonly pid: number;
  readonly service: string;
}) => {
  const api = useProfilesApi();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!api.attach) return null;

  const request = async () => {
    setPending(true);
    setError(null);

    try {
      const result = await api.attach!(at, pid, 5);

      if (result.ok) selectProfile(at, result.value);
      else setError(`${result.error.message}${result.error.fix ? ` ${result.error.fix}` : ""}`);
    } catch {
      setError("The profile request could not reach this host.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => void request()}
        className="text-caption text-text-default focus-visible:ring-starlight rounded-card text-left outline-none focus-visible:ring-2 disabled:opacity-(--opacity-dimmed)"
      >
        {pending ? "Waiting for approval or recording…" : `Profile ${service} for 5 s…`}
      </button>
      {pending ? (
        <p className="text-caption text-text-subtle">
          Approve the request in the agent session. While attached, any local process can run code
          in it.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption text-text-default">
          {error}
        </p>
      ) : null}
    </div>
  );
};
