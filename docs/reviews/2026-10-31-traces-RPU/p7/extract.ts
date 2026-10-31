// Prints fenced code block N (0-based, any language) of a Markdown file verbatim.
// Usage: bun extract.ts <file.md> <index>
const [file, index] = process.argv.slice(2);
const text = await Bun.file(file!).text();
const blocks = [...text.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
const block = blocks[Number(index)];
if (block === undefined) {
  console.error(`${file} has ${blocks.length} blocks`);
  process.exit(1);
}
process.stdout.write(block);
