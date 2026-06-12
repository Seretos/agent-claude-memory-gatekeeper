# agent-claude-memory-gatekeeper

A Claude Code **skill** plugin. Intercepts Claude's memory-save process and redirects new memories into a review folder, so you can approve them before they are persisted and shared.

This plugin ships **only the skill content** — no binaries, no MCP server.

## Install

```
/plugin marketplace add Seretos/agent-marketplace
/plugin install agent-claude-memory-gatekeeper@agent-marketplace
```

If the skill teaches Claude how to use a specific MCP, declare that MCP as a dependency in `.claude-plugin/plugin.json` (`dependencies` array). Claude Code will install/load it automatically.

## What the skill teaches

See `skills/memory-gatekeeper/SKILL.md` for the full content.
