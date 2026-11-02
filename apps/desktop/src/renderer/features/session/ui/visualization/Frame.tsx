/**
 * One Visualization frame (ADR 0089): `sandbox="allow-scripts"` with no same-origin, its document
 * served by the main process under its own CSP (`main/frames.ts`). A second page tears it down.
 */
import {
  buildFrameDocument,
  type FrameDocumentOptions,
  type HostMessage,
} from "@polaris/visualization";
import { cn } from "@polaris/ui";
import { Option, Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { polaris } from "../../../bridge.ts";
import { frameRequest } from "./messages.ts";
import { stateWriter, visualizationStates, windowTimers } from "./state.ts";
import { frameTheme, onFrameTheme } from "./theme.ts";

const parseState = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export interface FrameProps {
  /** Polaris's id for the Visualization: its `pv.state` is kept under it. */
  readonly id: string;
  readonly title: string;
  readonly html: string;
  readonly mode: "inline" | "expanded";
  /** The height the frame reported, clamped (inline only). */
  readonly onHeight?: (height: number) => void;
  readonly onOpenLink: (url: string) => void;
  /** It loaded a second page and was removed. */
  readonly onStopped: () => void;
  readonly className?: string;
}

type Source = { readonly src: string } | { readonly srcDoc: string };

const documentFor = ({ id, title, html, mode }: FrameProps) => {
  const { tokens, scheme } = frameTheme();
  const saved = visualizationStates.load(id);
  const state = saved === undefined ? Option.none() : parseState(saved);
  const options: FrameDocumentOptions = { html, title, tokens, scheme, mode };

  return buildFrameDocument(Option.isSome(state) ? { ...options, state: state.value } : options);
};

/** A served URL; the fixture preview, which has no main process, falls back to `srcdoc`. */
const sourceFor = async (document: string): Promise<Source> => {
  const served = await polaris().request("visualization.serve", { document });

  return served.ok ? { src: served.value.url } : { srcDoc: document };
};

const useSource = (props: FrameProps) => {
  const [source, setSource] = useState<Source | null>(null);
  const { id, html, title, mode } = props;

  useEffect(() => {
    let current = true;

    void sourceFor(documentFor({ ...props, id, html, title, mode })).then((next) => {
      if (current) setSource(next);
    });

    return () => {
      current = false;
    };
    // The document is built once per Visualization and mode; the theme then arrives live.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- props' callbacks change every render
  }, [id, html, title, mode]);

  return source;
};

export const Frame = (props: FrameProps) => {
  const { id, title, mode, onHeight, onOpenLink, onStopped, className } = props;
  const ref = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  // Until its document loads, a frame paints the browser's white canvas.
  const [loaded, setLoaded] = useState(false);
  const source = useSource(props);
  const handlers = useRef({ onHeight, onOpenLink, onStopped });

  handlers.current = { onHeight, onOpenLink, onStopped };

  useEffect(() => {
    const states = stateWriter(visualizationStates, id, windowTimers);

    const onMessage = (event: MessageEvent) => {
      const request = frameRequest(event, ref.current?.contentWindow ?? null);

      if (request === null) return;

      switch (request.kind) {
        case "height":
          setLoaded(true);
          handlers.current.onHeight?.(request.height);
          break;
        case "open-link":
          handlers.current.onOpenLink(request.url);
          break;
        case "state":
          states.save(request.json);
          break;
      }
    };

    window.addEventListener("message", onMessage);
    // A reload or quit never unmounts the frame: write its pending state on the way out.
    window.addEventListener("pagehide", states.flush);

    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pagehide", states.flush);
      states.flush();
    };
  }, [id]);

  // A live theme change reaches the frame without a remount.
  useEffect(() => {
    return onFrameTheme(({ tokens, scheme }) => {
      const message: HostMessage = { type: "pv:theme", tokens, scheme };

      // An opaque origin has no name to address: "*" is the only target that reaches it.
      ref.current?.contentWindow?.postMessage(message, "*");
    });
  }, []);

  if (source === null) return null;

  return (
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      data-testid="visualization-frame"
      data-mode={mode}
      className={cn("block w-full border-0", !loaded && "opacity-0", className)}
      onLoad={() => {
        loads.current += 1;
        setLoaded(true);

        if (loads.current > 1) handlers.current.onStopped();
      }}
      {...source}
    />
  );
};
