export const meta = { name: "limit-demo", description: "Hits a usage limit", phases: [{ title: "Work" }] };
phase("Work");
await agent("first", { label: "first", model: "claude/sonnet" });
await agent("LIMIT now", { label: "second" });
return 1;