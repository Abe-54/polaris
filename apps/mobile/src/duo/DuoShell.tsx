/**
 * The shell on an iPhone Duo (DESIGN.md, iPhone Duo; Paper D6–D9). The screen on top stays
 * mounted in one place whatever the posture; folding only moves and resizes it and adds the
 * second half, so the focus and the navigation never change with the hinge.
 */
import { mobileType } from "@polaris/ui/tokens";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "../app/navigation.tsx";
import { themedStyles } from "../theme/index.ts";
import type { ThreadFocus } from "../thread/Row.tsx";
import { type Arrangement, arrangementOf, composerMinHeight } from "./arrangement.ts";
import { ConstellationSpan } from "./ConstellationSpan.tsx";
import { ContextPane } from "./ContextPane.tsx";
import { Monitor } from "./Monitor.tsx";
import type { Rect } from "./posture.ts";
import { edgeInsets } from "./edges.ts";
import { useEdgeInsets } from "./useEdgeInsets.ts";
import { usePosture } from "./usePosture.ts";

/** What the thread route takes from the Duo; all absent when folded. */
export interface DuoThread {
  readonly onFocus?: (focus: ThreadFocus) => void;
  readonly focusedKey?: string | null;
  readonly composerSlot?: "inline" | { readonly minHeight: number };
}

const DuoThreadContext = createContext<DuoThread>({});

export const useDuoThread = (): DuoThread => useContext(DuoThreadContext);

const useKeyboardHeight = () => {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const shown = Keyboard.addListener(
      Platform.OS === "android" ? "keyboardDidShow" : "keyboardWillShow",
      (e) => setHeight(e.endCoordinates.height)
    );

    const hidden = Keyboard.addListener(
      Platform.OS === "android" ? "keyboardDidHide" : "keyboardWillHide",
      () => setHeight(0)
    );

    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  return height;
};

const placed = (rect: Rect): ViewStyle => ({
  position: "absolute",
  left: rect.x,
  top: rect.y,
  width: rect.width,
  height: rect.height,
});

/** The second half placed, padded off the window edges it touches, on the panel ground. */
const SecondHalf = ({ rect, children }: { readonly rect: Rect; readonly children: ReactNode }) => {
  const styles = useStyles();
  const edges = useEdgeInsets(rect);

  return (
    <View
      style={[
        placed(rect),
        styles.second,
        { paddingTop: edges.top, paddingRight: edges.right, paddingBottom: edges.bottom },
      ]}
    >
      {children}
    </View>
  );
};

const HIDDEN: ViewStyle = { display: "none" };

/** Where the screen on top stands when it shares the window with a second half. */
const primaryRect = (arrangement: Arrangement): Rect | null =>
  arrangement.kind === "context" || arrangement.kind === "aside" ? arrangement.first : null;

const primaryStyle = (arrangement: Arrangement): ViewStyle | null => {
  switch (arrangement.kind) {
    case "context":
    case "aside":
      return placed(arrangement.first);
    case "span":
    case "monitor":
      return HIDDEN;
    default:
      return null;
  }
};

/** Focus per agent session, kept above the screens so a posture change never drops it. */
const useFocus = () => {
  const [chosen, setChosen] = useState<ReadonlyMap<string, ThreadFocus>>(new Map());
  const [shown, setShown] = useState<ReadonlyMap<string, string>>(new Map());

  const choose = useCallback(
    (session: string, focus: ThreadFocus) => setChosen((m) => new Map(m).set(session, focus)),
    []
  );

  const show = useCallback(
    (session: string, key: string) =>
      setShown((m) => (m.get(session) === key ? m : new Map(m).set(session, key))),
    []
  );

  return { chosen, shown, choose, show };
};

const Aside = () => {
  const styles = useStyles();

  return (
    <View style={styles.aside}>
      <Text style={styles.asideText}>
        Open an agent session, and what you tap in it shows here.
      </Text>
    </View>
  );
};

export const DuoShell = ({ children }: { readonly children: ReactNode }) => {
  const styles = useStyles();
  const navigation = useNavigation();
  const posture = usePosture();
  const keyboard = useKeyboardHeight();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const focus = useFocus();
  const { top } = navigation;
  const arrangement = arrangementOf(posture, top);
  const session = top.screen === "thread" ? `${top.hostId}/${top.sessionId}` : null;

  const thread = useMemo<DuoThread>(() => {
    if (session === null) return {};

    if (arrangement.kind === "context")
      return {
        onFocus: (f: ThreadFocus) => focus.choose(session, f),
        focusedKey: focus.shown.get(session) ?? null,
      };

    if (arrangement.kind === "laptop")
      return {
        composerSlot: {
          minHeight: composerMinHeight(
            arrangement.bottom,
            arrangement.division,
            keyboard,
            insets.bottom
          ),
        },
      };

    return {};
  }, [arrangement, session, focus, keyboard, insets.bottom]);

  const primary = primaryRect(arrangement);

  return (
    <View style={styles.fill}>
      <View style={[styles.fill, primaryStyle(arrangement)]}>
        {/* A half sees only the insets of the window edges it touches, not the other half's cutout. */}
        <SafeAreaInsetsContext.Provider
          value={primary === null ? insets : edgeInsets(primary, window, insets)}
        >
          <DuoThreadContext.Provider value={thread}>{children}</DuoThreadContext.Provider>
        </SafeAreaInsetsContext.Provider>
      </View>
      {arrangement.kind === "context" && top.screen === "thread" && session !== null ? (
        <SecondHalf rect={arrangement.second}>
          <ContextPane
            hostId={top.hostId}
            sessionId={top.sessionId}
            focus={focus.chosen.get(session) ?? null}
            onFocus={(f) => focus.choose(session, f)}
            onShown={(key) => focus.show(session, key)}
            onOpenReview={(turnId) =>
              navigation.push({
                screen: "review",
                hostId: top.hostId,
                sessionId: top.sessionId,
                turnId,
              })
            }
          />
        </SecondHalf>
      ) : null}
      {arrangement.kind === "aside" ? (
        <SecondHalf rect={arrangement.second}>
          <Aside />
        </SecondHalf>
      ) : null}
      {arrangement.kind === "span" && top.screen === "constellation" ? (
        <View style={StyleSheet.absoluteFill}>
          <ConstellationSpan
            hostId={top.hostId}
            constellationId={top.constellationId}
            first={arrangement.first}
            second={arrangement.second}
            onBack={navigation.back}
          />
        </View>
      ) : null}
      {arrangement.kind === "monitor" ? (
        <View style={StyleSheet.absoluteFill}>
          <Monitor
            top={arrangement.top}
            bottom={arrangement.bottom}
            division={arrangement.division}
            onReply={(hostId, sessionId) =>
              navigation.push({ screen: "thread", hostId, sessionId })
            }
          />
        </View>
      ) : null}
    </View>
  );
};

const useStyles = themedStyles((colours) => ({
  fill: { flex: 1, backgroundColor: colours.ground },
  second: { backgroundColor: colours.panel },
  aside: {
    flex: 1,
    justifyContent: "center",
    padding: 40,
    borderLeftWidth: 1,
    borderLeftColor: colours.hairline,
    backgroundColor: colours.panel,
  },
  asideText: { ...mobileType.callout, color: colours.textFaint, textAlign: "center" },
}));
