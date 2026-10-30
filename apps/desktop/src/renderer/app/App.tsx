/** The renderer root: providers around the shell. */
import { CopyProvider, Toaster, TooltipProvider } from "@polaris/ui";
import { StrictMode } from "react";
import {
  type Onboarding,
  OnboardingProvider,
  settledOnboarding,
} from "../features/onboarding/index.ts";
import { type AppContextValue, AppProvider } from "../shell/hooks.ts";
// Not the feature's index: it reaches slots.tsx, which must load after the shell's features.
import { UpgradeStatusPublisher } from "../features/machines/updates/UpgradeStatus.tsx";
import { LinkedPullsPublisher } from "../features/accept/index.ts";
// The feeds module, not the feature index: the index pulls in the slots that this file renders.
import { ConstellationFeeds } from "../features/constellation/feeds.tsx";
import { BrowserForget, BrowserWorking } from "../features/browser/index.ts";
import { NeedsYouPublisher } from "../features/needs-you/index.ts";
import {
  ConstellationDefaultsPublisher,
  IdleCompactionPublisher,
  VisualsPublisher,
} from "../features/settings/index.ts";
import { PullsPublisher } from "../features/pulls/index.ts";
// Not the feature's index: that loads the Review view's chunk.
import { CheckoutPublisher } from "../features/review/checkout/Publisher.tsx";
import { writeClipboard } from "../features/clipboard.ts";
import { Shell } from "./Shell.tsx";

export interface AppProps {
  readonly value: AppContextValue;
  /** Absent in the fixture previews: the welcome already seen, no home fallback. */
  readonly onboarding?: Onboarding;
}

const settled = settledOnboarding();

export const App = ({ value, onboarding = settled }: AppProps) => (
  <StrictMode>
    <AppProvider value={value}>
      <OnboardingProvider value={onboarding}>
        <CopyProvider write={writeClipboard}>
          <TooltipProvider>
            <Shell />
            <NeedsYouPublisher />
            <ConstellationDefaultsPublisher />
            <IdleCompactionPublisher />
            <VisualsPublisher />
            <PullsPublisher />
            <CheckoutPublisher />
            <LinkedPullsPublisher />
            <ConstellationFeeds />
            <BrowserForget />
            <BrowserWorking />
            <UpgradeStatusPublisher />
            <Toaster />
          </TooltipProvider>
        </CopyProvider>
      </OnboardingProvider>
    </AppProvider>
  </StrictMode>
);
