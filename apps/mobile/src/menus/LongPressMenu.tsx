/**
 * A row's long-press menu: the native iOS context menu (`modules/polaris-context-menu`), the row
 * lifted as its preview. A development client built before the module draws the row alone.
 */
import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType, ReactNode } from "react";
import { Clipboard, type NativeSyntheticEvent, Platform, StyleSheet } from "react-native";
import { AndroidMenu } from "./AndroidMenu.tsx";
import { useTheme } from "../theme/index.ts";
import type { Menu, MenuAction } from "./model.ts";

interface NativeProps {
  readonly menu: string;
  readonly title: string;
  readonly previewColor: string;
  readonly previewInsetBottom: number;
  readonly previewRadius: number;
  readonly onSelectItem: (event: NativeSyntheticEvent<{ readonly id: string }>) => void;
  readonly style?: object;
  readonly children: ReactNode;
}

interface ContextMenuModule {
  readonly copy: (text: string) => Promise<void>;
}

const native = requireOptionalNativeModule<ContextMenuModule>("PolarisContextMenu");

const NativeMenu: ComponentType<NativeProps> | null =
  native === null ? null : requireNativeView<NativeProps>("PolarisContextMenu");

/** Copies to the pasteboard; false where the module isn't built in. */
export const copyText = async (text: string): Promise<boolean> => {
  if (Platform.OS === "android") {
    Clipboard.setString(text);

    return true;
  }

  if (native === null) return false;
  await native.copy(text);

  return true;
};

const encode = (menu: Menu) =>
  JSON.stringify(
    menu.map((group) =>
      group.map(({ id, title, subtitle, disabled, symbol }) => ({
        id,
        title,
        subtitle,
        disabled,
        symbol,
      }))
    )
  );

export const LongPressMenu = ({
  menu,
  title = "",
  previewInsetBottom = 0,
  card = false,
  onAction,
  children,
}: {
  readonly menu: Menu;
  /** The menu's header, above its items (MX-J: a turn's receipt). */
  readonly title?: string;
  /** Points cut from the lifted preview's foot, so what the header repeats isn't lifted twice. */
  readonly previewInsetBottom?: number;
  /** Lifts open-ground content (a Turn's text) as MX-J's card: raised, padded, 18pt corners. */
  readonly card?: boolean;
  readonly onAction: (action: MenuAction) => void;
  readonly children: ReactNode;
}) => {
  const { colours } = useTheme();

  if (Platform.OS === "android" && menu.length > 0)
    return (
      <AndroidMenu menu={menu} title={title} onAction={onAction}>
        {children}
      </AndroidMenu>
    );

  if (NativeMenu === null || menu.length === 0) return children;

  const onSelectItem = ({ nativeEvent }: NativeSyntheticEvent<{ readonly id: string }>) => {
    const chosen = menu.flat().find((entry) => entry.id === nativeEvent.id);

    if (chosen !== undefined && !chosen.disabled) onAction(chosen.action);
  };

  return (
    <NativeMenu
      menu={encode(menu)}
      title={title}
      previewColor={card ? colours.raised : colours.ground}
      previewInsetBottom={previewInsetBottom}
      previewRadius={card ? CARD_RADIUS : PREVIEW_RADIUS}
      onSelectItem={onSelectItem}
      style={card ? styles.card : styles.lift}
    >
      {children}
    </NativeMenu>
  );
};

const PREVIEW_RADIUS = 12;

const PREVIEW_MARGIN = 12;

const CARD_RADIUS = 18;

/** Wider than the row by a margin each side, so the lifted preview has room around the text. */
const styles = StyleSheet.create({
  lift: { marginHorizontal: -PREVIEW_MARGIN, paddingHorizontal: PREVIEW_MARGIN },
  // MX-J's 14pt padding: 8 here and the reply's own 6 across; 10 above and below the text.
  card: { marginHorizontal: -8, paddingHorizontal: 8, marginVertical: -10, paddingVertical: 10 },
});
