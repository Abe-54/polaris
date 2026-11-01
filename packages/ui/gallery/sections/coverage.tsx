import { useState } from "react";

import {
  Button,
  Chip,
  Dither,
  HarnessChoice,
  HostStateCard,
  HostStateChip,
  InstallCard,
  Kbd,
  MachineBar,
  NeedsYouCard,
  PixelFailedIcon,
  PixelFolderIcon,
  PixelForkIcon,
  PixelKeyIcon,
  PixelServerIcon,
  PixelSparkleIcon,
  PixelTerminalIcon,
  QuestionCard,
  Scene,
  SetupCard,
  SetupRow,
  StageHeading,
  WaitingCard,
} from "../../src";
import { Section } from "./layout";

function HostStates() {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-row border-hairline bg-surface-sunken flex flex-wrap items-center gap-2 self-start border px-3 py-1.5">
        <HostStateChip host="Mac Studio" state="connected" />
        <Chip selected>polaris</Chip>
        <span className="bg-text-faint/25 h-4 w-px" />
        <HostStateChip host="Linux VM" state="reconnecting" since="12s" />
        <Chip dimmed>nj-homes-choice-next</Chip>
        <Chip dimmed>dcai</Chip>
        <span className="bg-text-faint/25 h-4 w-px" />
        <HostStateChip host="Raspberry Pi 4" state="needs-attention" />
        <span className="bg-text-faint/25 h-4 w-px" />
        <HostStateChip host="MacBook Pro" state="offline" since="09:14" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <HostStateCard
          reason="host-key-unknown"
          title="Linux VM's host key isn't trusted yet"
          body="Connect once in a terminal and accept the key. Polaris retries when you're back."
          detail="ssh linux-vm"
          fix={{ label: "Open in terminal", onAction: () => undefined }}
          secondary={{ label: "Retry", onAction: () => undefined }}
        />
        <HostStateCard
          reason="host-key-changed"
          title="Linux VM's host key changed"
          body="It no longer matches known_hosts. If you rebuilt the machine, remove the old key and retry. If you didn't, don't connect."
          detail="ssh-keygen -R linux-vm"
          secondary={{ label: "Copy command", onAction: () => undefined }}
        />
        <HostStateCard
          reason="daemon-not-running"
          title="The daemon on Raspberry Pi 4 isn't running"
          body="Its 3 agent sessions are kept and resume once it starts."
          detail="polaris serve · exited 2h ago · code 1"
          fix={{ label: "Start daemon", onAction: () => undefined }}
          secondary={{ label: "View log", onAction: () => undefined }}
        />
        <HostStateCard
          reason="installing"
          title="Installing on Linux VM"
          body="Copying the build over SSH and checking each file's SHA-256."
          progress={{ value: 0.57, label: "3 of 4 files · 21.8 of 38.2 MB", eta: "about 20s" }}
          secondary={{ label: "Cancel", onAction: () => undefined }}
        />
      </div>
    </div>
  );
}

function Choice() {
  const [choice, setChoice] = useState("claude");

  return (
    <div className="flex flex-col gap-3">
      <HarnessChoice
        aria-label="Harness"
        value={choice}
        onValueChange={setChoice}
        harnesses={[
          { kind: "claude", caption: "Opus 5", status: "ready" },
          { kind: "codex", caption: "GPT-5.4 High", status: "ready" },
        ]}
        others={[
          {
            value: "fork",
            hue: "starlight",
            icon: <PixelForkIcon size={22} className="text-starlight" />,
            title: "Fork a turn",
            caption: "From a checkpoint",
          },
        ]}
      />
      <HarnessChoice
        aria-label="Harness on a host without Codex"
        value="claude"
        onValueChange={() => undefined}
        harnesses={[
          { kind: "claude", caption: "Opus 5", status: "ready" },
          { kind: "codex", caption: "GPT-5.4 High", status: "not-installed" },
          { kind: "aider", caption: "Not in this build's catalogue", status: "ready" },
        ]}
      />
      <HarnessChoice
        aria-label="Harness, wrapping past three"
        className="grid grid-cols-2"
        value="claude"
        onValueChange={() => undefined}
        harnesses={[
          { kind: "claude", caption: "Opus 5" },
          { kind: "codex", caption: "GPT-5.4 High" },
          { kind: "opencode", caption: "Bench Large · medium" },
          { kind: "gemini", caption: "Bench Large · medium" },
          { kind: "copilot", caption: "Bench Large · medium" },
        ]}
        others={[
          {
            value: "fork",
            hue: "starlight",
            icon: <PixelForkIcon size={22} className="text-starlight" />,
            title: "Fork a turn",
            caption: "From a checkpoint",
          },
        ]}
      />
    </div>
  );
}

function Inbox() {
  return (
    <div className="grid grid-cols-[264px_1fr] gap-4">
      <div className="rounded-row bg-surface-sunken flex flex-col gap-2 p-2">
        <NeedsYouCard
          harness="codex"
          title="Spike GPUI review screen"
          where="Mac Studio · polaris · 42m"
          approval={{ command: "cargo build --release", onAlwaysAllow: () => undefined }}
        />
        <NeedsYouCard
          harness="claude"
          selected
          title="Fix eligibility form validation"
          where="Linux VM · nj-homes · 18m"
          question="Should household income be entered monthly or annually?"
        />
        <p className="text-caption text-text-subtle px-1.5 pt-2.5 pb-0.5">Also waiting on you</p>
        <WaitingCard
          kind="failed"
          icon={<PixelFailedIcon size={14} />}
          title="Home automation cron"
          detail="Failed · out of memory on Pi 4"
          action={{ label: "Retry", onAction: () => undefined }}
        />
        <WaitingCard
          kind="in-terminal"
          icon={<PixelTerminalIcon size={14} />}
          title="Flaky export test"
          detail="In your terminal"
          action={{ label: "Take back", onAction: () => undefined }}
        />
      </div>
      <QuestionCard
        harness="claude"
        age="18m"
        questions={[
          {
            header: "Income",
            question: "Should household income be entered monthly or annually?",
            context:
              "The API expects annual income, but the old form collected monthly. Annual keeps one unit end to end.",
            answers: [
              { label: "Annual", description: "One unit end to end", recommended: true },
              { label: "Monthly, converted before submit" },
            ],
          },
          {
            header: "Fields",
            question: "Which fields should be required?",
            multiSelect: true,
            answers: [{ label: "Income" }, { label: "Household size" }, { label: "Postcode" }],
          },
        ]}
        className="self-start"
      />
    </div>
  );
}

function Machines() {
  const [selected, setSelected] = useState("linux-vm");

  return (
    <MachineBar
      className="rounded-row border"
      selected={selected}
      onSelect={setSelected}
      onAdd={() => undefined}
      machines={[
        { id: "mbp", name: "MacBook Pro", detail: "3 workspaces", shortcut: "⌃1" },
        {
          id: "studio",
          name: "Mac Studio",
          detail: "5 workspaces",
          glyph: <Dither hue="claude" size={12} moving />,
          needsYou: 1,
          shortcut: "⌃2",
        },
        {
          id: "linux-vm",
          name: "Linux VM",
          detail: "Work · 6 workspaces",
          glyph: <Dither hue="codex" size={12} moving />,
          needsYou: 1,
          shortcut: "⌃3",
        },
        {
          id: "pi",
          name: "Raspberry Pi 4",
          detail: "Needs attention",
          glyph: <PixelKeyIcon size={12} className="text-text-strong" />,
          shortcut: "⌃4",
        },
      ]}
    />
  );
}

function Onboarding() {
  return (
    <Scene className="rounded-card flex flex-col items-center gap-5 px-6 pt-8 pb-10">
      <StageHeading
        kicker="Set up · Mac Studio"
        title="Where does your code live?"
        line="Add a workspace to start your first session. Remote hosts can come now or later."
      />
      <SetupCard>
        <SetupRow
          icon={<PixelFolderIcon size={20} />}
          title="Add a workspace"
          caption="A repository on Mac Studio"
          action={
            <Button variant="primary" className="pr-2">
              Choose folder <Kbd variant="plain">⌘O</Kbd>
            </Button>
          }
        />
        <SetupRow
          icon={<PixelServerIcon size={20} />}
          title="Connect a host"
          caption="14 hosts in ~/.ssh/config · optional"
          action={<Button>Browse hosts</Button>}
        />
        <SetupRow
          icon={<PixelSparkleIcon size={16} />}
          title="Start a session"
          caption="Claude Code 2.1.4 and Codex 0.52.0 are ready on Mac Studio"
          locked="Needs a workspace"
        />
      </SetupCard>
      <InstallCard
        facts={[
          { label: "Platform", value: "linux-arm64 · glibc 2.39" },
          { label: "Version", value: "polaris 0.1.0 · 38.2 MB" },
          {
            label: "SHA-256",
            value: "9f2c41d7 0be3a6f1 58c2e9d4 7a10b3e5\nc6d82f47 e19a0c3b 5d7f2e86 b4a1e41a",
          },
          { label: "Installs to", value: "~/.polaris on linux-vm" },
        ]}
        note="Copied from this Mac, nothing downloaded. Asked once; upgrades install on their own."
        actions={
          <>
            <Button>Not now</Button>
            <Button variant="primary" className="pr-2">
              Approve and install <Kbd variant="plain">⌘↵</Kbd>
            </Button>
          </>
        }
      />
    </Scene>
  );
}

/** The M1 components V0 found missing: host states, harness choice, inbox, machine bar, setup. */
export function CoverageSection() {
  return (
    <>
      <Section title="Host connection states (5PM-1)">
        <HostStates />
      </Section>
      <Section title="Harness choice (VG-0)">
        <Choice />
      </Section>
      <Section title="Needs you inbox and question (1G2-0)">
        <Inbox />
      </Section>
      <Section title="Machine bar (MX-0)">
        <Machines />
      </Section>
      <Section title="First run and install (57Q-1, 5FB-1)">
        <Onboarding />
      </Section>
    </>
  );
}
