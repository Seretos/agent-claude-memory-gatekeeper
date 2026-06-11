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
