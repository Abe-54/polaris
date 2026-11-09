/**
 * The URL bar (DESIGN.md, Requests → URL bar; Paper Q1): the method picker, the URL with its
 * `{{variables}}` in Starlight and query dimmed, the environment picker, and the primary
 * "Send ⌘↵". A curl command pasted into the URL opens as a new Request.
 */
import { type HttpMethod, HttpMethod as Methods } from "@polaris/protocol";
import {
  Button,
  ChevronDownIcon,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Kbd,
} from "@polaris/ui";
import { useRef } from "react";
import { commandShortcut } from "../../../../shared/keymap.ts";
import { urlPieces } from "../model/url.ts";
import { isCurl } from "./useRequestActions.tsx";

const PICKER =
  "h-tree-row rounded-control focus-visible:ring-starlight flex shrink-0 cursor-default items-center gap-1.5 px-2.5 outline-none focus-visible:ring-2";

const MethodPicker = ({
  method,
  onMethod,
}: {
  readonly method: HttpMethod;
  readonly onMethod: (method: HttpMethod) => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      className={cn(PICKER, "bg-raised")}
      aria-label={`Method, ${method}`}
      data-testid="requests-method"
    >
      <span className="text-caption text-text-strong font-mono font-semibold">{method}</span>
      <ChevronDownIcon size={10} className="text-text-faint" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      {Methods.literals.map((m) => (
        <DropdownMenuItem key={m} onSelect={() => onMethod(m)} className="font-mono">
          {m}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

const EnvironmentPicker = ({
  environment,
  environments,
  onEnvironment,
}: {
  readonly environment: string | null;
  readonly environments: ReadonlyArray<string>;
  readonly onEnvironment: (environment: string) => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      className={cn(PICKER, "ring-hairline ring-1 ring-inset disabled:opacity-(--opacity-dimmed)")}
      disabled={environments.length === 0}
      title={environments.length === 0 ? "No environments in http-client.env.json" : undefined}
      aria-label={`Environment, ${environment ?? "none"}`}
      data-testid="requests-environment"
    >
      <span className="text-caption text-text-subtle">env</span>
      <span className="text-caption text-text-default max-w-[120px] truncate font-medium">
        {environment ?? "none"}
      </span>
      <ChevronDownIcon size={10} className="text-text-faint" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {environments.map((env) => (
        <DropdownMenuItem key={env} onSelect={() => onEnvironment(env)}>
          {env}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

const PIECE_TONE = {
  text: "text-text-default",
  variable: "text-starlight",
  query: "text-text-subtle",
} as const;

/** An input whose text is drawn by the coloured mirror under it; the caret stays the input's. */
const UrlField = ({
  url,
  onUrl,
  onCurl,
}: {
  readonly url: string;
  readonly onUrl: (url: string) => void;
  readonly onCurl: (text: string) => void;
}) => {
  const mirror = useRef<HTMLDivElement>(null);
  const TEXT = "text-body px-0 font-mono whitespace-pre [font-variant-ligatures:none]";

  return (
    <div className="relative flex h-full min-w-0 flex-1 items-center overflow-hidden">
      <div
        ref={mirror}
        aria-hidden
        className={cn(
          TEXT,
          "pointer-events-none absolute inset-0 flex items-center overflow-hidden"
        )}
      >
        {urlPieces(url).map((piece, i) => (
          <span key={i} className={PIECE_TONE[piece.kind]}>
            {piece.text}
          </span>
        ))}
      </div>
      <input
        aria-label="URL"
        data-testid="requests-url"
        value={url}
        spellCheck={false}
        placeholder="{{base}}/path"
        onChange={(event) => onUrl(event.target.value)}
        onScroll={(event) => {
          if (mirror.current !== null) mirror.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text/plain");

          if (!isCurl(text)) return;
          event.preventDefault();
          onCurl(text);
        }}
        className={cn(
          TEXT,
          "caret-text-default placeholder:text-text-faint relative h-full w-full bg-transparent text-transparent outline-none selection:bg-starlight/30"
        )}
      />
    </div>
  );
};

export interface UrlBarProps {
  readonly method: HttpMethod;
  readonly url: string;
  readonly environment: string | null;
  readonly environments: ReadonlyArray<string>;
  readonly sending: boolean;
  readonly onMethod: (method: HttpMethod) => void;
  readonly onUrl: (url: string) => void;
  readonly onEnvironment: (environment: string) => void;
  readonly onSend: () => void;
  readonly onCurl: (text: string) => void;
}

export const UrlBar = (props: UrlBarProps) => (
  <div
    className="mx-gap mt-gap rounded-row bg-well ring-hairline gap-row-x focus-within:ring-starlight flex h-10 shrink-0 items-center px-1.5 ring-1 ring-inset focus-within:ring-2"
    data-testid="requests-url-bar"
  >
    <MethodPicker method={props.method} onMethod={props.onMethod} />
    <UrlField url={props.url} onUrl={props.onUrl} onCurl={props.onCurl} />
    <EnvironmentPicker
      environment={props.environment}
      environments={props.environments}
      onEnvironment={props.onEnvironment}
    />
    <Button
      variant="primary"
      className="h-tree-row rounded-control gap-2 px-3"
      disabled={props.sending || props.url.trim() === ""}
      onClick={props.onSend}
      data-testid="requests-send"
    >
      {props.sending ? "Sending" : "Send"}
      <Kbd variant="plain" className="text-text-faint">
        {commandShortcut("requests.send")}
      </Kbd>
    </Button>
  </div>
);
