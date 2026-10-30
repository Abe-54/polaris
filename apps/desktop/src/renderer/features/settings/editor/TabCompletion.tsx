/**
 * SR-02's Tab completion card, behind one switch: behaviour beside the model on the picked
 * machine, then where each host's completion runs, and a model server of your own.
 */
import { useEffect, useState } from "react";
import { Option, Schema } from "effect";
import {
  cn,
  Input,
  SettingsButton,
  SettingsCard,
  SettingsGrid,
  SettingsSelect,
  SettingsSwitch,
  SettingsWell,
} from "@polaris/ui";
import type { HostView } from "../../../../shared/api.ts";
import { clientCopy } from "../../../../shared/clientCopy.ts";
import {
  ConfiguredPredictionEndpoint,
  type PredictionClientEndpoints,
} from "../../../../shared/predictionPlacement.ts";
import { polaris } from "../../bridge.ts";
import { CompletionPlacement } from "./CompletionPlacement.tsx";
import { ClearHistoryRow, EditPredictionRows } from "./EditPredictionRows.tsx";
import { ManagedModel } from "./ManagedModel.tsx";
import { inSentence, memoryLine, placementRow, type ModelServerMemory } from "./placementRows.ts";
import {
  hostConnected,
  inspectPredictionHost,
  loadPredictionSettings,
  preferencesOf,
  setClientEndpoints,
  setPredictionEnabled,
  setPredictionPreferences,
  usePrediction,
} from "../../editor/prediction/store.ts";

const CONTROL =
  "bg-surface-sunken border-hairline rounded-control text-body text-text-default h-row min-w-0 border px-row-pad";

const EndpointForm = ({
  endpoints,
  save,
  machine,
}: {
  readonly endpoints: PredictionClientEndpoints;
  readonly save: (endpoints: PredictionClientEndpoints) => Promise<void>;
  readonly machine: string;
}) => {
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState("openai");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = () => {
    const endpoint = Schema.decodeUnknownOption(ConfiguredPredictionEndpoint)({
      kind,
      url: url.trim(),
    });

    if (Option.isNone(endpoint)) {
      setError("Use localhost or a private IP address, without credentials, query or fragment.");

      return;
    }

    setSaving(true);
    setError(null);

    void save([
      ...endpoints.filter((item) => item.url !== endpoint.value.url),
      endpoint.value,
    ]).then(
      () => {
        setUrl("");
        setSaving(false);
      },
      (cause) => {
        setError(String(cause));
        setSaving(false);
      }
    );
  };

  const remove = (at: number) =>
    save(endpoints.filter((_value, index) => index !== at)).catch((cause) =>
      setError(String(cause))
    );

  return (
    <div className="gap-gap flex flex-col">
      {endpoints.map((endpoint, at) => (
        <div key={`${endpoint.kind}:${endpoint.url}`} className="flex min-w-0 items-center gap-3">
          <span
            className="text-caption text-text-subtle min-w-0 flex-1 truncate font-mono"
            title={endpoint.url}
          >
            {endpoint.url}
          </span>
          <SettingsButton
            variant="ghost"
            onClick={() => void remove(at)}
            aria-label={`Remove ${endpoint.url} on ${machine}`}
          >
            Remove
          </SettingsButton>
        </div>
      ))}
      <form
        className="gap-gap flex flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="text-caption text-text-subtle flex items-center gap-4">
          Server
          <select
            aria-label={`Model server kind on ${machine}`}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className={`${CONTROL} flex-1`}
          >
            <option value="openai">llama-server / LM Studio</option>
            <option value="ollama">Ollama</option>
          </select>
        </label>
        <label className="text-caption text-text-subtle gap-gap flex flex-col">
          Endpoint URL on {machine}
          <Input
            value={url}
            maxLength={2048}
            spellCheck={false}
            className="font-mono"
            placeholder="http://127.0.0.1:8080"
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <div className="flex justify-end">
          <SettingsButton
            type="submit"
            disabled={saving || url.trim().length === 0 || endpoints.length >= 16}
          >
            Add endpoint
          </SettingsButton>
        </div>
      </form>
      {error && (
        <p role="status" className="text-caption text-text-subtle">
          {error}
        </p>
      )}
    </div>
  );
};

export const TabCompletion = ({ hosts }: { readonly hosts: ReadonlyArray<HostView> }) => {
  const state = usePrediction((value) => value);
  const [scope, setScope] = useState("client");
  const [error, setError] = useState<string | null>(null);
  const [memory, setMemory] = useState<ModelServerMemory | null>(null);
  const [ownOpen, setOwnOpen] = useState(false);

  const keys = hosts.map((host) => host.key).join("\u0000");
  const epochs = hosts.map((host) => host.status.epoch).join("\u0000");

  useEffect(() => {
    const api = polaris();
    let live = true;

    void loadPredictionSettings(api).catch((cause) => live && setError(String(cause)));

    for (const hostKey of keys.split("\u0000").filter(Boolean))
      void inspectPredictionHost(api, hostKey, true).catch(
        (cause) => live && setError(String(cause))
      );
    void api.request("prediction.resources.get", {}).then((result) => {
      if (live && result.ok) setMemory(result.value);
    });

    return () => {
      live = false;
    };
  }, [keys, epochs]);

  const local = hosts.find((host) => host.kind === "local");
  const clientLabel = local?.label ?? clientCopy().localHost;
  const localKey = local?.key ?? "local";
  const localConnected = local?.status.state === "connected";

  const scopeHost = hosts.find((host) => host.key === scope);
  const machine = scope === "client" ? clientLabel : (scopeHost?.label ?? scope);
  const endpoints = scope === "client" ? state.clientEndpoints : preferencesOf(scope).hostEndpoints;

  // A machine with an endpoint of its own shows it; an empty form stays folded.
  useEffect(() => {
    if (endpoints.length > 0) setOwnOpen(true);
  }, [endpoints.length]);

  const save = async (value: PredictionClientEndpoints) => {
    if (scope === "client") await setClientEndpoints(polaris(), value);
    else
      await setPredictionPreferences(polaris(), scope, {
        ...preferencesOf(scope),
        hostEndpoints: value,
      });

    const key =
      scope === "client" ? hosts.find((host) => hostConnected(hosts, host.key))?.key : scope;

    if (key) await inspectPredictionHost(polaris(), key, true);
  };

  const enabled = async (on: boolean) => {
    try {
      await setPredictionEnabled(polaris(), on);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const machines = [
    { value: "client", label: clientLabel },
    ...hosts
      .filter((host) => host.kind !== "local")
      .map((host) => ({ value: host.key, label: host.label })),
  ];

  const ramBytes =
    (scope === "client"
      ? state.inspections[localKey]?.client.machine.ramBytes
      : state.inspections[scope]?.host?.machine.ramBytes) ?? null;

  return (
    <SettingsCard
      id="tab-completion"
      aria-label="Tab completion"
      title={
        <span className="flex items-baseline gap-2">
          Tab completion
          <span className="text-caption text-text-subtle font-normal">
            {state.enabled ? `Suggests as you type · models run on ${machine}` : "Off"}
          </span>
        </span>
      }
      aside={
        <SettingsSwitch
          aria-label="Enable tab completion"
          checked={state.enabled}
          disabled={!state.loaded}
          onCheckedChange={(on) => void enabled(on)}
        />
      }
      status={memoryLine(memory, clientLabel) ?? "Nothing leaves the machine"}
      action={
        <SettingsButton aria-expanded={ownOpen} onClick={() => setOwnOpen(!ownOpen)}>
          Use my own model server…
        </SettingsButton>
      }
    >
      <div
        className={cn(
          "gap-gap flex flex-col transition-opacity duration-120",
          !state.enabled && "opacity-(--opacity-dimmed)"
        )}
      >
        <SettingsGrid>
          <SettingsWell>
            <EditPredictionRows hosts={hosts} onError={setError} />
          </SettingsWell>
          <ManagedModel
            key={scope}
            hostKey={scope === "client" ? localKey : scope}
            side={scope === "client" ? "client" : "host"}
            machine={machine}
            connected={scope === "client" ? localConnected : hostConnected(hosts, scope)}
            ramBytes={ramBytes}
            picker={
              <SettingsSelect
                label="Model server machine"
                value={scope}
                options={machines}
                onChange={setScope}
              />
            }
          >
            <ClearHistoryRow />
          </ManagedModel>
        </SettingsGrid>
        <CompletionPlacement
          rows={hosts.map((host) =>
            placementRow({
              host: { key: host.key, label: host.label, state: host.status.state },
              preferences: state.preferences[host.key] ?? preferencesOf(host.key),
              inspection: state.inspections[host.key],
              result: state.results[host.key],
              clientName: clientLabel,
            })
          )}
          colours={Object.fromEntries(hosts.map((host) => [host.key, host.colour]))}
          onChange={(hostKey, patch) =>
            void setPredictionPreferences(polaris(), hostKey, {
              ...preferencesOf(hostKey),
              ...patch,
            }).catch((cause) => setError(String(cause)))
          }
        />
        {ownOpen ? (
          <SettingsWell aria-label="Use my own model server" rows={false}>
            <div className="px-panel gap-gap flex flex-col py-[calc(var(--spacing-panel)-2px)]">
              <span className="text-caption text-text-subtle">
                Run llama-server, LM Studio or Ollama on {inSentence(machine)}; a next-edit model
                there is used before anything is downloaded.
              </span>
              <EndpointForm key={scope} endpoints={endpoints} machine={machine} save={save} />
            </div>
          </SettingsWell>
        ) : null}
        {error && (
          <p role="status" className="px-gap text-caption text-text-subtle">
            {error}
          </p>
        )}
      </div>
    </SettingsCard>
  );
};
