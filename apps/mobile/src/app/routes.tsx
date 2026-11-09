/**
 * The screens each route draws. The thread is S2's, a new agent session is MX-AO's blank thread,
 * and Link this iPhone is `link/LinkScreen.tsx`.
 */
import { SessionId } from "@polaris/protocol";
import { useDuoThread } from "../duo/DuoShell.tsx";
import { NewSessionScreen, useSheetData } from "../newSession/index.ts";
import { useHosts } from "../runtime/hosts.tsx";
import { ThreadScreen } from "../thread/index.ts";
import { useNavigation } from "./navigation.tsx";

/** The thread; on an unfolded or half-folded Duo it also takes the Duo's focus and composer. */
export const ThreadRoute = (props: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly rise?: true | undefined;
  readonly onBack: () => void;
}) => (
  <ThreadScreen
    hostId={props.hostId}
    sessionId={SessionId.make(props.sessionId)}
    onBack={props.onBack}
    rise={props.rise === true}
    {...useDuoThread()}
  />
);

export { ConstellationScreen as ConstellationRoute } from "../constellation/index.ts";

/** Review (M5) of a Turn; a null `turnId` reviews the latest one that ended. */
export { ReviewScreen as ReviewRoute } from "../review/index.ts";

/** The Review tab: agent sessions ready to review across Hosts. */
export { ReviewTab } from "../review/index.ts";

/** A new agent session; once it starts, its thread takes the screen's place. */
export const NewSessionRoute = (props: {
  readonly workspaceId: string | null;
  readonly hostId?: string;
  readonly onBack: () => void;
}) => {
  const navigation = useNavigation();
  const { hosts, api } = useSheetData();
  const connections = useHosts();

  return (
    <NewSessionScreen
      hosts={hosts}
      api={api}
      {...(props.workspaceId === null ? {} : { workspaceId: props.workspaceId })}
      {...(props.hostId === undefined ? {} : { hostId: props.hostId })}
      connectionFor={(hostId) => connections.find((c) => c.hostId === hostId) ?? null}
      onStarted={(hostId, sessionId) =>
        navigation.replace({ screen: "thread", hostId, sessionId, rise: true })
      }
      onBack={props.onBack}
    />
  );
};
