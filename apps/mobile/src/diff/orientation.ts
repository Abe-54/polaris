/**
 * The app is portrait everywhere (app.json's plugin starts it locked); the file diff screen
 * unlocks landscape while it is open, for MX-R's split, and locks back on leave (ENG-569).
 */
import { lockAsync, OrientationLock, unlockAsync } from "expo-screen-orientation";
import { useEffect } from "react";

export const useLandscapeWhileOpen = (): void => {
  useEffect(() => {
    void unlockAsync();

    return () => void lockAsync(OrientationLock.PORTRAIT_UP);
  }, []);
};
