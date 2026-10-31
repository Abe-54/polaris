import { Schema } from "effect";
import { DataWriteTrace, replayDataWrite } from "./data-write-replay/index.ts";

const paths = process.argv.slice(2);

if (paths.length === 0) throw new Error("Pass a recorded Data write trace path");

for (const path of paths) {
  const trace = Schema.decodeUnknownSync(DataWriteTrace)(await Bun.file(path).json());
  console.log(path, await replayDataWrite(trace));
}
