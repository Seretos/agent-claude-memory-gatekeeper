# agent-claude-memory-gatekeeper

A Claude Code **hook-only** plugin. No binary, no MCP server.

## What it does

Claude Code stores per-project memories under a path of the form:

```
<base>/projects/<slug>/memory/<file>
```

Any agent write or delete targeting that subtree is silently intercepted. The content (or a deletion signal) is redirected into a parallel **gatekeeper tree** that you control, and the original memory store is left untouched. Human promotion from the gatekeeper tree to the live tree is an entirely manual, out-of-band step.

**Threat model.** Without this plugin an agent can freely rewrite its own memory, including overwriting safety-relevant instructions. The hook closes that loop by making every memory mutation visible for human review before it takes effect.

## Tool coverage

The `PreToolUse` hook fires on all five write-capable tool calls:

| Tool | Action |
|------|--------|
| `Write` | Content redirected as-is into the gatekeeper tree; deny emitted. |
| `Edit` | Gatekeeper copy seeded from the live file (if absent), then deny. |
| `MultiEdit` | Same as `Edit`. |
| `NotebookEdit` | Same as `Edit` (uses `notebook_path` field). |
| `Bash` | Command scanned for a memory path anywhere in the string. Write-intent: hard deny, no file written. Delete-intent (`rm`, `del`, `Remove-Item`, `unlink`, `truncate`, `Clear-Content`): zero-byte **tombstone** seeded in the gatekeeper tree + deny. |

**Delete tombstones.** A zero-byte file at a gatekeeper path is the signal that the agent wanted to delete that memory. The apply/accept tool (#6) reads tombstones as delete instructions.

**Fail-closed.** Any tool name not listed above that carries an in-scope memory path is also denied. Unknown tools are treated as write attempts.

## Hard enforcement via managed-settings.json

The hook is a best-effort layer — a sufficiently motivated agent could bypass it by constructing tool calls that avoid the hook. For fleet or shared-machine deployments, add a `permissions.deny` rule in the platform-managed settings file so Claude Code's own permission engine enforces the restriction regardless of hooks:

```json
{
  "permissions": {
    "deny": [
      "Write(**/projects/*/memory/**)",
      "Edit(**/projects/*/memory/**)",
      "MultiEdit(**/projects/*/memory/**)",
      "NotebookEdit(**/projects/*/memory/**)",
      "Bash(rm **/projects/*/memory/**)",
      "Bash(del **/projects/*/memory/**)"
    ]
  }
}
```

Platform-managed settings paths (Claude Code reads these in addition to `~/.claude/settings.json`):

| Platform | Path |
|----------|------|
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json` |
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux / WSL | `/etc/claude-code/managed-settings.json` |

**Drop-in directory (recommended for multi-policy setups):**  
Many deployments prefer a `managed-settings.d/` directory so each policy is a separate file:

```
/etc/claude-code/managed-settings.d/20-memory-gatekeeper.json
```

**Fleet-management alternatives:**

- **macOS MDM:** push the preferences via `com.anthropic.claudecode` plist key.
- **Windows Group Policy / Registry:** `HKLM\SOFTWARE\Policies\ClaudeCode`.

The `deny` rules cover both write and delete paths; any `Bash` command matching the memory tree is blocked at the platform level.

## Configuration

**`CLAUDE_CONFIG_DIR`** (optional env var)

Claude Code stores its configuration and memory under a canonical root directory. The hook uses this path to determine which writes are targeting live memory and therefore need interception. Any `projects/<slug>/memory/…` path that does **not** sit under the resolved config dir is silently passed through — this prevents false positives from git worktrees or other directories that happen to have a `projects/*/memory` layout.

| Setting | Config dir used |
|---------|----------------|
| Unset or relative | `~/.claude` (POSIX) / `%APPDATA%\.claude` (Windows) |
| Absolute path | `$CLAUDE_CONFIG_DIR` |

You do not normally need to set this variable. Claude Code itself sets `CLAUDE_CONFIG_DIR` when the user has moved the config root. The hook will automatically pick up whatever value Claude Code uses.

**`CLAUDE_MEMORY_GATEKEEPER_DIR`** (optional env var)

Set this to an absolute path to choose a custom gatekeeper root. If unset or a relative path, the default is used.

| Setting | Gatekeeper root |
|---------|----------------|
| Unset or relative | `<base>/gatekeeper/` |
| Absolute path | `$CLAUDE_MEMORY_GATEKEEPER_DIR/` |

Redirected files land at `<gatekeeper-root>/<slug>/memory/<rest>`, mirroring the live tree layout.

**Obsidian bootstrap.** On the first redirected write to a gatekeeper root, the hook copies the bundled `.obsidian` template into that root (idempotent). The Obsidian memory-gatekeeper plugin can then present both the gatekeeper copies and the live tree side-by-side for review.

## Promotion flow

Manual, never automated:

1. Inspect `<gatekeeper-root>/<slug>/memory/` for new or modified files.
2. **Non-empty file** — the agent wanted to write or update this memory. Copy it to the corresponding live path if you accept the change.
3. **Zero-byte file (tombstone)** — the agent wanted to delete this memory. Delete the live file if you accept the deletion; delete the tombstone when done.
4. Remove the gatekeeper copy once you have acted on it (or archived it).

## Install

```
/plugin marketplace add Seretos/agent-marketplace
/plugin install agent-claude-memory-gatekeeper@agent-marketplace
```
