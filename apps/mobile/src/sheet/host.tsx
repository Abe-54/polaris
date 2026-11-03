/**
 * The sheet host at the app's root: an `InstrumentSheet` anywhere in the tree draws here, above
 * every screen and the floating tab pill, since navigation is hand-rolled and has no modal layer.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { Platform, StyleSheet, View } from "react-native";
import type { Detent } from "./detents.ts";
import { SheetFrame } from "./frame.tsx";

export interface InstrumentSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Resting heights, lowest first once resolved. Default medium, large. */
  readonly detents?: readonly Detent[];
  /** The detent it opens at, as an index into the resolved heights. Default 0, the lowest. */
  readonly initialIndex?: number;
  /** False keeps a drag from dismissing it; close and the scrim still do. Default true. */
  readonly dismissible?: boolean;
  /** False draws no scrim: the screen behind stays lit and takes touches (MX-AH). Default true. */
  readonly scrim?: boolean;
  /** Called with the detent's index each time the sheet comes to rest. */
  readonly onDetentChange?: (index: number) => void;
  /**
   * `SheetHeader` and `StatusFooter` children stay pinned at the top and foot; everything else
   * scrolls between them.
   */
  readonly children: ReactNode;
}

interface Host {
  readonly show: (id: string, sheet: InstrumentSheetProps | null) => void;
}

const HostContext = createContext<Host | null>(null);

/** Wraps the app: renders its children, then every open sheet above them. */
export const SheetHost = ({ children }: { readonly children: ReactNode }) => {
  const [sheets, setSheets] = useState<ReadonlyMap<string, InstrumentSheetProps>>(new Map());

  const show = useCallback((id: string, sheet: InstrumentSheetProps | null) => {
    setSheets((current) => {
      const next = new Map(current);

      if (sheet === null) next.delete(id);
      else next.set(id, sheet);

      return next;
    });
  }, []);

  const host = useMemo(() => ({ show }), [show]);
  const top = [...sheets].filter(([, sheet]) => sheet.open).at(-1)?.[0];
  const android = Platform.OS === "android";

  return (
    <HostContext.Provider value={host}>
      {android ? (
        <View
          style={styles.fill}
          importantForAccessibility={top === undefined ? "auto" : "no-hide-descendants"}
        >
          {children}
        </View>
      ) : (
        children
      )}
      {sheets.size === 0 ? null : (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {[...sheets].map(([id, sheet]) =>
            android ? (
              <View
                key={id}
                style={StyleSheet.absoluteFill}
                pointerEvents="box-none"
                importantForAccessibility={id === top ? "auto" : "no-hide-descendants"}
              >
                <SheetFrame {...sheet} />
              </View>
            ) : (
              <SheetFrame key={id} {...sheet} />
            )
          )}
        </View>
      )}
    </HostContext.Provider>
  );
};

const styles = StyleSheet.create({ fill: { flex: 1 } });

const useHost = (): Host => {
  const host = useContext(HostContext);

  if (host === null) throw new Error("InstrumentSheet needs a SheetHost above it");

  return host;
};

/**
 * A bottom sheet with detents (DESIGN.md, Mobile chrome redesign: instrument sheets; Paper MX-H),
 * drawn by the `SheetHost` above it. Compose it from `SheetHeader`, wells and `StatusFooter`.
 */
export const InstrumentSheet = (props: InstrumentSheetProps) => {
  const host = useHost();
  const id = useId();

  useLayoutEffect(() => {
    host.show(id, props);
  });
  useLayoutEffect(() => () => host.show(id, null), [host, id]);

  return null;
};
