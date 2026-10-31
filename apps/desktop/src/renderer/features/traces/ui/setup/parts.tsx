/** The setup views' shared pieces: a copyable line, a titled section, the centred column, the lead. */
import { CopyButton } from "@polaris/ui";
import type { ReactNode } from "react";

export const Copyable = ({ text, label }: { readonly text: string; readonly label: string }) => (
  <div className="border-hairline bg-surface-sunken rounded-control flex items-start gap-2 border py-2 pr-2 pl-2.5">
    <code className="text-code-inline text-text-default min-w-0 flex-1 font-mono break-all whitespace-pre-wrap">
      {text}
    </code>
    <CopyButton text={text} label={label} />
  </div>
);

export const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) => (
  <section className="flex flex-col gap-2">
    <h3 className="text-label text-text-strong font-medium">{title}</h3>
    {children}
  </section>
);

export const Column = ({
  testId,
  children,
}: {
  readonly testId: string;
  readonly children: ReactNode;
}) => (
  <div className="flex min-h-0 flex-1 overflow-y-auto" data-testid={testId}>
    <div className="m-auto flex w-full max-w-[460px] flex-col gap-6 px-6 py-10">{children}</div>
  </div>
);

export const Lead = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) => (
  <div className="flex flex-col gap-1.5">
    <h2 className="text-heading text-text-strong">{title}</h2>
    <div className="text-body text-text-subtle flex flex-col gap-1.5">{children}</div>
  </div>
);
