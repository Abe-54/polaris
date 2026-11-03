import { Platform } from "react-native";
import { deviceCopyFor } from "./deviceCopy.ts";

export const DEVICE_COPY = deviceCopyFor(Platform.OS);
