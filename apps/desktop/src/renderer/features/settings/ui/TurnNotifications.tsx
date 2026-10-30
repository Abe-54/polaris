/**
 * Settings → Sessions, "When a turn finishes" and its narrower option, "Only turns longer
 * than [5 min]", which only applies while the main switch is on.
 */
import { SettingsRow, SettingsStepper, SettingsToggleRow } from "@polaris/ui";
import { setSessionPrefs, useSettings } from "../store.ts";

/** Minutes a press moves the threshold; the value stays between 1 and 999. */
const MINUTE_STEP = 5;

export const TurnNotifications = () => {
  const prefs = useSettings((s) => s.sessions);
  const off = !prefs.notifyTurnEnded;

  return (
    <div>
      <SettingsToggleRow
        title="When a turn finishes"
        caption="Once a session is idle with no background tasks; not for workers"
        checked={prefs.notifyTurnEnded}
        onCheckedChange={(on) => setSessionPrefs({ notifyTurnEnded: on })}
      />
      <SettingsRow
        className="-mt-2 pt-0"
        dimmed={off}
        title={
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              id="notify-long-turns"
              aria-label={`Only turns longer than ${prefs.longTurnMinutes} minutes`}
              className="size-3.5 shrink-0 accent-current"
              checked={prefs.notifyLongTurnsOnly}
              disabled={off}
              onChange={(event) =>
                setSessionPrefs({ notifyLongTurnsOnly: event.currentTarget.checked })
              }
            />
            Only turns longer than
          </span>
        }
      >
        <SettingsStepper
          label="Minutes"
          value={prefs.longTurnMinutes}
          onChange={(minutes) => setSessionPrefs({ longTurnMinutes: minutes })}
          min={1}
          max={999}
          step={MINUTE_STEP}
          format={(minutes) => `${minutes} min`}
          disabled={off}
        />
      </SettingsRow>
    </div>
  );
};
