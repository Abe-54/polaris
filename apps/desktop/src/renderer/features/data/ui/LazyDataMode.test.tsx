/** Warming Data's chunk (ENG-905) never reads the staged edits shelf; Data opening does. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, mock, test } from "bun:test";
import { createWarmup } from "../../../app/warmModes.ts";
import { modeChunk } from "../../../shell/modeChunk.ts";
import { providers } from "../../traces/ui/mode.testing.tsx";
import { dataModeOver } from "./LazyDataMode.tsx";

afterEach(cleanup);

const never = () => new Promise<never>(() => undefined);

test("the warm-up imports the chunk without opening the shelf; opening Data opens it", async () => {
  const openEditsShelf = mock(() => undefined);

  const chunk = modeChunk(() =>
    Promise.resolve({ DataMode: () => <div data-testid="data-loaded" />, openEditsShelf })
  );

  const DataMode = dataModeOver(chunk);

  await new Promise<void>((resolve) => {
    createWarmup([{ load: () => chunk.load().finally(resolve) }], (run) => run()).start();
  });
  expect(chunk.loaded()).not.toBeNull();
  expect(openEditsShelf).not.toHaveBeenCalled();

  const { wrapper: Wrapper } = providers({
    watch: () => () => undefined,
    get: never,
    span: never,
    compare: never,
  });

  render(
    <Wrapper>
      <DataMode />
    </Wrapper>
  );
  expect(screen.queryByTestId("data-loaded")).not.toBeNull();
  expect(openEditsShelf).toHaveBeenCalled();
});
