#!/usr/bin/env node
/**
 * PreToolUse hook — memory gatekeeper.
 *
 * Fires on Write and Edit. When the target path is inside Claude Code's
 * file-based memory store (…/projects/<slug>/memory/…), the write is denied
 * and the content is redirected into a gatekeeper tree instead.
 *
 * Gatekeeper root resolution (in priority order):
 *   1. $CLAUDE_MEMORY_GATEKEEPER_DIR/<slug>/memory/<rest>
 *      — only when the env var is set AND is an absolute path.
 *   2. <base>/gatekeeper/<slug>/memory/<rest>
 *      — where <base> is everything before the `projects/` segment.
 *
 * On the first memory write that is redirected, the hook bootstraps a valid
 * Obsidian vault at the gatekeeper root if `.obsidian` is absent there.
 * Bootstrap is fault-tolerant: any error is written to stderr and ignored.
 *
 * Human review of the gatekeeper copies is an out-of-band manual step.
 * This hook never promotes or approves anything automatically.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Normalise a file-system path to forward slashes for uniform matching.
 * The original path (with OS separators) is returned for all FS operations;
 * this normalised form is used only for segment matching.
 */
function normalisePath(p) {
  return p.split(path.sep).join("/");
}

/**
 * Parse a file path for the memory-store pattern.
 *
 * Matches: …/projects/<slug>/memory/<rest>
 *   - `projects` segment must be present.
 *   - Exactly one `<slug>` segment follows.
 *   - Then `memory`.
 *   - Then at least one further segment.
 *
 * Returns `{ base, slug, rest }` or `null` when the path does not match.
 *
 * `base`  — absolute path up to (not including) the `projects/` segment,
 *           taken verbatim from the original (OS-separator) path.
 * `slug`  — the project slug string.
 * `rest`  — the remainder after `memory/` (forward-slash separated).
 */
function parseMemoryPath(filePath) {
  const normalised = normalisePath(path.resolve(filePath));
  // Match: <base>/projects/<slug>/memory/<rest>
  const match = normalised.match(/^(.*?)\/projects\/([^/]+)\/memory\/(.+)$/);
  if (!match) return null;

  const [, baseNorm, slug, rest] = match;

  // Recover the original-separator base by taking the same prefix length from
  // the resolved path (resolve() uses OS separators).
  const resolved = path.resolve(filePath);
  const base = resolved.slice(0, baseNorm.length);

  return { base, slug, rest };
}

/**
 * Resolve the gatekeeper root directory from a parsed memory path and the
 * optional env var.
 *
 * @param {object} parsed   — result of parseMemoryPath: { base, slug, rest }
 * @param {string} [envDir] — value of CLAUDE_MEMORY_GATEKEEPER_DIR (may be undefined)
 * @returns {string}        — absolute path to the gatekeeper root
 */
function resolveGatekeeperRoot(parsed, envDir) {
  if (envDir && path.isAbsolute(envDir)) return envDir;
  return path.join(parsed.base, "gatekeeper");
}

/**
 * Resolve the absolute gatekeeper path for a given parsed memory path.
 *
 * @param {object} parsed   — result of parseMemoryPath: { base, slug, rest }
 * @param {string} [envDir] — value of CLAUDE_MEMORY_GATEKEEPER_DIR (may be undefined)
 * @returns {string}        — absolute path inside the gatekeeper tree
 */
function resolveGatekeeperPath(parsed, envDir) {
  const { slug, rest } = parsed;
  const gatekeeperRoot = resolveGatekeeperRoot(parsed, envDir);
  return path.join(gatekeeperRoot, slug, "memory", ...rest.split("/"));
}

/**
 * Bootstrap a valid Obsidian vault at `gatekeeperRoot` if `.obsidian` is absent.
 *
 * Idempotent: if `.obsidian` already exists, returns immediately.
 * Fault-tolerant: any error is written to stderr and the function returns
 * without throwing — the hook must never crash Claude Code.
 *
 * @param {string} gatekeeperRoot — the gatekeeper root directory
 * @param {string} base           — the Claude projects base (used for data.json targetFolder)
 * @param {string} [templateDir]  — path to the `.obsidian` template dir (injected by tests)
 */
function bootstrapObsidian(
  gatekeeperRoot,
  base,
  templateDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../obsidian-template/.obsidian"
  )
) {
  try {
    const obsidianDir = path.join(gatekeeperRoot, ".obsidian");

    // Idempotent: already bootstrapped.
    if (fs.existsSync(obsidianDir)) return;

    // Template missing → graceful no-op (e.g. local dev without plugin build).
    if (!fs.existsSync(templateDir)) return;

    // Copy the static template tree.
    fs.cpSync(templateDir, obsidianDir, { recursive: true });

    // Generate the machine-specific data.json for the memory-gatekeeper plugin.
    const pluginDir = path.join(obsidianDir, "plugins", "memory-gatekeeper");
    fs.mkdirSync(pluginDir, { recursive: true });

    const dataJson = {
      targetFolder: path.join(base, "projects"),
      includeExtensions: ["md"],
      pollIntervalMs: 4000,
      graphHighlightColor: 16733525,
      dismissed: {},
    };
    fs.writeFileSync(
      path.join(pluginDir, "data.json"),
      JSON.stringify(dataJson, null, 2) + "\n"
    );
  } catch (err) {
    process.stderr.write(
      `memory-gatekeeper-hook: bootstrapObsidian error: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }
}

/**
 * Classify an Edit call to determine what action is needed.
 *
 * Returns one of:
 *   "seed-and-deny"   — gatekeeper copy absent, live file exists → seed from live.
 *   "deny-existing"   — gatekeeper copy already exists → no re-seed.
 *   "pass-through"    — neither gatekeeper copy nor live file exists → exit 0.
 *
 * @param {string} gatekeeperPath — resolved gatekeeper file path
 * @param {string} liveFilePath   — original target path (inside projects/…/memory/…)
 * @returns {"seed-and-deny"|"deny-existing"|"pass-through"}
 */
function classifyEditCase(gatekeeperPath, liveFilePath) {
  const gatekeeperExists = fs.existsSync(gatekeeperPath);
  if (gatekeeperExists) return "deny-existing";

  const liveExists = fs.existsSync(liveFilePath);
  if (liveExists) return "seed-and-deny";

  return "pass-through";
}

/**
 * Build the additionalContext string directing the agent to use the gatekeeper
 * path. Contains no approval/pending/review/gatekeeper language.
 *
 * @param {string} gatekeeperPath — absolute path to the redirected file
 * @returns {string}
 */
function buildAdditionalContext(gatekeeperPath) {
  return (
    `Memory writes to this path are redirected. ` +
    `Write to the following path instead: ${gatekeeperPath}`
  );
}

/**
 * Emit a PreToolUse deny response to stdout.
 *
 * @param {string} gatekeeperPath — the redirected destination
 */
function emitDeny(gatekeeperPath) {
  const reason = "Memory writes are redirected to a separate tree.";
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      additionalContext: buildAdditionalContext(gatekeeperPath),
    },
  };
  process.stdout.write(JSON.stringify(output) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Read stdin — be fully fault-tolerant.
  let input;
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) process.exit(0);
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = input.tool_input && typeof input.tool_input === "object"
    ? input.tool_input
    : {};

  // Both Write and Edit use `file_path` in their tool schema.
  const targetPath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
  if (!targetPath) process.exit(0);

  // Scope test: must match …/projects/<slug>/memory/…
  const parsed = parseMemoryPath(targetPath);
  if (!parsed) process.exit(0);

  const envDir = process.env.CLAUDE_MEMORY_GATEKEEPER_DIR;
  const gatekeeperPath = resolveGatekeeperPath(parsed, envDir);
  const gatekeeperDir = path.dirname(gatekeeperPath);

  if (toolName === "Write") {
    const content = typeof toolInput.content === "string" ? toolInput.content : "";
    fs.mkdirSync(gatekeeperDir, { recursive: true });
    fs.writeFileSync(gatekeeperPath, content);
    emitDeny(gatekeeperPath);
    const gatekeeperRoot = resolveGatekeeperRoot(parsed, envDir);
    bootstrapObsidian(gatekeeperRoot, parsed.base);
    process.exit(0);
  }

  if (toolName === "Edit") {
    const liveFilePath = path.resolve(targetPath);
    const editCase = classifyEditCase(gatekeeperPath, liveFilePath);

    if (editCase === "pass-through") {
      // Neither gatekeeper copy nor live file — let Claude Code surface the error.
      process.exit(0);
    }

    if (editCase === "seed-and-deny") {
      fs.mkdirSync(gatekeeperDir, { recursive: true });
      fs.copyFileSync(liveFilePath, gatekeeperPath);
    }
    // "deny-existing": gatekeeper copy already there — no re-seed.

    emitDeny(gatekeeperPath);
    const gatekeeperRoot = resolveGatekeeperRoot(parsed, envDir);
    bootstrapObsidian(gatekeeperRoot, parsed.base);
    process.exit(0);
  }

  // Unknown tool name — pass through.
  process.exit(0);
}

// Export pure helpers for tests.
export {
  parseMemoryPath,
  resolveGatekeeperPath,
  resolveGatekeeperRoot,
  classifyEditCase,
  buildAdditionalContext,
  bootstrapObsidian,
};

// Only run main() when executed directly (not imported as a module).
const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `memory-gatekeeper-hook: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }
}
