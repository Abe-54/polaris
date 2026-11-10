/**
 * The WebView side of the zero-egress frame (ADR 0101): the tokens the app sends in, the theme
 * message it injects, and the navigation policy that lets only the document's own load through.
 */
import { FRAME_TOKEN_THEMES, type HostMessage } from "@polaris/visualization";
import type { ThemeName } from "../theme/index.ts";

/** Both phone themes are dark. */
export const FRAME_SCHEME = "dark";

/** The kit's tokens for the app's theme, from V9's table (DESIGN.md, Visualizations → the kit). */
export const frameTokens = (theme: ThemeName) => FRAME_TOKEN_THEMES[theme];

/** Script that hands a message to the frame's kit as a `message` event with no source. */
export const hostMessageScript = (message: HostMessage): string =>
  `window.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(message)} }));true;`;

export interface LoadRequest {
  readonly url: string;
}

/**
 * The frame's navigation policy: its own document (`about:blank`, the HTML string's URL) may load
 * until it has loaded once; every other request, and any later one, is refused.
 */
export const navigationPolicy = () => {
  let loaded = false;
  let refused = false;

  return {
    shouldStart: ({ url }: LoadRequest): boolean => {
      if (!loaded && url === "about:blank") return true;
      refused = true;

      return false;
    },
    loaded: () => {
      loaded = true;
    },
    /** True once the frame tried to go anywhere else. */
    get refused() {
      return refused;
    },
  };
};

/** WebRTC and capture APIs CSP doesn't govern, removed in every frame before any page script. */
const WEBRTC = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "RTCDataChannel",
  "RTCSessionDescription",
  "RTCIceCandidate",
  "RTCRtpSender",
  "RTCRtpReceiver",
  "RTCRtpTransceiver",
];

export const LOCKDOWN_SCRIPT = `(function () {
  ${JSON.stringify(WEBRTC)}.forEach(function (name) {
    try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch (error) {}
  });
  try { Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: false }); } catch (error) {}
})();true;`;
