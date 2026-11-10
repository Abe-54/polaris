/**
 * One Visualization's frame (ADR 0101): a WebView limited to its own HTML string, no file access,
 * every navigation refused, and only schema-checked messages taken from it, size- and rate-limited.
 */
import { buildFrameDocument, HostMessage } from "@polaris/visualization";
import { useEffect, useMemo, useRef } from "react";
import { type StyleProp, type ViewStyle } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useTheme } from "../theme/index.ts";
import {
  FRAME_SCHEME,
  frameTokens,
  hostMessageScript,
  LOCKDOWN_SCRIPT,
  navigationPolicy,
} from "./frame.ts";
import { type FrameBridge, openBridge } from "./bridge.ts";
import type { Visualization } from "./model.ts";
import { fileStateStore, type VisualizationStateStore } from "./stateStore.ts";

export interface VisualizationFrameProps {
  readonly visualization: Visualization;
  readonly mode: "inline" | "expanded";
  /** A clamped height the frame reported (inline only). */
  readonly onHeight?: (height: number) => void;
  /** An https link the frame asks to open; the caller confirms first. */
  readonly onOpenLink: (url: string) => void;
  /** It tried to load another page and was refused (DESIGN.md, Stopped). */
  readonly onStopped: () => void;
  readonly store?: VisualizationStateStore;
  readonly style?: StyleProp<ViewStyle>;
}

export const VisualizationFrame = ({
  visualization,
  mode,
  onHeight,
  onOpenLink,
  onStopped,
  store = fileStateStore,
  style,
}: VisualizationFrameProps) => {
  const { colours, name: theme } = useTheme();
  const view = useRef<WebView<object>>(null);
  const themeAtMount = useRef(theme);
  const sentTheme = useRef(theme);
  const { id, html, title } = visualization;

  // The document is built once per frame; theme changes go in as `pv:theme` below.
  const document = useMemo(
    () =>
      buildFrameDocument({
        html,
        title,
        mode,
        tokens: frameTokens(themeAtMount.current),
        scheme: FRAME_SCHEME,
        state: store.read(id),
      }),
    [html, title, mode, id, store]
  );

  const handlers = useRef({ onHeight, onOpenLink });
  const bridge = useRef<FrameBridge | null>(null);

  handlers.current = { onHeight, onOpenLink };

  useEffect(() => {
    const opened = openBridge(id, store, () => ({
      onHeight: (height) => handlers.current.onHeight?.(height),
      onOpenLink: (url) => handlers.current.onOpenLink(url),
    }));

    bridge.current = opened;

    return () => {
      bridge.current = null;
      opened.close();
    };
  }, [id, store]);

  // A new document starts a new load, so it gets its own policy.
  const policy = useMemo(() => navigationPolicy(), [document]);

  useEffect(() => {
    if (sentTheme.current === theme) return;
    sentTheme.current = theme;

    const message = HostMessage.make({
      type: "pv:theme",
      tokens: frameTokens(theme),
      scheme: FRAME_SCHEME,
    });

    view.current?.injectJavaScript(hostMessageScript(message));
  }, [theme]);

  const onMessage = ({ nativeEvent }: WebViewMessageEvent) =>
    bridge.current?.receive(nativeEvent.data);

  return (
    // The package types `WebView<P = undefined>` as `Props & P`, which is never without a `P`.
    <WebView<object>
      ref={view}
      source={{ html: document }}
      // Everything reaches `shouldStart`: a URL the whitelist fails is opened in Safari unasked.
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={(request) => {
        const start = policy.shouldStart(request);

        if (!start) onStopped();

        return start;
      }}
      onLoadEnd={() => policy.loaded()}
      onMessage={onMessage}
      onContentProcessDidTerminate={() => view.current?.reload()}
      javaScriptEnabled
      // Defence in depth beside the bootstrap's own removal (ENG-596): every frame, before any script.
      injectedJavaScriptBeforeContentLoaded={LOCKDOWN_SCRIPT}
      injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
      mediaCapturePermissionGrantType="deny"
      allowsAirPlayForMediaPlayback={false}
      fraudulentWebsiteWarningEnabled={false}
      javaScriptCanOpenWindowsAutomatically={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      allowsLinkPreview={false}
      dataDetectorTypes="none"
      incognito
      cacheEnabled={false}
      setSupportMultipleWindows={false}
      scrollEnabled={mode === "expanded"}
      bounces={false}
      overScrollMode="never"
      showsVerticalScrollIndicator={mode === "expanded"}
      style={[{ backgroundColor: colours.panel }, style]}
      containerStyle={{ backgroundColor: colours.panel }}
    />
  );
};
