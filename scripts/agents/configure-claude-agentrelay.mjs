// Compatibility entrypoint: the Claude Code profile of configure-agent.mjs.
if (!process.argv.includes("--profile")) process.argv.push("--profile", "claude-code");
await import("./configure-agent.mjs");
