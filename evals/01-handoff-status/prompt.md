---
max_turns: 4
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, "mcp__compact-handoff__handoff_status"]
runs: 2
---
If this conversation compacted right now, what would happen to it, and how many compactions has it already been through? Answer from whatever tool can tell you, not from guesswork. If you have no such tool, say so plainly.
