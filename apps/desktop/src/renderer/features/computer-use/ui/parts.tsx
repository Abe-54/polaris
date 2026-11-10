/**
 * What the host page's card, the first-run card and the inline prompt share (Paper CU1–CU3):
 * the status well, the one "Allow computer use" step with its two services, and app icons.
 */
import type { DesktopApp } from "@polaris/protocol";
import { cn, Kicker, SettingsButton } from "@polaris/ui";
import type { ReactNode } from "react";
import type { AllowStep, ServiceLine, StatusWell } from "../model.ts";

/** The pixel window with the pointer in it (CU1's well, CU3's card). */
export const WindowGlyph = ({ size = 24 }: { readonly size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden
    className="text-text-default shrink-0"
  >
    <rect x="2.5" y="4.5" width="19" height="13" fill="none" stroke="currentColor" />
    <rect x="4" y="6" width="6" height="4" fill="currentColor" opacity="0.35" />
    <rect x="12" y="8" width="8" height="8" fill="none" stroke="currentColor" opacity="0.6" />
    <path d="M15 10.5v3.5l1-1 1 1.5 0.8-0.5-1-1.4h1.4z" fill="currentColor" />
    <path d="M9 20.5h6" stroke="currentColor" />
  </svg>
);

/** On is a check, off a hollow ring: never colour alone (rule/no-colour-alone). */
export const ServiceMark = ({ on }: { readonly on: boolean }) => (
  <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
    {on ? (
      <svg width="12" height="12" viewBox="0 0 12 12" className="text-text-default">
        <path d="M2.5 6.2l2.3 2.3L9.5 3.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    ) : (
      <span className="border-text-subtle size-[11px] rounded-full border" />
    )}
  </span>
);

export const StatusWellView = ({
  well,
  kicker,
  action,
}: {
  readonly well: StatusWell;
  readonly kicker?: string | undefined;
  readonly action?: ReactNode;
}) => (
  <div className="flex items-center gap-3.5 px-4 py-3.5" data-testid="computer-use-status">
    <WindowGlyph />
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-heading text-text-strong">{well.title}</span>
      <span className="text-caption text-text-subtle break-words">{well.line}</span>
    </div>
    {kicker === undefined ? null : (
      <Kicker className="shrink-0 font-normal tracking-[0.06em]">{kicker}</Kicker>
    )}
    {action}
  </div>
);

const ServiceRow = ({ service }: { readonly service: ServiceLine }) => (
  <li
    className="flex items-center gap-2.5"
    data-testid={`computer-use-service-${service.name}`}
    data-on={service.on}
  >
    <ServiceMark on={service.on} />
    <span className="text-caption text-text-default">{service.name}</span>
    <span className="text-caption text-text-subtle min-w-0 truncate">{service.detail}</span>
  </li>
);

/**
 * The one macOS step, its button primary while anything is off, and the helper's two
 * services underneath so a half-granted state shows.
 */
export const AllowStepView = ({
  step,
  busy,
  onOpen,
}: {
  readonly step: AllowStep;
  readonly busy: boolean;
  readonly onOpen: () => void;
}) => (
  <div className="flex flex-col gap-2.5 px-4 py-3.5" data-testid="computer-use-step">
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body text-text-default">{step.label}</span>
        <span className="text-caption text-text-subtle break-words">{step.detail}</span>
      </div>
      <SettingsButton variant="primary" disabled={busy} onClick={onOpen}>
        {step.button}
      </SettingsButton>
    </div>
    <ul className="flex flex-col gap-1.5 pl-0.5">
      {step.services.map((service) => (
        <ServiceRow key={service.name} service={service} />
      ))}
    </ul>
  </div>
);

/** An app's own icon, or its initial on a neutral tile when the Host gave none. */
export const AppIcon = ({
  app,
  size = 24,
}: {
  readonly app: DesktopApp;
  readonly size?: number;
}) =>
  app.icon === null ? (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        "bg-fill-selected text-text-default text-caption flex shrink-0 items-center justify-center rounded-[6px]"
      )}
    >
      {app.name.slice(0, 1).toUpperCase()}
    </span>
  ) : (
    <img
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-[6px]"
      src={`data:image/png;base64,${app.icon}`}
    />
  );
