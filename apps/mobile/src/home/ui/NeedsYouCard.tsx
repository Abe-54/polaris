/**
 * One page of the needs you hero card (Paper MX-C), also a card in the needs you inbox (MX-H):
 * the agent session, what it asks, and its answer controls. The frame around it is the caller's.
 */
import { mobileFont } from "@polaris/ui/tokens";
import { Pressable, Text, View } from "react-native";
import { Celestial, sessionCelestial } from "../../celestial/index.tsx";
import { LongPressMenu, type Menu, type MenuAction } from "../../menus/index.ts";
import { useHost } from "../../runtime/hosts.tsx";
import { themedStyles } from "../../theme/index.ts";
import { age } from "../model/format.ts";
import { type SessionRow, whereLine } from "../model/home.ts";
import { type Reply, respond } from "../model/respond.ts";
import { ApprovalActions, OpenToAnswer } from "./ApprovalActions.tsx";
import { CONTENT_TEXT_SCALE } from "../../theme/textScale.ts";

export interface RowMenu {
  readonly menu: Menu;
  readonly onAction: (action: MenuAction) => void;
}

export interface NeedsYouPageProps {
  readonly item: SessionRow;
  readonly now: number;
  readonly onOpen: () => void;
  readonly onReply: (reply: Reply) => Promise<void>;
  /** On the head only: a long press in the reply field stays the field's. */
  readonly menu?: RowMenu | undefined;
}

export const titleOf = (title: string) => (title.trim() === "" ? "Untitled agent session" : title);

/** The page with its replies sent through `onReply`. */
export const NeedsYouPage = ({ item, now, onOpen, onReply, menu }: NeedsYouPageProps) => {
  const styles = useStyles();

  const head = (
    <Pressable
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [styles.head, pressed ? styles.pressed : null]}
    >
      <View style={styles.top}>
        <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.title} numberOfLines={2}>
          {titleOf(item.session.title)}
        </Text>
        <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.age}>
          {age(item.since, now)}
        </Text>
      </View>
      <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.where} numberOfLines={1}>
        {whereLine(item)}
      </Text>
    </Pressable>
  );

  return (
    <View style={[styles.page, item.stale ? styles.stale : null]}>
      <View style={styles.mark}>
        <Celestial
          body={sessionCelestial(item.session.celestial)}
          harness={item.session.harness}
          size={24}
        />
      </View>
      <View style={styles.text}>
        {menu === undefined ? (
          head
        ) : (
          <LongPressMenu menu={menu.menu} onAction={menu.onAction}>
            {head}
          </LongPressMenu>
        )}
        {item.approval === null ? (
          <OpenToAnswer onOpen={onOpen} />
        ) : (
          <ApprovalActions
            approval={item.approval}
            where={{ hostId: item.hostId, host: item.hostName, harness: item.session.harness }}
            enabled={!item.stale}
            onReply={onReply}
            onOpen={onOpen}
          />
        )}
      </View>
    </View>
  );
};

export interface NeedsYouCardProps {
  readonly item: SessionRow;
  readonly hostId: string;
  readonly now: number;
  readonly onOpen: () => void;
  readonly menu?: RowMenu | undefined;
}

/** The page answering through `hostId`'s connection, the same on Home and in the inbox sheet. */
export const NeedsYouCard = ({ item, hostId, now, onOpen, menu }: NeedsYouCardProps) => {
  const host = useHost(hostId);
  const { approval } = item;

  const onReply = (reply: Reply): Promise<void> =>
    host === null || approval === null
      ? Promise.reject(new Error("host gone"))
      : host.run((client) => respond(client, approval, reply));

  return <NeedsYouPage item={item} now={now} onOpen={onOpen} onReply={onReply} menu={menu} />;
};

const useStyles = themedStyles((colours) => ({
  page: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 2 },
  stale: { opacity: 0.55 },
  mark: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0 },
  head: { gap: 2 },
  pressed: { opacity: 0.7 },
  top: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  title: {
    flex: 1,
    fontFamily: mobileFont.sans,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "500",
    color: colours.textStrong,
  },
  age: {
    fontFamily: mobileFont.mono,
    fontSize: 12,
    lineHeight: 16,
    paddingTop: 2,
    color: colours.textSubtle,
    fontVariant: ["tabular-nums"],
  },
  where: {
    fontFamily: mobileFont.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colours.textSubtle,
    writingDirection: "ltr",
  },
}));
