/** The label colour choice (Paper D3): no colour, then rule/data-source-label's five presets. */
import { cn } from "@polaris/ui";
import { LABEL_COLOURS, LABEL_NAMES, LABEL_TONES, type LabelColour } from "../../model/source.ts";

export const LabelSwatches = ({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: LabelColour;
  readonly onChange: (colour: LabelColour) => void;
  readonly disabled?: boolean;
}) => (
  <div role="radiogroup" aria-label="Label colour" className="flex items-center gap-2">
    {LABEL_COLOURS.map((colour) => (
      <button
        key={colour}
        type="button"
        role="radio"
        aria-checked={value === colour}
        aria-label={LABEL_NAMES[colour]}
        title={LABEL_NAMES[colour]}
        disabled={disabled}
        data-colour={colour}
        onClick={() => onChange(colour)}
        className={cn(
          "size-[22px] shrink-0 cursor-default rounded-full outline-none disabled:opacity-(--opacity-dimmed)",
          "focus-visible:ring-starlight focus-visible:ring-offset-raised focus-visible:ring-2 focus-visible:ring-offset-2",
          colour === "none" ? "border-text-faint border border-dashed" : LABEL_TONES[colour].fill,
          value === colour && "ring-text-strong ring-offset-raised ring-2 ring-offset-2"
        )}
      />
    ))}
  </div>
);
