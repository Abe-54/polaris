/**
 * The needs you inbox (Paper MX-H): the oldest request in the hero well, the rest in wells under
 * "Also waiting on you", each answered in place as on Home, and every Host's state in the footer.
 */
import { mobileType } from "@polaris/ui/tokens";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useNavigation } from "../app/navigation.tsx";
import type { SessionRow } from "../home/model/home.ts";
import { NeedsYouStar } from "../home/ui/glyphs.tsx";
import { NeedsYouCard } from "../home/ui/NeedsYouCard.tsx";
import { sessionMenu, useMenuActions } from "../menus/index.ts";
import {
  HeroWell,
  InstrumentSheet,
  SheetHeader,
  SheetKicker,
  StatusFooter,
  StatusItem,
  Well,
} from "../sheet/index.tsx";
import { type MobileColours, themedStyles, useTheme } from "../theme/index.ts";
import type { FooterHost, Inbox } from "./model.ts";
import { CHROME_TEXT_SCALE } from "../theme/textScale.ts";

const DETENTS = ["medium", "large"] as const;

/** Re-renders each minute so ages ("42m") stay true while the sheet is open. */
const useNow = (open: boolean) => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, [open]);

  return now;
};

const Empty = ({ working }: { readonly working: string | null }) => {
  const styles = useStyles();

  return (
    <View style={styles.empty}>
      <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} style={styles.emptyTitle}>
        Nothing needs you
      </Text>
      {working === null ? null : (
        <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} style={styles.emptyLine}>
          {working}
        </Text>
      )}
    </View>
  );
};

const Card = ({ item, now }: { readonly item: SessionRow; readonly now: number }) => {
  const navigation = useNavigation();
  const onMenu = useMenuActions();

  return (
    <NeedsYouCard
      item={item}
      hostId={item.hostId}
      now={now}
      onOpen={() =>
        navigation.push({ screen: "thread", hostId: item.hostId, sessionId: item.session.id })
      }
      menu={{ menu: sessionMenu(item), onAction: onMenu }}
    />
  );
};

const Requests = ({ inbox, now }: { readonly inbox: Inbox; readonly now: number }) => {
  const [first, ...rest] = inbox.items;

  if (first === undefined) return <Empty working={inbox.working} />;

  return (
    <>
      <HeroWell>
        <Card key={first.key} item={first} now={now} />
      </HeroWell>
      {rest.length === 0 ? null : <SheetKicker parts={["Also waiting on you", rest.length]} />}
      {rest.map((item) => (
        <Well key={item.key}>
          <Card item={item} now={now} />
        </Well>
      ))}
    </>
  );
};

const dotColour = (colours: MobileColours, connection: FooterHost["connection"]) =>
  ({
    connected: colours.diffAddedText,
    reconnecting: colours.needsYou,
    "needs-attention": colours.failed,
    offline: colours.textFaint,
  })[connection];

export const InboxSheet = ({
  open,
  inbox,
  onClose,
}: {
  readonly open: boolean;
  readonly inbox: Inbox;
  readonly onClose: () => void;
}) => {
  const { colours } = useTheme();
  const now = useNow(open);

  return (
    <InstrumentSheet open={open} onClose={onClose} detents={DETENTS}>
      <SheetHeader
        title="Needs you"
        {...(inbox.count === 0 ? {} : { kicker: inbox.count })}
        mark={<NeedsYouStar size={13} />}
        onClose={onClose}
      />
      <Requests inbox={inbox} now={now} />
      <StatusFooter {...(inbox.away ? { note: "answer when it's back" } : {})}>
        {inbox.hosts.map((host) => (
          <StatusItem
            key={host.key}
            color={dotColour(colours, host.connection)}
            label={host.label}
          />
        ))}
      </StatusFooter>
    </InstrumentSheet>
  );
};

const useStyles = themedStyles((colours) => ({
  empty: { alignItems: "center", gap: 2, paddingVertical: 48 },
  emptyTitle: {
    ...mobileType.subhead,
    fontWeight: "500",
    lineHeight: 20,
    color: colours.textStrong,
  },
  emptyLine: { ...mobileType.footnote, fontSize: 12, lineHeight: 16, color: colours.textSubtle },
}));
