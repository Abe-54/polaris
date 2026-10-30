/**
 * Settings (DESIGN.md, Settings; Chrome redesign, Paper X-J): replaces the three zones inside the
 * main window. A 264px nav on the ground, the page in one panel with its centred 680px column,
 * the horizon behind them; esc (outside an open menu or dialog) goes back to where the user was.
 */
import {
  AsteriskIcon,
  BranchIcon,
  ChartColumnIcon,
  ChevronLeftIcon,
  CommandIcon,
  cn,
  ContrastIcon,
  GridIcon,
  MicrophoneIcon,
  MobileIcon,
  Horizon,
  Kbd,
  Panel,
  PaperclipIcon,
  PixelPolarisIcon,
  PlugIcon,
  ServerIcon,
  UsersIcon,
} from "@polaris/ui";
import { type ReactNode, useEffect } from "react";
import { slots } from "../../../app/slots.tsx";
import type { SettingsRoute, SettingsSection } from "../../../routes/selection.ts";
import { useShellActions } from "../../../shell/hooks.ts";
import { SECTION_GROUPS, sectionInfo } from "../model/sections.ts";
import { useSettings } from "../store.ts";
import { AttachmentsPage } from "../../attachments/index.ts";
import { DevicesPage } from "../../devices/index.ts";
import { ExtensionsPage } from "../../extensions/index.ts";
import { useUpdates } from "../updates/store.ts";
import { AboutPage } from "./AboutPage.tsx";
import { AppearancePage } from "./AppearancePage.tsx";
import { GitHubPage } from "./GitHubPage.tsx";
import { HarnessesPage } from "./HarnessesPage.tsx";
import { ReviewerPage } from "./ReviewerPage.tsx";
import { SessionsPage } from "./SessionsPage.tsx";
import { EditorPage } from "./EditorPage.tsx";
import { UsagePage } from "./UsagePage.tsx";
import { VoicePage } from "./VoicePage.tsx";
import { ConstellationsPage } from "./ConstellationsPage.tsx";
import { ConstellationMark } from "../../sessions/glyphs.tsx";

const ICONS: Readonly<Record<SettingsSection, ReactNode>> = {
  appearance: <ContrastIcon />,
  sessions: <BranchIcon />,
  editor: <CommandIcon />,
  harnesses: <GridIcon />,
  constellations: <ConstellationMark size={16} className="opacity-90" />,
  usage: <ChartColumnIcon />,
  hosts: <ServerIcon />,
  attachments: <PaperclipIcon />,
  extensions: <PlugIcon />,
  devices: <MobileIcon />,
  voice: <MicrophoneIcon />,
  reviewer: <AsteriskIcon />,
  github: <UsersIcon />,
  about: <PixelPolarisIcon />,
};

/** An open popover, menu, select, dialog or in-place confirm takes esc first. */
const layerOpen = () =>
  document.querySelector(
    "[data-radix-popper-content-wrapper], [role='dialog'], [data-slot='settings-confirm-row'][data-asking]"
  ) !== null;

const useEscapeCloses = (close: () => void) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || layerOpen()) return;
      event.preventDefault();
      close();
    };

    // Capture, so it runs before a Radix layer dismisses itself on the same key.
    window.addEventListener("keydown", onKey, true);

    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);
};

const NavItem = ({
  section,
  selected,
  onSelect,
}: {
  readonly section: SettingsSection;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) => (
  <button
    type="button"
    aria-current={selected ? "page" : undefined}
    onClick={onSelect}
    className={cn(
      "h-row px-row-x text-label flex w-full shrink-0 cursor-default items-center gap-2.5 rounded-full border",
      selected
        ? "bg-panel border-hairline text-text-strong"
        : "text-text-default hover:bg-fill-hover border-transparent [&>svg]:text-text-subtle"
    )}
  >
    {ICONS[section]}
    {sectionInfo(section).title}
  </button>
);

const SettingsNav = ({ current }: { readonly current: SettingsSection }) => {
  const { openSettings, closeSettings } = useShellActions();
  const version = useSettings((s) => s.version);
  const update = useUpdates((s) => s.view);

  return (
    <nav aria-label="Settings" className="px-gap flex w-[264px] shrink-0 flex-col py-3">
      <div className="px-gap flex flex-col gap-3.5 pt-1 pb-[18px]">
        <button
          type="button"
          onClick={closeSettings}
          className="text-label font-regular text-text-subtle hover:text-text-default flex h-6 cursor-default items-center gap-1.5"
        >
          <ChevronLeftIcon size={14} />
          <span className="flex-1 text-left">Back to orchestrate</span>
          <Kbd>esc</Kbd>
        </button>
        <h1 className="text-title text-text-strong font-medium">Settings</h1>
      </div>
      {/* As the sidebar's list: it fades out above the horizon, so no row sits on its moon. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [mask-image:linear-gradient(to_bottom,black_calc(100%-96px),transparent_calc(100%-40px))] pb-20">
        {SECTION_GROUPS.map((group) => (
          <div key={group.title} className="pb-panel flex flex-col">
            <h2 className="text-caption text-text-subtle px-row-x pb-1.5">{group.title}</h2>
            {group.sections.map((section) => (
              <NavItem
                key={section}
                section={section}
                selected={section === current}
                onSelect={() => openSettings(section)}
              />
            ))}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => openSettings("about")}
        aria-current={current === "about" ? "page" : undefined}
        className="px-row-x text-label text-text-default hover:bg-fill-hover rounded-row py-gap flex shrink-0 cursor-default items-center gap-2.5 text-left"
      >
        <PixelPolarisIcon size={16} className="text-starlight" />
        {/* On the dawn ridge the version darkens to keep its contrast (DESIGN.md, the horizon). */}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-baseline gap-2.5">
            About Polaris
            <span className="font-regular font-mono text-[11px] leading-[14px] text-[light-dark(#4a4c52,var(--color-text-subtle))]">
              {update?.version ?? version}
            </span>
          </span>
          {update?.phase === "ready" ? (
            <span className="text-caption font-regular text-[light-dark(#4a4c52,var(--color-text-subtle))]">
              Update ready
            </span>
          ) : null}
        </span>
      </button>
    </nav>
  );
};

const Page = ({ route }: { readonly route: SettingsRoute }) => {
  switch (route.section) {
    case "about":
      return <AboutPage />;
    case "appearance":
      return <AppearancePage />;
    case "sessions":
      return <SessionsPage />;
    case "editor":
      return <EditorPage />;
    case "harnesses":
      return <HarnessesPage />;
    case "constellations":
      return <ConstellationsPage />;
    case "usage":
      return <UsagePage />;
    case "hosts":
      return <slots.SettingsHosts adding={route.adding} />;
    case "attachments":
      return <AttachmentsPage />;
    case "extensions":
      return <ExtensionsPage />;
    case "devices":
      return <DevicesPage />;
    case "voice":
      return <VoicePage />;
    case "reviewer":
      return <ReviewerPage />;
    case "github":
      return <GitHubPage adding={route.adding} />;
  }
};

/** Sunken strips and wells on the old pages take the panel's well, and `bg` is the panel. */
const PAGE = cn(
  "min-h-0 flex-1 [scrollbar-gutter:stable_both-edges] overflow-y-auto",
  "[--color-surface-sunken:var(--color-well)] [--color-bg:var(--color-panel)]"
);

export const SettingsPage = ({ route }: { readonly route: SettingsRoute }) => {
  const { closeSettings } = useShellActions();

  useEscapeCloses(closeSettings);

  return (
    <main
      className="relative isolate flex min-h-0 min-w-0 flex-1 gap-2 pr-2"
      data-testid="settings"
    >
      <SettingsNav current={route.section} />
      <Panel className="mb-2 min-w-0 flex-1">
        <div className={PAGE} data-section={route.section}>
          <Page route={route} />
        </div>
      </Panel>
      <Horizon />
    </main>
  );
};
