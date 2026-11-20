export const meta = { name: "fail-demo", description: "Script throws" };
await agent("x", { label: "x" });
throw new Error("boom in script");