import { contextBridge } from "electron";

/** Runs before page scripts in every frame, including closed-shadow srcdoc children (ADR 0101). */
export const lockFrameWebRTC = () => {
  contextBridge.executeInMainWorld({
    func: () => {
      for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
        Object.defineProperty(globalThis, name, {
          value: undefined,
          writable: false,
          configurable: false,
        });
      }
    },
  });
};
