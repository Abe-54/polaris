/** The Links tab: spans in other traces this one links to; each opens there. */
import type { Span } from "@polaris/protocol";
import { fieldText } from "../../model/span/fields.ts";
import { shortId } from "../../model/format.ts";
import { FieldRow, Quiet, Value } from "./parts.tsx";

export const Links = ({
  span,
  onOpen,
}: {
  readonly span: Span;
  readonly onOpen: (traceId: string, spanId: string) => void;
}) =>
  span.links.length === 0 ? (
    <Quiet>This span links to no other spans.</Quiet>
  ) : (
    <ul className="flex flex-col">
      {span.links.map((link) => (
        <li
          key={`${link.traceId}:${link.spanId}`}
          className="border-hairline flex flex-col gap-1 border-b py-2"
          data-testid="span-link"
        >
          <button
            type="button"
            onClick={() => onOpen(link.traceId, link.spanId)}
            className="text-code-inline hover:text-text-strong focus-visible:ring-starlight mx-3 flex cursor-default items-center gap-2 rounded-[4px] px-1 text-left font-mono outline-none focus-visible:ring-2"
          >
            <span className="text-text-subtle">trace</span>
            <span className="text-text-default">{shortId(link.traceId)}</span>
            <span className="text-text-subtle">span</span>
            <span className="text-text-default">{shortId(link.spanId)}</span>
          </button>
          {Object.entries(link.attributes).map(([k, v]) => (
            <FieldRow key={k} name={k}>
              <Value text={fieldText(v)} />
            </FieldRow>
          ))}
        </li>
      ))}
    </ul>
  );
