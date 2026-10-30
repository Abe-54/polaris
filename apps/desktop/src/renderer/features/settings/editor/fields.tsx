/** Form pieces for Advanced: a labelled text field (secret ones are password inputs) and a form block. */
import { Input, Textarea } from "@polaris/ui";
import type { ChangeEvent, ReactNode } from "react";
import { useId } from "react";

export const Field = ({
  label,
  hint,
  value,
  onChange,
  multiline = false,
  secret = false,
  disabled = false,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly multiline?: boolean;
  readonly secret?: boolean;
  readonly disabled?: boolean;
}) => {
  const id = useId();

  const props = {
    id,
    value,
    disabled,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(event.target.value),
    "aria-describedby": hint ? `${id}-hint` : undefined,
    autoComplete: "off",
    maxLength: 65536,
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-caption text-text-subtle">
        {label}
      </label>
      {multiline ? (
        <Textarea {...props} className="max-h-48 overflow-auto font-mono" spellCheck={false} />
      ) : (
        <Input {...props} className="font-mono" type={secret ? "password" : "text"} />
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-caption text-text-subtle">
          {hint}
        </p>
      )}
    </div>
  );
};

export const FormBlock = ({ children }: { readonly children: ReactNode }) => (
  <div className="px-panel gap-gap flex min-w-0 flex-col py-[calc(var(--spacing-gap)+4px)]">
    {children}
  </div>
);
