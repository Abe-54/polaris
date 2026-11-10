/** The last frame beside a computer use approval (CU4), fetched once per request. */
import { Directory, File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";
import { Image, StyleSheet } from "react-native";
import { useHost, useLiveHost } from "../runtime/hosts.tsx";
import { useTheme } from "../theme/index.ts";
import { frameSource, type LastFrame, lastFrame } from "./lastFrame.ts";

const keepOnDisk = async (name: string, bytes: Uint8Array) => {
  const folder = new Directory(Paths.cache, "computer-use");

  folder.create({ intermediates: true, idempotent: true });
  const file = new File(folder, name);

  if (!file.exists) await file.write(bytes);

  return file.uri;
};

export const useLastFrame = (hostId: string, sessionId: string, requestId: string) => {
  const live = useLiveHost(useHost(hostId));
  const [frame, setFrame] = useState<LastFrame | null>(null);

  useEffect(() => {
    let current = true;

    void lastFrame(live === null ? null : frameSource(live), sessionId, keepOnDisk).then(
      (found) => {
        if (current) setFrame(found);
      }
    );

    return () => {
      current = false;
    };
  }, [live, sessionId, requestId]);

  return frame;
};

export const LastFrameImage = ({ frame }: { readonly frame: LastFrame }) => {
  const { colours } = useTheme();

  return (
    <Image
      accessibilityLabel="What the agent last saw"
      source={{ uri: frame.uri }}
      style={[
        styles.frame,
        { aspectRatio: frame.width / frame.height, borderColor: colours.hairline },
      ]}
      resizeMode="cover"
    />
  );
};

const styles = StyleSheet.create({
  frame: { width: "100%", maxHeight: 220, borderRadius: 10, borderWidth: 1 },
});
