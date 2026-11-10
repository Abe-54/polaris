/**
 * Runs what a long-press menu chose: navigation, a reply through the Host's connection, the
 * pasteboard, a reconnect, or the New agent session sheet. A refused reply is an alert in the Host's own words.
 */
import { Command, SessionId } from "@polaris/protocol";
import { Effect, Match } from "effect";
import { useCallback } from "react";
import { Alert } from "react-native";
import { useNavigation } from "../app/navigation.tsx";
import { useFollowedHosts } from "../home/feed/useFollowedHosts.ts";
import { newCommandId } from "../home/model/respond.ts";
import { NotConnected } from "../runtime/hostConnection.ts";
import { copyText } from "./LongPressMenu.tsx";
import { failureTitle, type MenuAction, replyCommand } from "./model.ts";
import type { DaemonClient } from "@polaris/client/rpc";

/** "Interrupt the turn in flight first": the reason, first letter up. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const useMenuActions = (): ((action: MenuAction) => void) => {
  const navigation = useNavigation();
  const hosts = useFollowedHosts();

  return useCallback(
    (action: MenuAction) => {
      const followed = (hostId: string) =>
        hosts.find(({ connection }) => connection.hostId === hostId);

      // A refusal resolves with the Host's reason; only a dropped connection rejects.
      const sendOver = (
        hostId: string,
        failure: string,
        call: (client: DaemonClient) => Effect.Effect<unknown, { readonly message: string }>
      ) => {
        const host = followed(hostId);
        const name = host?.status.host?.hostname ?? host?.connection.name ?? "The host";

        const sent =
          host === undefined
            ? Promise.reject(new NotConnected(hostId))
            : host.connection.run((client) =>
                call(client).pipe(
                  Effect.match({ onFailure: (error) => error.message, onSuccess: () => null })
                )
              );

        void sent
          .catch(() => `${name} isn't connected.`)
          .then((refusal) => {
            if (refusal !== null) Alert.alert(failure, sentence(refusal));
          });
      };

      const dispatch = (hostId: string, failure: string, command: Command) =>
        sendOver(hostId, failure, (client) =>
          client.dispatch({ commandId: newCommandId(), command })
        );

      Match.value(action).pipe(
        Match.discriminatorsExhaustive("kind")({
          "open-session": ({ hostId, sessionId }) =>
            navigation.push({ screen: "thread", hostId, sessionId }),
          "open-review": ({ hostId, sessionId }) =>
            navigation.push({ screen: "review", hostId, sessionId, turnId: null }),
          "open-constellation": ({ hostId, constellationId }) =>
            navigation.push({ screen: "constellation", hostId, constellationId }),
          copy: ({ text }) => void copyText(text),
          "retry-host": ({ hostId }) => followed(hostId)?.connection.retryNow(),
          "new-session": ({ hostId }) =>
            navigation.push({ screen: "newSession", workspaceId: null, hostId }),
          // Offered disabled; the native menu never hands it back.
          fork: () => undefined,
          reply: (sending) =>
            dispatch(sending.hostId, failureTitle(sending.reply), replyCommand(sending)),
          send: ({ hostId, command, failure }) => dispatch(hostId, failure, command),
          rename: ({ hostId, sessionId, title }) =>
            Alert.prompt(
              "Rename agent session",
              undefined,
              (next) => {
                const trimmed = next.trim();

                if (trimmed === "" || trimmed === title) return;
                dispatch(
                  hostId,
                  "Couldn't rename",
                  Command.cases.RenameSession.make({
                    sessionId: SessionId.make(sessionId),
                    title: trimmed,
                  })
                );
              },
              "plain-text",
              title
            ),
          "set-state": ({ hostId, constellationId, action, failure }) =>
            sendOver(hostId, failure, (client) =>
              client["constellation.set_state"]({
                commandId: newCommandId(),
                constellationId,
                action,
              })
            ),
        })
      );
    },
    [hosts, navigation]
  );
};
