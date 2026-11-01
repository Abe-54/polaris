export const sampled = () => ({
  startTime: 1000,
  endTime: 11000,
  nodes: [
    { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2, 3] },
    {
      id: 2,
      callFrame: { functionName: "caller", url: "file:///checkout/src/main.ts", lineNumber: 9 },
      children: [4],
    },
    { id: 3, callFrame: { functionName: "other", url: "node:internal", lineNumber: 0 } },
    {
      id: 4,
      callFrame: { functionName: "leaf", url: "file:///checkout/src/leaf.ts", lineNumber: 19 },
    },
  ],
  samples: [4, 4, 2, 3],
  timeDeltas: [2000, 3000, 1000, 4000],
});
