/**
 * Pasting images into a composer: give its TextInput the returned `nativeID`, and each image
 * pasted there is staged as if picked. In builds without `modules/polaris-paste`, none.
 */
import { type NativeModule, requireOptionalNativeModule } from "expo";
import { useEffect, useId, useRef } from "react";
import type { AttachInput } from "./controls.tsx";
import { pastedInto } from "./paste.ts";

interface PasteEvent {
  readonly json: string;
}

declare class PolarisPasteModule extends NativeModule<{
  onPaste: (event: PasteEvent) => void;
}> {
  watch(fieldId: string): Promise<void>;
  unwatch(fieldId: string): Promise<void>;
}

const native = requireOptionalNativeModule<PolarisPasteModule>("PolarisPaste");

/** The field's `nativeID`. Without `attach`, or not `able`, Paste isn't offered for an image. */
export const usePastedImages = (attach: AttachInput | null, able = true): string => {
  const fieldId = `composer-${useId()}`;
  const add = useRef(attach?.add);
  add.current = attach?.add;
  const enabled = able && attach !== null;

  useEffect(() => {
    if (native === null || !enabled) return;

    const subscription = native.addListener("onPaste", (event) => {
      const images = pastedInto(fieldId, event.json);

      if (images.length > 0) add.current?.(images);
    });

    void native.watch(fieldId).catch(() => undefined);

    return () => {
      subscription.remove();
      void native.unwatch(fieldId).catch(() => undefined);
    };
  }, [fieldId, enabled]);

  return fieldId;
};
