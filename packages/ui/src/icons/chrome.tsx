import type { SVGProps } from "react";

/**
 * Chrome icons: Nucleo UI outline at 16px with a 1px stroke, in currentColor (DESIGN.md,
 * Icons). The Nucleo set is vendored in ./nucleo under its own licence.
 */
export * from "./nucleo/ui";

export * from "./nucleo/ui-more";

export * from "./nucleo/ui-sync";

export * from "./nucleo/ui-browser";

export { ICON_MASKS } from "./nucleo/masks";

export type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number };

const STROKE = 1;

function Outline({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function DotIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />
    </Outline>
  );
}
