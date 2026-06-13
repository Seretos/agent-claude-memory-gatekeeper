#!/usr/bin/env node
/**
 * PreToolUse hook — memory gatekeeper.
 *
 * Fires on Write, Edit, MultiEdit, NotebookEdit, and Bash. When the target
 * path is inside Claude Code's file-based memory store
 * (…/projects/<slug>/memory/…), the write is denied and the content is
 * redirected into a gatekeeper tree instead.
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
 *
 * Bash interception:
 *   - If the command references a memory path, intent is classified:
 *     - delete-intent: a zero-byte tombstone is seeded in the gatekeeper tree.
 *     - write-intent: hard deny, no gatekeeper file written.
 *   - If the command has no memory path reference, it passes through.
 *
 * Default-deny (fail-closed): any unrecognised tool name that carries an
 * in-scope path emits a deny. Out-of-scope / unparseable path → pass-through.
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
 * @param {string} additionalContext — context message for the agent
 */
function emitDeny(additionalContext) {
  const reason = "Memory writes are redirected to a separate tree.";
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(output) + "\n");
}

// ---------------------------------------------------------------------------
// Bash-specific helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Regex that matches a full path ending in the memory-store pattern.
 *
 * Uses a \S* prefix to capture any non-whitespace path prefix (e.g. an
 * absolute path on any platform) before the `projects/` segment.
 * The `rest` stops at the first whitespace character.
 *
 * NOTE: Regex literals cannot include an unescaped `/` inside a character
 * class in all engines/parsers, so this regex is forward-slash-only.
 * `parseBashCommand` normalises the command to forward slashes before matching.
 */
const MEMORY_PATH_RE = /\S*projects\/[^/\s"';]+\/memory\/\S+/;

/**
 * Extract the first memory path found anywhere in a Bash command string.
 *
 * The command is normalised to forward slashes before matching so that
 * Windows paths (backslash-separated) are found correctly.
 * The returned string is in normalised (forward-slash) form.
 *
 * @param {string} command — the full Bash command string
 * @returns {string|null}  — the matched path substring (forward slashes), or null if not found
 */
function parseBashCommand(command) {
  if (typeof command !== "string") return null;
  // Normalise OS-specific separators to forward slashes for uniform matching.
  const normalised = command.split(path.sep).join("/");
  const match = normalised.match(MEMORY_PATH_RE);
  return match ? match[0] : null;
}

/**
 * DELETE_INTENT_RE matches delete verbs as whole words (case-insensitive).
 * Covered: rm, del, Remove-Item, unlink, truncate, Clear-Content.
 */
const DELETE_INTENT_RE =
  /\b(rm|del|Remove-Item|unlink|truncate|Clear-Content)\b/i;

/**
 * Classify the intent of a Bash command that references a memory path.
 *
 * @param {string} command — the full Bash command string
 * @returns {"delete"|"write"}
 */
function classifyBashIntent(command) {
  if (DELETE_INTENT_RE.test(command)) return "delete";
  return "write";
}

/**
 * Build deny context for a Bash command that references a memory path.
 * Contains no approval/pending/review/gatekeeper language.
 *
 * @param {string} detectedPath — the memory path extracted from the command
 * @param {"delete"|"write"} intent — the classified intent
 * @returns {string}
 */
function buildBashDenyContext(detectedPath, intent) {
  if (intent === "delete") {
    return (
      `Memory deletions via Bash are intercepted. ` +
      `A deletion marker has been recorded for: ${detectedPath}. ` +
      `No further action is needed.`
    );
  }
  // write intent
  return (
    `Memory writes via Bash are not permitted. ` +
    `Use the Write tool to write to the detected memory path: ${detectedPath}`
  );
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

  const envDir = process.env.CLAUDE_MEMORY_GATEKEEPER_DIR;

  // -------------------------------------------------------------------------
  // Bash — extract memory path from command string (not from file_path)
  // -------------------------------------------------------------------------

  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    const detectedPathRel = parseBashCommand(command);
    if (!detectedPathRel) {
      // No memory path found in the command → pass through.
      process.exit(0);
    }

    // Build a resolvable absolute path from the relative memory path fragment.
    // parseBashCommand returns the projects/…/memory/… fragment; we need to
    // resolve it to extract slug/rest. Use process.cwd() as the base for
    // path.resolve so it behaves consistently.
    //
    // If the command contains an absolute path the fragment will still start
    // from `projects/` but may be preceded by a prefix — that's fine because
    // parseMemoryPath does a suffix match.
    const parsed = parseMemoryPath(path.resolve(detectedPathRel));
    if (!parsed) {
      // Unparseable → pass through (fault-tolerant).
      process.exit(0);
    }

    const intent = classifyBashIntent(command);
    const gatekeeperPath = resolveGatekeeperPath(parsed, envDir);
    const gatekeeperDir = path.dirname(gatekeeperPath);
    const additionalContext = buildBashDenyContext(detectedPathRel, intent);

    if (intent === "delete") {
      // Seed a zero-byte tombstone in the gatekeeper tree.
      fs.mkdirSync(gatekeeperDir, { recursive: true });
      fs.writeFileSync(gatekeeperPath, "");
      const gatekeeperRoot = resolveGatekeeperRoot(parsed, envDir);
      bootstrapObsidian(gatekeeperRoot, parsed.base);
    }
    // write-intent: hard deny, no gatekeeper file written.

    emitDeny(additionalContext);
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // All other tools: extract target path from tool_input
  // -------------------------------------------------------------------------

  // NotebookEdit uses notebook_path; Write/Edit/MultiEdit use file_path.
  let targetPath = "";
  if (toolName === "NotebookEdit") {
    targetPath =
      typeof toolInput.notebook_path === "string" ? toolInput.notebook_path :
      typeof toolInput.file_path === "string" ? toolInput.file_path :
      "";
  } else {
    targetPath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
  }

  if (!targetPath) process.exit(0);

  // Scope test: must match …/projects/<slug>/memory/…
  const parsed = parseMemoryPath(targetPath);
  if (!parsed) process.exit(0);

  const gatekeeperPath = resolveGatekeeperPath(parsed, envDir);
  const gatekeeperDir = path.dirname(gatekeeperPath);

  if (toolName === "Write") {
    const content = typeof toolInput.content === "string" ? toolInput.content : "";
    fs.mkdirSync(gatekeeperDir, { recursive: true });
    fs.writeFileSync(gatekeeperPath, content);
    emitDeny(buildAdditionalContext(gatekeeperPath));
    const gatekeeperRoot = resolveGatekeeperRoot(parsed, envDir);
    bootstrapObsidian(gatekeeperRoot, parsed.base);
    process.exit(0);
  }

  if (toolName === "Edit" || toolName === "MultiEdit") {
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

    emitDeny(buildAdditionalContext(gatekeeperPath));
    const gatekeeperRoot = resolveGatekeeperRoot(parsed, envDir);
    bootstrapObsidian(gatekeeperRoot, parsed.base);
    process.exit(0);
  }

  if (toolName === "NotebookEdit") {
    const liveFilePath = path.resolve(targetPath);
    const editCase = classifyEditCase(gatekeeperPath, liveFilePath);

    if (editCase === "pass-through") {
      process.exit(0);
    }

    if (editCase === "seed-and-deny") {
      fs.mkdirSync(gatekeeperDir, { recursive: true });
      fs.copyFileSync(liveFilePath, gatekeeperPath);
    }

    emitDeny(buildAdditionalContext(gatekeeperPath));
    const gatekeeperRoot = resolveGatekeeperRoot(parsed, envDir);
    bootstrapObsidian(gatekeeperRoot, parsed.base);
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Default-deny: unknown tool name with an in-scope path → deny (fail closed).
  // The path was already parsed and confirmed in-scope above.
  // -------------------------------------------------------------------------
  emitDeny(buildAdditionalContext(gatekeeperPath));
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
  parseBashCommand,
  classifyBashIntent,
  buildBashDenyContext,
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
