/**
 * A new agent session (Paper MX-AO): a blank thread headed "New session" over the horizon, the
 * recent workspaces, and the composer with its place line; the first send creates the session.
 * With no Harness ready the setup panel takes the sky (MX-AR).
 */
import { mobileFont, mobileType } from "@polaris/ui/tokens";
import { Match } from "effect";
import { useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Chevron, ModelChip, QuietChip } from "../composer/ControlRow.tsx";
import { ModelSheet } from "../composer/ModelSheet.tsx";
import { Horizon } from "../horizon";
import { type MobileColours, themedStyles, useTheme } from "../theme/index.ts";
import { CONTENT_TEXT_SCALE, CONTROL_TEXT_SCALE } from "../theme/textScale.ts";
import { Composer } from "../thread/Composer.tsx";
import type { ComposerMode } from "../thread/composer.ts";
import type { RecentChip, SheetHost } from "./model.ts";
import { NotReadyPanel } from "./NotReadyPanel.tsx";
import { type NewSession, type NewSessionInput, useNewSession } from "./useNewSession.ts";
import { useStartSheet } from "./useStartSheet.ts";
import { WorkspaceSheet } from "./WorkspaceSheet.tsx";
import { DEVICE_COPY } from "../app/platformCopy.ts";

export interface NewSessionScreenProps extends NewSessionInput {
  readonly onBack: () => void;
}

const PROMPT = "What should happen next?";

const Header = ({ onBack }: { readonly onBack: () => void }) => {
  const styles = useStyles();

  return (
    <View style={styles.header}>
      <Pressable
        style={styles.back}
        onPress={onBack}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <Text style={styles.backGlyph} allowFontScaling={false}>
          ‹
        </Text>
      </Pressable>
      <View style={styles.titles}>
        <Text
          style={styles.title}
          accessibilityRole="header"
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        >
          New session
        </Text>
        <Text style={styles.subtitle} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
          Starts when you send
        </Text>
      </View>
    </View>
  );
};

const dotColour = (host: SheetHost, colours: MobileColours): string =>
  Match.value(host.state).pipe(
    Match.when("connected", () => colours.textDefault),
    Match.whenOr("reconnecting", "needs-attention", () => colours.needsYou),
    Match.when("offline", () => colours.textFaint),
    Match.exhaustive
  );

/** The composer's head: "● mac-studio / polaris ⌄", opening the workspace sheet. */
const PlaceLine = ({
  session,
  onPress,
}: {
  readonly session: NewSession;
  readonly onPress: () => void;
}) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const { host, workspace } = session;

  return (
    <Pressable
      style={styles.place}
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={
        host === null || workspace === null
          ? "Choose a workspace"
          : `Workspace ${workspace.name} on ${host.hostName}`
      }
    >
      {host === null || workspace === null ? (
        <Text style={styles.placeHost} maxFontSizeMultiplier={CONTROL_TEXT_SCALE}>
          {host === null
            ? `Add a workspace on the ${DEVICE_COPY.computer} first`
            : "Choose a workspace"}
        </Text>
      ) : (
        <>
          <View style={[styles.dot, { backgroundColor: dotColour(host, colours) }]} />
          <Text
            style={[styles.placeHost, styles.placeHostName]}
            numberOfLines={1}
            ellipsizeMode="middle"
            maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
          >
            {host.hostName}
          </Text>
          <Text
            style={[styles.placeLine, styles.placeWorkspaceName]}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
          >
            <Text style={styles.placeSlash}>/ </Text>
            <Text style={styles.placeWorkspace}>{workspace.name}</Text>
          </Text>
        </>
      )}
      <Chevron colour={colours.textFaint} />
    </Pressable>
  );
};

const Recents = ({
  chips,
  onPick,
}: {
  readonly chips: ReadonlyArray<RecentChip>;
  readonly onPick: (chip: RecentChip) => void;
}) => {
  const styles = useStyles();

  return chips.length === 0 ? null : (
    <View style={styles.recents}>
      <Text style={styles.kicker}>RECENT</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.chips}
      >
        {chips.map((chip) => (
          <Pressable
            key={`${chip.target.hostId}/${chip.target.workspaceId}`}
            style={({ pressed }) => [styles.chip, pressed ? styles.pressed : null]}
            onPress={() => onPick(chip)}
            accessibilityRole="button"
            accessibilityLabel={
              chip.hostName === null ? chip.name : `${chip.name} on ${chip.hostName}`
            }
          >
            <Text
              style={styles.chipName}
              numberOfLines={1}
              maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
            >
              {chip.name}
              {chip.hostName === null ? null : (
                <Text style={styles.chipHost}> {chip.hostName}</Text>
              )}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
};

/** The model chip: the session-to-be's Harness and Model, or why there is none yet. */
const StartModelControl = ({ session }: { readonly session: NewSession }) => {
  const sheet = useStartSheet(session.choice, session.permission, session.host);

  if (sheet === null)
    return (
      <QuietChip
        label={
          session.choice.load.kind === "loading" && session.host !== null
            ? "Checking…"
            : "No harness"
        }
      />
    );

  return (
    <>
      <ModelChip
        harness={sheet.harness}
        celestial={null}
        label={sheet.label}
        working={false}
        onPress={() => sheet.setOpen(true)}
      />
      <ModelSheet input={sheet} />
    </>
  );
};

/** With every Harness on the Host not ready, the setup panel; null otherwise. */
const notReadyOf = (session: NewSession) =>
  session.host !== null && session.choice.load.kind === "loaded" && session.choice.harness === null
    ? { host: session.host, harnesses: session.choice.load.notReady }
    : null;

export const NewSessionScreen = ({ onBack, ...input }: NewSessionScreenProps) => {
  const styles = useStyles();
  const session = useNewSession(input);
  const [placing, setPlacing] = useState(false);
  const notReady = notReadyOf(session);
  const { workspace } = session;

  const mode: ComposerMode =
    notReady === null ? { kind: "send" } : { kind: "blocked", reason: PROMPT };

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        <Header onBack={onBack} />
        <View style={styles.sky}>
          {notReady === null ? (
            <Horizon />
          ) : (
            <ScrollView contentContainerStyle={styles.panel}>
              <NotReadyPanel
                hostName={notReady.host.hostName}
                harnesses={notReady.harnesses}
                onCheckAgain={session.choice.refresh}
              />
            </ScrollView>
          )}
        </View>
        <View style={styles.bottom}>
          {notReady === null ? (
            <Recents chips={session.recents} onPick={(chip) => session.pick(chip.target)} />
          ) : null}
          <Composer
            mode={mode}
            text={session.draft.text}
            harness={session.choice.harness ?? "claude"}
            model={null}
            workingSince={null}
            draftStatus={null}
            error={session.error}
            head={<PlaceLine session={session} onPress={() => setPlacing(true)} />}
            control={<StartModelControl session={session} />}
            placeholder={PROMPT}
            unstarted
            autoFocus={notReady === null}
            canSend={session.why === null && !session.busy}
            onChange={session.draft.setText}
            attach={session.attachments.input}
            attaching={session.attachments.staging}
            voice={session.voice}
            onSend={() => void session.send()}
            onQueue={() => undefined}
            onStop={() => undefined}
          />
        </View>
      </KeyboardAvoidingView>
      <WorkspaceSheet
        open={placing}
        onClose={() => setPlacing(false)}
        hosts={input.hosts}
        target={session.target}
        onPick={session.pick}
        worktree={
          workspace === null || session.worktreeCaption === null
            ? null
            : {
                on: session.newWorktree,
                caption: session.worktreeCaption,
                enabled: workspace.isGitRepo,
                onChange: session.setNewWorktree,
              }
        }
      />
    </SafeAreaView>
  );
};

const useStyles = themedStyles((colours) => ({
  screen: { flex: 1, backgroundColor: colours.ground },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingTop: 4,
    paddingBottom: 12,
    paddingLeft: 14,
    paddingRight: 16,
  },
  back: { width: 20, height: 36, justifyContent: "center" },
  backGlyph: { fontSize: 32, lineHeight: 34, color: colours.starlight },
  titles: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...mobileType.title, fontWeight: "600", color: colours.textStrong },
  subtitle: { ...mobileType.index, color: colours.textFaint },
  sky: { flex: 1, overflow: "hidden" },
  panel: { padding: 10, paddingTop: 8 },
  bottom: { gap: 10, paddingHorizontal: 10, paddingTop: 4 },
  recents: { flexDirection: "row", alignItems: "center", gap: 10, marginLeft: 6 },
  kicker: {
    fontFamily: mobileFont.mono,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "500",
    letterSpacing: 0.88,
    color: colours.textFaint,
  },
  chips: { gap: 8, paddingRight: 10 },
  chip: {
    height: 34,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.panel,
  },
  pressed: { opacity: 0.7 },
  chipName: { ...mobileType.subhead, fontWeight: "500", color: colours.textDefault },
  chipHost: { fontWeight: "400", color: colours.textFaint },
  place: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 7,
    minHeight: 28,
    paddingHorizontal: 8,
    paddingTop: 4,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  placeLine: { flexShrink: 1, fontFamily: mobileFont.mono, fontSize: 12, lineHeight: 16 },
  placeHost: {
    fontFamily: mobileFont.mono,
    fontSize: 12,
    lineHeight: 16,
    color: colours.textSubtle,
  },
  // The workspace keeps its room; a long host name gives way first, in the middle.
  placeHostName: { flexShrink: 1, minWidth: 48 },
  placeWorkspaceName: { flexShrink: 0, maxWidth: "62%" },
  placeSlash: { color: colours.textFaint },
  placeWorkspace: { fontWeight: "600", color: colours.textStrong },
}));
