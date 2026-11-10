/**
 * A turn's Review over a fixed patch and findings as the app's root when Metro's environment asks
 * for it (`EXPO_PUBLIC_POLARIS_REVIEW_PREVIEW=1`); `-polarisDevTheme moonlit` picks the theme.
 * Questions to the reviewer answer themselves after a moment. Development builds only.
 */
import {
  IntentGroup,
  LineRange,
  RiskFinding,
  RiskFindingId,
  RiskSummary,
  Walkthrough,
} from "@polaris/protocol";
import { Predicate, Schema } from "effect";
import { useEffect, useState } from "react";
import { Platform, Settings } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SheetHost } from "../../sheet/index.tsx";
import { ThemeName, ThemeProvider, useTheme } from "../../theme/index.ts";
import type { DiffFileInput } from "../diffRows.ts";
import { parsePatch } from "../patch.ts";
import { summary as testSummary } from "../review.testing.ts";
import type { AskEntry } from "../ReviewScreen/useAsks.ts";
import { ReviewView } from "../ReviewView.tsx";

const PATCH = [
  "diff --git a/src/artifact/upload.ts b/src/artifact/upload.ts",
  "--- a/src/artifact/upload.ts",
  "+++ b/src/artifact/upload.ts",
  "@@ -36,10 +36,13 @@ upload()",
  ' import { put } from "./store";',
  " ",
  "-export async function upload(req: Request) {",
  "+export async function upload(req: Request, limit = MAX_BYTES) {",
  "   const id = crypto.randomUUID();",
  "-  const body = await req.text();",
  "+  const body = await req.arrayBuffer();",
  "+  if (body.byteLength > limit) {",
  '+    return new Response("Artifact is larger than the upload limit", { status: 413 });',
  "+  }",
  "   await put(id, body);",
  "   return Response.json({ id, url: `${BASE}/a/${id}` });",
  " }",
  " ",
  " export const MAX_BYTES = 8 * 1024 * 1024;",
  "diff --git a/src/serve.ts b/src/serve.ts",
  "--- a/src/serve.ts",
  "+++ b/src/serve.ts",
  "@@ -1,6 +1,7 @@ export const serve",
  ' import { publish } from "./artifact";',
  "-const URL = process.env.ARTIFACT_URL;",
  '+const URL = process.env.ARTIFACT_URL ?? "http://localhost:4000";',
  '+const KEY = "sk-ant-api03-demo";',
  " publish(URL);",
  " retry(() => publish(URL));",
  " ",
  " export default URL;",
  "diff --git a/deploy/prototype.yml b/deploy/prototype.yml",
  "--- a/deploy/prototype.yml",
  "+++ b/deploy/prototype.yml",
  "@@ -1,4 +1,5 @@",
  " service: artifacts",
  "-replicas: 1",
  "+replicas: 3",
  "+public: true",
  " region: iad",
  " ",
  "",
].join("\n");

const FILES: ReadonlyArray<DiffFileInput> = parsePatch(PATCH).map((diff) => ({
  diff,
  added: diff.hunks.reduce((n, h) => n + h.additionLines, 0),
  removed: diff.hunks.reduce((n, h) => n + h.deletionLines, 0),
}));

const finding = (
  id: string,
  severity: RiskFinding["severity"],
  path: string,
  line: number,
  title: string,
  reason: string
) =>
  new RiskFinding({
    id: RiskFindingId.make(id),
    identity: id,
    source: severity === "critical" ? "rule" : "agent",
    ruleId: null,
    path,
    lines: new LineRange({ start: line, end: line, side: "new" }),
    severity,
    confidence: severity === "critical" ? 0.97 : 0.74,
    title,
    reason,
    suggestion: null,
    status: "open",
    resolution: null,
  });

const FINDINGS = [
  finding(
    "secret",
    "critical",
    "src/serve.ts",
    3,
    "Secret-like value committed",
    "An Anthropic API key is hard-coded and will ship. Read it from the environment."
  ),
  finding(
    "public",
    "critical",
    "deploy/prototype.yml",
    3,
    "Prototype deploy is public",
    "The service is opened to the internet with no auth in front of it."
  ),
  finding(
    "memory",
    "high",
    "src/artifact/upload.ts",
    39,
    "Upload is read whole before the size check",
    "The body lands in memory before the limit applies, so a large upload still costs its size."
  ),
  finding(
    "retry",
    "medium",
    "src/serve.ts",
    5,
    "Retry has no limit",
    "It retries forever when the store refuses."
  ),
  finding(
    "status",
    "low",
    "src/artifact/upload.ts",
    40,
    "413 has no retry hint",
    "Clients can’t tell whether a smaller upload would pass."
  ),
  finding(
    "title",
    "low",
    "deploy/prototype.yml",
    2,
    "Replica count is hard-coded",
    "Three replicas for a prototype may cost more than it needs."
  ),
];

const group = (
  key: string,
  category: IntentGroup["category"],
  critical: boolean,
  paths: string[]
) =>
  new IntentGroup({
    key,
    label:
      {
        upload: "Cap the upload size",
        serve: "Default the artifact URL",
        deploy: "Open the prototype",
      }[key] ?? key,
    summary:
      key === "deploy"
        ? "Makes the prototype **public** with three replicas; nothing checks who calls it."
        : "Adds a limit and a default so a local run works without configuration.",
    category,
    critical,
    paths,
  });

const WALKTHROUGH = new Walkthrough({
  groups: [
    group("deploy", "config", true, ["deploy/prototype.yml"]),
    group("upload", "api", false, ["src/artifact/upload.ts"]),
    group("serve", "core", false, ["src/serve.ts"]),
  ],
  state: "ready",
  markdown: "",
  head: "9be04d",
  fromHead: null,
  fullSummaryId: null,
  harness: null,
  model: null,
  effort: null,
  sessionId: null,
  lines: 0,
  tokensEstimate: null,
  filesRead: 3,
  filesTotal: 3,
  startedAt: null,
  durationMs: null,
  tokens: null,
  reason: null,
  evidence: null,
});

// Built on first render: a release bundle resolves review.testing.ts to an empty module (ENG-555).
const previewSummary = (): RiskSummary => {
  const base = testSummary("completed", FINDINGS);

  return new RiskSummary({
    walkthrough: WALKTHROUGH,
    id: base.id,
    key: base.key,
    workspaceId: base.workspaceId,
    subject: base.subject,
    checkoutId: base.checkoutId,
    status: base.status,
    layers: base.layers,
    reviewer: base.reviewer,
    cost: base.cost,
    note: base.note,
    findings: base.findings,
    startedAt: base.startedAt,
    endedAt: base.endedAt,
  });
};

const ANSWER =
  "Yes. `upload()` reads the **whole body** with `arrayBuffer()` before it compares the size, so the limit only decides the response; stream the body and stop at `limit` instead.";

const launchTheme = (): ThemeName | null => {
  const value: unknown = Platform.OS === "ios" ? Settings.get("polarisDevTheme") : undefined;

  return Schema.is(ThemeName)(value) ? value : null;
};

const noop = () => undefined;

const ROOT = { flex: 1 };

const Preview = () => {
  const { setTheme } = useTheme();
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const [asks, setAsks] = useState<ReadonlyArray<AskEntry>>([]);
  const [summary] = useState(previewSummary);

  useEffect(() => {
    const theme = launchTheme();

    if (theme !== null) setTheme(theme);
    // Launch arguments are read once.
  }, []);

  const answer = (id: string) =>
    setAsks((all) =>
      all.map((a) => (a.id === id ? { ...a, answer: { kind: "answered", text: ANSWER } } : a))
    );

  return (
    <ReviewView
      scope="preview"
      turnNumber={24}
      sessionTitle="Cap artifact uploads"
      harnessName="Claude Code"
      files={FILES}
      diffProblem={null}
      summary={summary}
      accept={{ kind: "paused", critical: 2 }}
      colourblind={false}
      notice={null}
      sent={sent}
      asks={asks}
      askBlocked={null}
      onBack={noop}
      onAccept={noop}
      onSendBack={noop}
      onAskToFix={(f) => setSent((s) => new Set([...s, f.id]))}
      onVerdict={noop}
      onAskReviewer={(f, question) => {
        const id = `${f.id}:${asks.length}`;

        setAsks((all) => [
          ...all,
          {
            id,
            question,
            findingId: f.id,
            answer: { kind: "thinking", step: "Read src/artifact/upload.ts" },
          },
        ]);
        setTimeout(() => answer(id), 2500);
      }}
    />
  );
};

/** The preview root component, or null when the preview wasn't asked for. */
export const reviewPreviewRoot = (): (() => React.JSX.Element) | null => {
  // Read whole: Expo inlines EXPO_PUBLIC_ variables only where they are named in full.
  const env: unknown = process.env.EXPO_PUBLIC_POLARIS_REVIEW_PREVIEW;

  if (!__DEV__ || !Predicate.isString(env) || env === "") return null;

  return () => (
    <GestureHandlerRootView style={ROOT}>
      <SafeAreaProvider>
        <ThemeProvider>
          <SheetHost>
            <Preview />
          </SheetHost>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
};
