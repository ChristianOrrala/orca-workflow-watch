export const meta = {
  name: "demo-review",
  description: "Stub demo with phases, agents and a checkpoint",
  phases: [{ title: "Scan" }, { title: "Review" }],
};
phase("Scan");
log("scanning " + args.repo);
const a = await agent("Count files in " + args.repo, { label: "count", schema: { type: "object", properties: { files: { type: "number" } }, required: ["files"] } });
const [b, c] = await parallel([() => agent("Summarize", { label: "summary" }), () => agent("FAIL on purpose", { label: "broken" })]);
phase("Review");
const ok = await checkpoint("Ship the review for " + args.repo + "?", { kind: "confirm" });
return { a, b, c, ok };
