/**
 * The panel with no Request open: the Host's Connection State while it is away, the empty
 * checkout's hand-off when there are no `.http` files, else how to open one.
 */
import type { RequestsSnapshot } from "@polaris/protocol";
import { EmptyState, PixelHourglassIcon } from "@polaris/ui";
import { useEffect, useRef } from "react";
import { useCommands } from "../../../../shell/hooks.ts";
import type { Loaded } from "../../data/hooks.tsx";
import type { RequestsSlotProps } from "../slots.ts";
import { EmptyCheckout } from "./EmptyCheckout.tsx";
import { HostAway, useHostAway } from "./HostAway.tsx";

export interface NothingOpenProps extends RequestsSlotProps {
  readonly snapshot: Loaded<RequestsSnapshot>;
  readonly onNew: () => void;
  readonly onPasteCurl: () => void;
}

export const NothingOpen = (props: NothingOpenProps) => {
  const away = useHostAway(props.hostKey);
  const { snapshot } = props;

  if (away !== null && snapshot.status !== "ready") return <HostAway {...away} />;

  if (snapshot.status === "ready" && snapshot.value.files.length === 0)
    return (
      <div className="grid flex-1 place-items-center p-6">
        <EmptyCheckout {...props} />
      </div>
    );

  return (
    <div className="grid flex-1 place-items-center" data-testid="requests-none-open">
      <EmptyState
        icon={<PixelHourglassIcon size={24} className="text-text-strong" />}
        title={snapshot.status === "loading" ? "Reading requests" : "No request open"}
        fact="Pick a request, start one with +, or paste a curl command"
      />
    </div>
  );
};

/** ⌘N in Requests: a new Request in http/requests.http (New session keeps ⌘N elsewhere). */
export const useNewRequestCommand = (onNew: () => void) => {
  const commands = useCommands();
  const latest = useRef(onNew);

  latest.current = onNew;

  useEffect(() => {
    return commands.register({ "requests.new": { run: () => latest.current() } });
  }, [commands]);
};
