/** A stand-in for Polaris Computer Use.app: each spawned tool is a script the test drives. */
import { Effect, Layer } from "effect";
import { ComputerUseHelper, type HelperProcess } from "../../service/computerUse/index.ts";

export interface FakeTool {
  /** The commands written to its stdin so far, parsed. */
  readonly commands: Array<unknown>;
  readonly running: () => boolean;
  /** Writes to its stdout. */
  readonly emit: (bytes: Uint8Array) => void;
  /** Ends it by itself with `code`. */
  readonly exit: (code: number) => void;
}

/** One record as `polaris-capture` writes it. */
export const frameRecord = (
  frame: { window: number; width: number; height: number; capturedAt: number },
  jpeg: Uint8Array
) => {
  const header = new TextEncoder().encode(
    `${JSON.stringify({ frame: { ...frame, bytes: jpeg.length } })}\n`
  );

  const record = new Uint8Array(header.length + jpeg.length);
  record.set(header);
  record.set(jpeg, header.length);

  return record;
};

export const textRecord = (text: string) => new TextEncoder().encode(text);

export const idleRecord = (reason: string) => textRecord(`${JSON.stringify({ idle: reason })}\n`);

const makeTool = () => {
  const commands: Array<unknown> = [];
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let running = true;
  let reading = true;
  let exited!: (code: number) => void;

  const stdout = new ReadableStream<Uint8Array>({
    start: (controller) => {
      out = controller;
    },
    cancel: () => {
      reading = false;
    },
  });

  const end = (code: number) => {
    if (!running) return;
    running = false;

    if (reading) out.close();
    exited(code);
  };

  const tool: FakeTool = {
    commands,
    running: () => running,
    emit: (bytes) => {
      if (running && reading) out.enqueue(bytes);
    },
    exit: end,
  };

  const process: HelperProcess = {
    via: "disclaim",
    write: (chunk) => {
      for (const line of Buffer.from(chunk).toString().split("\n"))
        if (line !== "") commands.push(JSON.parse(line));
    },
    end: () => end(0),
    stdout,
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    exited: new Promise<number>((resolve) => {
      exited = resolve;
    }),
    kill: () => end(137),
  };

  return { tool, process };
};

/** The helper as a layer, and every tool it was asked to start, oldest first. */
export const fakeHelper = () => {
  const tools: Array<FakeTool> = [];

  const layer = Layer.succeed(ComputerUseHelper)(
    ComputerUseHelper.of({
      bundle: Effect.succeed("/fake/Polaris Computer Use.app"),
      spawn: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const made = makeTool();
            tools.push(made.tool);

            return made.process;
          }),
          (running) => Effect.sync(() => running.kill("SIGKILL"))
        ),
      permissions: Effect.succeed({ state: "ready", missing: [] }),
    })
  );

  return { layer, tools, running: () => tools.filter((tool) => tool.running()).length };
};
