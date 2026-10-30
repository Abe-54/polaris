import { type SettingsOption, SettingsSelectRow } from "@polaris/ui";
import { useEffect, useState } from "react";
import type {
  PredictionPlacementChoice,
  PredictionPreferences,
} from "../../../shared/predictionPlacement.ts";
import { polaris } from "../bridge.ts";
import { call } from "./hooks.tsx";

const choices: ReadonlyArray<SettingsOption<PredictionPlacementChoice>> = [
  { value: "auto", label: "Auto" },
  { value: "client", label: "This machine" },
  { value: "host", label: "Host" },
  { value: "off", label: "Off" },
];

/**
 * Per-Host setting, editable even while the Host is Offline. One line on the host page (HS-D);
 * what Auto picks and the model servers' memory are on Editor → Tab completion.
 */
export const PredictionPlacement = ({ hostKey }: { readonly hostKey: string }) => {
  const [preferences, setPreferences] = useState<PredictionPreferences | null>(null);

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setPreferences(null);
    void polaris()
      .request("prediction.settings.get", { hostKey })
      .then((result) => {
        if (active && result.ok) setPreferences(result.value);
      });

    return () => {
      active = false;
    };
  }, [hostKey]);

  const change = async (placement: PredictionPlacementChoice) => {
    if (preferences === null || saving) return;
    setSaving(true);

    try {
      const saved = await call("prediction.settings.set", {
        hostKey,
        preferences: { ...preferences, placement },
      });

      if (saved !== null) setPreferences(saved);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="prediction-placement">
      <SettingsSelectRow
        title="Run tab completion on"
        value={preferences?.placement ?? "auto"}
        options={choices}
        disabled={preferences === null || saving}
        onChange={(value) => void change(value)}
      />
    </div>
  );
};
