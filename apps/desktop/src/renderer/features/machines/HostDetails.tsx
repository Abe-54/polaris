/**
 * A remote Host's own settings, opened in place from its page's Daemon card (Paper HS-D):
 * its name, ssh-agent forwarding and the remote command. Never a modal.
 */
import { Input, Switch } from "@polaris/ui";
import { useState } from "react";
import type { MachineView } from "../../../shared/api.ts";
import { call } from "./hooks.tsx";

export const DEFAULT_REMOTE_COMMAND = "~/.polaris/bin/current/polaris bridge";

interface FieldProps {
  readonly label: string;
  readonly caption: string;
  readonly children: React.ReactNode;
}

const Field = ({ label, caption, children }: FieldProps) => (
  <div className="flex items-center gap-3">
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-label text-text-default">{label}</span>
      <span className="text-caption text-text-subtle">{caption}</span>
    </div>
    {children}
  </div>
);

/** A text setting saved on Enter or blur. */
const TextSetting = ({
  value,
  placeholder,
  label,
  onSave,
  mono = false,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly label: string;
  readonly onSave: (value: string) => void;
  readonly mono?: boolean;
}) => {
  const [draft, setDraft] = useState(value);

  const save = () => {
    if (draft.trim() !== value) onSave(draft.trim());
  };

  return (
    <Input
      aria-label={label}
      className={mono ? "text-code-inline w-[260px] font-mono" : "w-[260px]"}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") save();
      }}
    />
  );
};

export const RemoteSettings = ({ machine }: { readonly machine: MachineView }) => (
  <>
    <Field label="Name" caption="How this host appears across Polaris.">
      <TextSetting
        label="Name"
        value={machine.label}
        placeholder={machine.alias ?? ""}
        onSave={(label) => void call("machines.update", { hostKey: machine.key, label })}
      />
    </Field>
    {machine.kind === "wsl" ? null : (
      <Field
        label="Forward ssh-agent"
        caption="Agents on this host can use your keys, for git over SSH. Off unless you need it."
      >
        <Switch
          aria-label="Forward ssh-agent"
          checked={machine.forwardAgent}
          onCheckedChange={(forwardAgent) =>
            void call("machines.update", { hostKey: machine.key, forwardAgent })
          }
        />
      </Field>
    )}
    {machine.windowsShell === undefined ? (
      <RemoteCommand machine={machine} />
    ) : (
      <Field label="Remote command" caption={WINDOWS_REMOTE_COMMAND}>
        {null}
      </Field>
    )}
  </>
);

/** Why a Windows Host has no remote command to set: its connection is always the relay. */
export const WINDOWS_REMOTE_COMMAND =
  "Windows hosts always connect through PowerShell to the installed daemon.";

/** A WSL Host's remote command runs through wsl.exe, not ssh. */
export const WSL_REMOTE_COMMAND =
  "What wsl.exe runs in the distro. Empty for the installed daemon.";

const RemoteCommand = ({ machine }: { readonly machine: MachineView }) => (
  <Field
    label="Remote command"
    caption={
      machine.kind === "wsl"
        ? WSL_REMOTE_COMMAND
        : "What ssh runs on the host. Empty for the installed daemon."
    }
  >
    <TextSetting
      label="Remote command"
      value={machine.remoteCommand ?? ""}
      placeholder={DEFAULT_REMOTE_COMMAND}
      mono
      onSave={(line) =>
        void call("machines.update", {
          hostKey: machine.key,
          remoteCommand: line === "" ? null : line,
        })
      }
    />
  </Field>
);
