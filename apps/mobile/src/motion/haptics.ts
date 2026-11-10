import {
  AndroidHaptics,
  performAndroidHapticsAsync,
  ImpactFeedbackStyle,
  impactAsync,
  NotificationFeedbackType,
  notificationAsync,
} from "expo-haptics";
import { Platform } from "react-native";

// A device without a Taptic Engine rejects; a missed tap is never worth an error.
const fire = (feedback: Promise<void>) => void feedback.catch(() => undefined);

/** The taps that confirm a decision left the phone. Haptics aren't motion: Reduce Motion keeps them. */
export const haptics = {
  /** An approval or answer that lets the agent go on. */
  approve: () =>
    fire(
      Platform.OS === "android"
        ? performAndroidHapticsAsync(AndroidHaptics.Confirm)
        : notificationAsync(NotificationFeedbackType.Success)
    ),
  /** A prompt, follow-up or steer sent. */
  send: () =>
    fire(
      Platform.OS === "android"
        ? performAndroidHapticsAsync(AndroidHaptics.Context_Click)
        : impactAsync(ImpactFeedbackStyle.Light)
    ),
  /** A Turn stopped. */
  stop: () =>
    fire(
      Platform.OS === "android"
        ? performAndroidHapticsAsync(AndroidHaptics.Reject)
        : impactAsync(ImpactFeedbackStyle.Rigid)
    ),
  /** A confirmation that asks before a risky step (accepting with a Critical open). */
  warning: () =>
    fire(
      Platform.OS === "android"
        ? performAndroidHapticsAsync(AndroidHaptics.Reject)
        : notificationAsync(NotificationFeedbackType.Warning)
    ),
  detent: () =>
    fire(
      Platform.OS === "android"
        ? performAndroidHapticsAsync(AndroidHaptics.Segment_Tick)
        : impactAsync(ImpactFeedbackStyle.Light)
    ),
} as const;
