/**
 * A 12px glyph per permission mode (Paper X-E): Plan lines, Supervised an eye, Auto-edits a
 * pencil, Auto fast-forward (fast mode keeps the bolt), Full access an open lock. Never a signal colour.
 */
import type { PermissionMode } from "@polaris/protocol";

const PATHS: Readonly<Record<PermissionMode, string>> = {
  plan: "M2 3h8M2 6h6M2 9h4",
  supervised:
    "M1 6s1.8-3.5 5-3.5S11 6 11 6 9.2 9.5 6 9.5 1 6 1 6ZM6 7.4a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Z",
  "auto-edits": "M7.6 2.2l2.2 2.2L4.4 9.8 1.8 10.2l.4-2.6 5.4-5.4Z",
  auto: "M1.5 3.2 5.5 6l-4 2.8ZM6.3 3.2 10.3 6l-4 2.8Z",
  "full-access": "M3 5.5h6.5v5H3zM4.5 5.5V3.8a1.9 1.9 0 0 1 3.7-.6",
};

export const PermissionGlyph = ({ mode }: { readonly mode: PermissionMode }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    aria-hidden="true"
    data-glyph={mode}
    className="shrink-0"
  >
    <path
      d={PATHS[mode]}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
