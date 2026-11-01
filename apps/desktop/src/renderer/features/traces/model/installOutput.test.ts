import { expect, test } from "bun:test";
import { outputTail } from "./installOutput.ts";

const printed = (...chunks: ReadonlyArray<string>) => {
  const tail = outputTail();
  const encoder = new TextEncoder();

  for (const chunk of chunks) tail.push(encoder.encode(chunk));

  return tail;
};

test("a redrawn spinner line keeps its last drawing, colours and blank lines dropped", () => {
  const tail = printed(
    "◒  Cloning\r\u001B[2K◇  Cloned\n\n",
    "\u001B]0;title\u0007\u001B[31m■  failed\u001B[39m\r\n"
  );

  expect(tail.lines(6)).toEqual(["◇  Cloned", "■  failed"]);
});

test("only the newest lines are kept, and a character split across chunks decodes whole", () => {
  const bytes = new TextEncoder().encode("■ x\n");
  const tail = outputTail();

  tail.push(new TextEncoder().encode("a\nb\nc\n"));
  tail.push(bytes.slice(0, 1));
  tail.push(bytes.slice(1));

  expect(tail.lines(2)).toEqual(["c", "■ x"]);
});
