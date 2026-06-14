<!-- AGENTS.md authoring rule (keep this comment in the template; delete it in a real plugin):
     Document ONLY what an agent cannot derive by reading the code and the file tree.
     - DO capture: cross-file / cross-repo contracts, non-obvious conventions, gotchas and
       their "why", external requirements (secrets, services), and deliberate design choices.
     - DON'T restate: the directory layout, what a workflow YAML does step-by-step, or how a
       build script works line-by-line — an agent reads those directly. If a sentence only
       narrates a file the reader already has in front of them, cut it.
     A lean AGENTS.md the agent trusts beats an exhaustive one it has to re-verify. -->

# agent-claude-memory-gatekeeper

Hook-only plugin — no binary, no MCP server. Ships a `PreToolUse` hook (`hooks/hooks.json` → `scripts/memory-gatekeeper-hook.mjs`) that fires on `Write|Edit` tool calls. When the target path is inside Claude Code's file-based memory store (`projects/<slug>/memory/…`), the hook denies the write and silently redirects the content into a configurable gatekeeper tree (`<base>/gatekeeper/<slug>/memory/…` by default, or `CLAUDE_MEMORY_GATEKEEPER_DIR/<slug>/memory/…` when that env var is an absolute path). Human review and promotion of gatekeeper copies is a manual out-of-band step — the plugin never automates approval.

## Contracts an agent won't infer from the tree

- **Release is orphan-branch + marketplace dispatch.** `release.yml` (manual: Actions → release → `version=X.Y.Z`) stamps the version, then force-pushes an orphan `release` branch holding only install-ready files and POSTs a dispatch (`category: hook`) to `Seretos/agent-marketplace`. `main` and `release` share no history. Clients install at the tag `agent-claude-memory-gatekeeper--vX.Y.Z`.
- **Required secret:** `MARKETPLACE_DISPATCH_TOKEN` — fine-grained PAT, `Contents: RW` + `Pull requests: RW` on `Seretos/agent-marketplace` only.
- **`assets/icon.png` is a release artifact, not just a repo file.** The dispatch payload sends a `raw.githubusercontent.com/${repo}/${TAG}/assets/icon.png` URL to the marketplace, so the file must live on the orphan `release` branch at the tagged commit — `release.yml`'s stage step copies `assets/` into the staging tree for exactly that reason. Ship `assets/icon.png` from day one or the marketplace listing has no image.
- **`description.md` is a release artifact, not just a repo file.** The dispatch payload sends a `raw.githubusercontent.com/${repo}/${TAG}/description.md` URL in the `description_url` field, so the file must live on the orphan `release` branch at the tagged commit — `release.yml` copies it into the staging tree alongside `assets/`. Fill in its Key Features before cutting v0.0.1.

## Hook design constraints

- **The hook is stateless and event-limited.** It fires only on `PreToolUse` write/delete events (Write, Edit, MultiEdit, NotebookEdit, Bash). It never sees accept, discard, or repair events — those are Obsidian plugin actions that happen entirely outside the hook's lifecycle.
- **`MEMORY.md` authorship belongs solely to the Obsidian plugin (`obsidian-memory-gatekeeper`).** The plugin regenerates the index on every accept, discard, and via its repair button. The hook does not generate or update `MEMORY.md`.
- **The hook hard-denies direct writes to `MEMORY.md` — that deny is preserved.** Any attempt by an agent to write `MEMORY.md` directly (into the live projects tree or the gatekeeper tree) is blocked. The hook's role ends there; it does not produce the index itself.
- **Anti-pattern to avoid — do not attach lifecycle features to the hook.** Because the hook sees only one direction of one event type, any index, stats, or metadata it writes will be stale or contradictory the moment an accept, discard, or repair happens. Features that depend on the full accept/discard/repair lifecycle must live in the Obsidian plugin, not the hook.
