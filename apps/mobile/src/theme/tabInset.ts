/** Only iOS lets the tab pill enter the home-indicator inset by 4pt (Paper MX-C). */
export const tabBottomInset = (bottom: number, platform: string): number =>
  Math.max(bottom - (platform === "ios" ? 4 : 0), 20);
