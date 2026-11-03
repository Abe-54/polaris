import { Command, SessionId } from "@polaris/protocol";
import { mobileType } from "@polaris/ui/tokens";
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { InstrumentSheet, SheetHeader } from "../sheet/index.tsx";
import { useTheme } from "../theme/index.ts";
import type { Menu, MenuAction, MenuItem } from "./model.ts";

export const AndroidMenu = ({
  menu,
  title,
  onAction,
  children,
}: {
  readonly menu: Menu;
  readonly title: string;
  readonly onAction: (action: MenuAction) => void;
  readonly children: ReactNode;
}) => {
  const { colours } = useTheme();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<Extract<MenuAction, { kind: "rename" }> | null>(null);
  const [text, setText] = useState("");

  const close = () => {
    setOpen(false);
    setRenaming(null);
  };

  const select = (item: MenuItem) => {
    if (item.disabled) return;

    if (item.action.kind === "rename") {
      setRenaming(item.action);
      setText(item.action.title);

      return;
    }

    close();
    onAction(item.action);
  };

  const rename = () => {
    if (renaming === null || text.trim() === "") return;

    if (text.trim() !== renaming.title)
      onAction({
        kind: "send",
        hostId: renaming.hostId,
        command: Command.cases.RenameSession.make({
          sessionId: SessionId.make(renaming.sessionId),
          title: text.trim(),
        }),
        failure: "Couldn't rename",
      });
    close();
  };

  const gesture = Gesture.LongPress()
    .runOnJS(true)
    .onStart(() => setOpen(true));

  const label = [styles.label, { color: colours.textStrong }];

  return (
    <>
      <GestureDetector gesture={gesture}>
        <View
          collapsable={false}
          accessibilityActions={[{ name: "longpress", label: "Show actions" }]}
          onAccessibilityAction={() => setOpen(true)}
        >
          {children}
        </View>
      </GestureDetector>
      {open ? (
        <InstrumentSheet open onClose={close}>
          <SheetHeader
            title={renaming === null ? title || "Actions" : "Rename agent session"}
            onClose={close}
          />
          {renaming === null ? (
            menu.map((group, index) => (
              <View key={index} style={[styles.group, { borderColor: colours.hairline }]}>
                {group.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    disabled={item.disabled}
                    onPress={() => select(item)}
                    style={[styles.item, { opacity: item.disabled ? 0.5 : 1 }]}
                  >
                    <Text style={label}>{item.title}</Text>
                    {item.subtitle === null ? null : (
                      <Text style={[styles.subtitle, { color: colours.textSubtle }]}>
                        {item.subtitle}
                      </Text>
                    )}
                  </Pressable>
                ))}
              </View>
            ))
          ) : (
            <>
              <TextInput
                accessibilityLabel="Agent session title"
                value={text}
                onChangeText={setText}
                autoFocus
                selectTextOnFocus
                onSubmitEditing={rename}
                style={[styles.input, label, { borderColor: colours.hairline }]}
              />
              <Pressable
                accessibilityRole="button"
                disabled={text.trim() === ""}
                onPress={rename}
                style={styles.item}
              >
                <Text style={label}>Save</Text>
              </Pressable>
            </>
          )}
        </InstrumentSheet>
      ) : null}
    </>
  );
};

const styles = StyleSheet.create({
  group: { borderBottomWidth: 1 },
  item: { minHeight: 48, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 10 },
  label: { ...mobileType.body },
  subtitle: { ...mobileType.footnote },
  input: { borderWidth: 1, borderRadius: 10, padding: 12 },
});
