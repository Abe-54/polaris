import { expect, test } from "bun:test";
import { Effect, Schema, Stream } from "effect";
import { EditPredictionFormat, type PredictionEndpoint } from "@polaris/protocol";
import { createEditPredictor } from "./index.ts";
import { hardeningCases, hardeningRequest, hardeningRuns } from "./hardening.testing.ts";
import { applyEdits } from "./guards.ts";
import { editResult } from "./result.ts";

const normalized = (text: string) => text.replace(/\s/g, "");

test.skipIf(process.env.POLARIS_PREDICTION_LIVE !== "1")(
  "live next-edit quality on all 100 hardening cases",
  async () => {
    const url = process.env.POLARIS_EDIT_URL;
    const model = process.env.POLARIS_EDIT_MODEL;
    const format = Schema.decodeUnknownSync(EditPredictionFormat)(process.env.POLARIS_EDIT_FORMAT);

    if (!url || !model)
      throw new Error("Set POLARIS_EDIT_URL, POLARIS_EDIT_MODEL and POLARIS_EDIT_FORMAT");

    if (new URL(url).port === "8080")
      throw new Error("This harness does not use the shared server on :8080");

    const kind: PredictionEndpoint["kind"] =
      process.env.POLARIS_EDIT_KIND === "ollama" ? "ollama" : "openai";

    const predictor = createEditPredictor();
    const table = { exact: 0, acceptable: 0, wrong: 0, dangerous: 0, abstain: 0, unreviewed: 0 };
    const timings: number[] = [];

    for (const fixture of hardeningCases) {
      const input = { ...hardeningRequest(fixture, format), model, endpoint: { kind, url } };

      const items = await Effect.runPromise(
        predictor.predict(input, { signal: AbortSignal.timeout(120000) }).pipe(Stream.runCollect)
      );

      expect(items).toHaveLength(1);
      const result = items[0]!;
      timings.push(result.elapsedMs);
      const actual = normalized(applyEdits(input.buffer, result.edits));
      const allowed = fixture.allowed.map((patch) => normalized(applyEdits(input.buffer, patch)));

      const known = hardeningRuns
        .filter((run) => run.format === format)
        .flatMap((run) =>
          run.outputs
            .filter((recorded) => recorded.id === fixture.id)
            .map((recorded) => ({
              ...recorded,
              label: run.labels[recorded.id]?.label,
            }))
        )
        .find(
          (recorded) =>
            normalized(
              applyEdits(
                input.buffer,
                editResult(hardeningRequest(fixture, format), recorded.output, 0).edits
              )
            ) === actual
        );

      const label = !result.edits.length
        ? "abstain"
        : allowed.includes(actual)
          ? "exact"
          : (known?.label ?? "unreviewed");

      table[label]++;
      console.log(
        JSON.stringify({
          id: fixture.id,
          label,
          elapsedMs: result.elapsedMs,
          suppressed: result.suppressed,
          edits: label === "unreviewed" ? result.edits : undefined,
        })
      );
    }

    timings.sort((a, b) => a - b);

    const scores =
      format === "zeta-2.1" ? table : { ...table, p50Ms: timings[Math.floor(timings.length / 2)] };

    console.table([{ format, ...scores }]);
    console.log(
      "Exact uses the spike's whitespace-insensitive rule. Other labels require a matching hand-reviewed output; novel outputs remain unreviewed."
    );

    if (format === "zeta-2.1")
      console.log(
        "Zeta fixture model is on external storage: recorded durations are diagnostic, not speed measurements."
      );
    else console.log("Endpoint rolling p50:", predictor.p50({ kind, url }));

    expect(timings).toHaveLength(hardeningCases.length);
  },
  3_700_000
);
