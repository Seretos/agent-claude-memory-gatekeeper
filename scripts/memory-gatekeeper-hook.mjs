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
 * Check whether a resolved target path is inside the gatekeeper tree root.
 *
 * Uses normalised (forward-slash) prefix matching to avoid false positives
 * from shared-prefix directory names.
 *
 * @param {string} resolvedTarget — absolute resolved target path
 * @param {string} gatekeeperRoot — absolute gatekeeper root path
 * @returns {boolean}
 */
function isInsideGatekeeperTree(resolvedTarget, gatekeeperRoot) {
  const normTarget = normalisePath(resolvedTarget);
  const normRoot = normalisePath(gatekeeperRoot);
  // Must be equal to root or start with root + "/"
  return normTarget === normRoot || normTarget.startsWith(normRoot + "/");
}

/**
 * Parse a file path that lives directly inside a gatekeeper tree.
 *
 * Handles two cases (in priority order):
 *   1. Env-var root:     <envDir>/<slug>/memory/<rest>
 *      — only when envDir is set and is an absolute path.
 *   2. Default root:     …/gatekeeper/<slug>/memory/<rest>
 *
 * Returns `{ slug, rest }` or `null` when the path does not match either form.
 * This is the fallback for paths that have no `projects/` segment and therefore
 * cannot be matched by parseMemoryPath.
 *
 * @param {string} filePath — the target path (may be relative; will be resolved)
 * @param {string} [envDir] — value of CLAUDE_MEMORY_GATEKEEPER_DIR (may be undefined)
 * @returns {{ slug: string, rest: string }|null}
 */
function parseGatekeeperTreePath(filePath, envDir) {
  const resolved = path.resolve(filePath);
  const normalised = normalisePath(resolved);

  // Case 1: env-var custom root — <envDir>/<slug>/memory/<rest>
  if (envDir && path.isAbsolute(envDir)) {
    const normEnvDir = normalisePath(envDir);
    // Strip trailing slash for uniform prefix matching.
    const normRoot = normEnvDir.endsWith("/") ? normEnvDir.slice(0, -1) : normEnvDir;
    const prefix = normRoot + "/";
    if (normalised.startsWith(prefix)) {
      const remainder = normalised.slice(prefix.length);
      // Expect: <slug>/memory/<rest>
      const m = remainder.match(/^([^/]+)\/memory\/(.+)$/);
      if (m) return { slug: m[1], rest: m[2] };
    }
  }

  // Case 2: default gatekeeper root — …/gatekeeper/<slug>/memory/<rest>
  const m = normalised.match(/\/gatekeeper\/([^/]+)\/memory\/(.+)$/);
  if (m) return { slug: m[1], rest: m[2] };

  return null;
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
 * Generate (or regenerate) a MEMORY.md index inside a gatekeeper memory directory.
 *
 * Lists every `.md` file in `gatekeeperMemoryDir` (excluding MEMORY.md itself),
 * sorted alphabetically, and writes:
 *
 *   # Memory Index
 *
 *   - [<name without .md>](<filename>)
 *   …
 *
 * Fault-tolerant: any error is written to stderr and the function returns without
 * throwing — the hook must never crash Claude Code.
 *
 * @param {string} gatekeeperMemoryDir — absolute path to the gatekeeper memory directory
 */
function generateMemoryIndex(gatekeeperMemoryDir) {
  try {
    const entries = fs.readdirSync(gatekeeperMemoryDir);
    const mdFiles = entries
      .filter((name) => name.endsWith(".md") && name !== "MEMORY.md")
      .sort();
    let content = "# Memory Index\n";
    if (mdFiles.length > 0) {
      content += "\n";
      for (const filename of mdFiles) {
        const displayName = filename.slice(0, -3); // strip .md
        content += `- [${displayName}](${filename})\n`;
      }
    }
    fs.writeFileSync(path.join(gatekeeperMemoryDir, "MEMORY.md"), content);
  } catch (err) {
    process.stderr.write(
      `memory-gatekeeper-hook: generateMemoryIndex error: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }
}

/**
 * Derive the project name from the current working directory.
 *
 * @returns {string} — the last path segment of process.cwd()
 */
function deriveProjectName() {
  return path.basename(process.cwd());
}

/**
 * Stamp a `project: <name>` YAML frontmatter line into file content.
 *
 * Convention:
 *   - If content begins with `---\n`, insert/update `project:` inside that block.
 *   - Otherwise, prepend `---\nproject: <name>\n---\n`.
 *
 * @param {string} content     — existing file content
 * @param {string} projectName — project name to stamp
 * @returns {string}           — content with project: frontmatter
 */
function stampProjectFrontmatter(content, projectName) {
  if (content.startsWith("---\n")) {
    // Find the closing ---
    const closingIdx = content.indexOf("\n---", 4);
    if (closingIdx !== -1) {
      // We have a frontmatter block.
      const frontmatter = content.slice(0, closingIdx);
      const rest = content.slice(closingIdx);
      // Check if project: already exists inside the block.
      const projectLineRe = /^project:.*$/m;
      if (projectLineRe.test(frontmatter)) {
        // Update existing project: line.
        return frontmatter.replace(projectLineRe, `project: ${projectName}`) + rest;
      } else {
        // Insert project: line after the opening ---.
        return "---\n" + `project: ${projectName}\n` + frontmatter.slice(4) + rest;
      }
    }
    // No closing --- found — treat as no frontmatter block, prepend.
    return `---\nproject: ${projectName}\n---\n` + content;
  }
  // No frontmatter — prepend block.
  return `---\nproject: ${projectName}\n---\n` + content;
}

/**
 * Apply a single Edit operation (old_string → new_string) to content.
 *
 * Replicates Claude Code Edit semantics:
 *   - replaceAll === true: replace all occurrences.
 *   - Otherwise: exactly one occurrence must exist; throws if 0 or >1.
 *
 * @param {string} content   — file content to edit
 * @param {string} oldString — text to find
 * @param {string} newString — text to replace with
 * @param {boolean} [replaceAll] — replace all occurrences when true
 * @returns {string} — updated content
 * @throws {Error} — when occurrence count is not exactly 1 (and replaceAll is not true)
 */
function applyEdit(content, oldString, newString, replaceAll) {
  if (replaceAll === true) {
    return content.split(oldString).join(newString);
  }
  // Count occurrences.
  let count = 0;
  let idx = 0;
  while (true) {
    const found = content.indexOf(oldString, idx);
    if (found === -1) break;
    count++;
    idx = found + oldString.length;
  }
  if (count === 0) {
    throw new Error(
      `old_string not found in content: ${JSON.stringify(oldString.slice(0, 80))}`
    );
  }
  if (count > 1) {
    throw new Error(
      `old_string found ${count} times; use replace_all to replace all occurrences`
    );
  }
  return content.slice(0, content.indexOf(oldString)) +
    newString +
    content.slice(content.indexOf(oldString) + oldString.length);
}

/**
 * Classify an Edit call to determine what action is needed.
 *
 * Returns one of:
 *   "seed-and-apply" — gatekeeper copy absent, live file exists → seed then apply.
 *   "apply"          — gatekeeper copy exists and content equals live file content.
 *   "divergent"      — gatekeeper copy exists and differs from live file.
 *   "pass-through"   — neither gatekeeper copy nor live file exists → exit 0.
 *
 * @param {string} gatekeeperPath — resolved gatekeeper file path
 * @param {string} liveFilePath   — original target path (inside projects/…/memory/…)
 * @returns {"seed-and-apply"|"apply"|"divergent"|"pass-through"}
 */
function classifyEditCase(gatekeeperPath, liveFilePath) {
  const gatekeeperExists = fs.existsSync(gatekeeperPath);

  if (!gatekeeperExists) {
    const liveExists = fs.existsSync(liveFilePath);
    if (liveExists) return "seed-and-apply";
    return "pass-through";
  }

  // Gatekeeper copy exists — compare contents with live.
  try {
    const liveExists = fs.existsSync(liveFilePath);
    if (!liveExists) {
      // Gatekeeper exists but live does not — treat as divergent
      // (gatekeeper has content that was never committed to live).
      return "divergent";
    }
    const gkContent = fs.readFileSync(gatekeeperPath, "utf8");
    const liveContent = fs.readFileSync(liveFilePath, "utf8");
    if (gkContent === liveContent) return "apply";
    return "divergent";
  } catch {
    // Fault-tolerant: if reads fail, treat as divergent (safe default).
    return "divergent";
  }
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
 * Build context for a successfully applied edit.
 * Contains no forbidden words in prose.
 *
 * @param {string} gatekeeperPath — absolute path to the staged copy
 * @returns {string}
 */
function buildAppliedContext(gatekeeperPath) {
  return (
    `Edit applied to the staged copy at ${gatekeeperPath}. ` +
    `You do not need to edit this file further. ` +
    `You do not manage MEMORY.md.`
  );
}

/**
 * Build context for the divergent case — staged copy has local changes.
 * Contains no forbidden words in prose.
 *
 * @param {string} gatekeeperPath — absolute path to the staged copy
 * @returns {string}
 */
function buildDivergentContext(gatekeeperPath) {
  return (
    `The staged copy at ${gatekeeperPath} has existing changes. ` +
    `Read that file and edit it directly.`
  );
}

/**
 * Build context for a hard-deny on MEMORY.md writes.
 * Contains no forbidden words in prose.
 *
 * @returns {string}
 */
function buildMemoryMdDenyContext() {
  return (
    `MEMORY.md is auto-generated and cannot be written directly. ` +
    `Do not write this file.`
  );
}

/**
 * Build context for a rejected empty Write.
 * Contains no forbidden words in prose.
 *
 * @param {string} gatekeeperPath — absolute path to the staged copy
 * @returns {string}
 */
function buildEmptyWriteDenyContext(gatekeeperPath) {
  return (
    `Empty content is not accepted. ` +
    `Write a non-empty file to ${gatekeeperPath} to stage changes. ` +
    `An empty file at that path signals a deletion.`
  );
}

/**
 * Build deny context for an attempt to delete or empty a file that is already
 * inside the submitted memory tree. Contains no forbidden words in prose.
 *
 * @param {string} filePath — absolute path to the file targeted for deletion
 * @returns {string}
 */
function buildGatekeeperDeleteDenyContext(filePath) {
  return (
    `Submitted memories can only be removed by the user. ` +
    `The file at ${filePath} has not been modified.`
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
 * Regex that matches a path segment of the form:
 *   gatekeeper/<slug>/memory/<rest>
 *
 * Used to intercept delete-intent Bash commands targeting gatekeeper-tree paths
 * that do NOT contain a `projects/` segment and therefore bypass parseBashCommand.
 */
const GATEKEEPER_PATH_RE = /\S*gatekeeper\/[^/\s"';]+\/memory\/\S+/;

/**
 * Regex that matches any path ending in /<slug>/memory/<rest>.
 * Used as a broader fallback to detect paths under a custom env-var gatekeeper root
 * that does not have 'gatekeeper' as a literal segment.
 */
const ANY_MEMORY_SUFFIX_RE = /\S+\/[^/\s"';]+\/memory\/\S+/;

/**
 * Extract the first gatekeeper-tree path found anywhere in a Bash command string.
 *
 * Two detection strategies are attempted in priority order:
 *   1. Default-root pattern: path contains a literal `gatekeeper/` segment.
 *   2. Env-var-root pattern: path ends in `/<slug>/memory/<rest>` and the
 *      optional `envDir` is set, absolute, and is a prefix of that path.
 *
 * The command is normalised to forward slashes before matching so that Windows
 * paths are handled correctly. The returned string is in normalised
 * (forward-slash) form.
 *
 * @param {string} command   — the full Bash command string
 * @param {string} [envDir]  — value of CLAUDE_MEMORY_GATEKEEPER_DIR (may be undefined)
 * @returns {string|null}    — matched path substring (forward slashes), or null if not found
 */
function parseGatekeeperBashCommand(command, envDir) {
  if (typeof command !== "string") return null;
  const normalised = command.split(path.sep).join("/");

  // Strategy 1: literal 'gatekeeper/' segment in the path.
  const gkMatch = normalised.match(GATEKEEPER_PATH_RE);
  if (gkMatch) return gkMatch[0];

  // Strategy 2: env-var custom root — any /<slug>/memory/<rest> path whose
  // normalised form starts with the normalised envDir prefix.
  if (envDir && path.isAbsolute(envDir)) {
    const normEnvDir = envDir.split(path.sep).join("/").replace(/\/$/, "");
    const anyMatch = normalised.match(ANY_MEMORY_SUFFIX_RE);
    if (anyMatch) {
      const candidate = anyMatch[0];
      if (candidate.startsWith(normEnvDir + "/") || candidate === normEnvDir) {
        return candidate;
      }
    }
  }

  return null;
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
      // No memory path (projects/…/memory/…) found. Check for a direct gatekeeper-tree path.
      const gkDetectedPath = parseGatekeeperBashCommand(command, envDir);
      if (gkDetectedPath && classifyBashIntent(command) === "delete") {
        // Block delete-intent against the gatekeeper tree. Leave file intact — no tombstone.
        emitDeny(buildGatekeeperDeleteDenyContext(gkDetectedPath));
      }
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

    // Hard-deny MEMORY.md in Bash path.
    if (parsed.rest === "MEMORY.md") {
      emitDeny(buildMemoryMdDenyContext());
      process.exit(0);
    }

    const intent = classifyBashIntent(command);
    const gatekeeperPath = resolveGatekeeperPath(parsed, envDir);
    const gatekeeperDir = path.dirname(gatekeeperPath);
    const additionalContext = buildBashDenyContext(detectedPathRel, intent);

    if (intent === "delete") {
      // Seed a zero-byte tombstone in the gatekeeper tree.
      // The deny is emitted unconditionally below — even when the tombstone
      // write fails — so the destructive command is never allowed through.
      try {
        fs.mkdirSync(gatekeeperDir, { recursive: true });
        fs.writeFileSync(gatekeeperPath, "");
        const gatekeeperRoot = resolveGatekeeperRoot(parsed, envDir);
        bootstrapObsidian(gatekeeperRoot, parsed.base);
        generateMemoryIndex(gatekeeperDir);
      } catch (err) {
        process.stderr.write(
          `memory-gatekeeper-hook: tombstone write failed: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    }
    // write-intent: hard deny, no gatekeeper file written.
    // deny is ALWAYS emitted regardless of tombstone outcome.

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
  if (!parsed) {
    // Fallback: check whether the target is a direct write into a gatekeeper tree
    // (path has no `projects/` segment — e.g. <base>/gatekeeper/<slug>/memory/<rest>
    // or <envDir>/<slug>/memory/<rest>).
    const gkParsed = parseGatekeeperTreePath(targetPath, envDir);
    if (gkParsed) {
      // MEMORY.md writes must be denied.
      if (gkParsed.rest === "MEMORY.md") {
        emitDeny(buildMemoryMdDenyContext());
        process.exit(0);
      }
      // Block empty-Write and content-wiping Edit/MultiEdit against the gatekeeper tree.
      const resolvedTarget = path.resolve(targetPath);
      if (toolName === "Write") {
        const content = typeof toolInput.content === "string" ? toolInput.content : "";
        if (content === "") {
          emitDeny(buildGatekeeperDeleteDenyContext(resolvedTarget));
          process.exit(0);
        }
      } else if (toolName === "Edit") {
        const newString = typeof toolInput.new_string === "string" ? toolInput.new_string : "";
        if (newString === "") {
          emitDeny(buildGatekeeperDeleteDenyContext(resolvedTarget));
          process.exit(0);
        }
      } else if (toolName === "MultiEdit") {
        const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
        const hasWipingEdit = edits.some(
          (e) => typeof e.new_string === "string" && e.new_string === ""
        );
        if (hasWipingEdit) {
          emitDeny(buildGatekeeperDeleteDenyContext(resolvedTarget));
          process.exit(0);
        }
      }
    }
    process.exit(0);
  }

  const gatekeeperPath = resolveGatekeeperPath(parsed, envDir);
  const gatekeeperDir = path.dirname(gatekeeperPath);

  // -------------------------------------------------------------------------
  // Gatekeeper-path pass-through guard (infinite-loop prevention).
  // If the target path is already inside the gatekeeper tree, let it through.
  // -------------------------------------------------------------------------
  const gatekeeperRoot = resolveGatekeeperRoot(parsed, envDir);
  if (isInsideGatekeeperTree(path.resolve(targetPath), gatekeeperRoot)) {
    if (parsed.rest === "MEMORY.md") {
      emitDeny(buildMemoryMdDenyContext());
      process.exit(0);
    }
    // Block destructive ops (empty-Write, content-wiping Edit/MultiEdit) against
    // gatekeeper-tree files even when the path contains a `projects/` segment.
    const resolvedTarget = path.resolve(targetPath);
    if (toolName === "Write") {
      const content = typeof toolInput.content === "string" ? toolInput.content : "";
      if (content === "") {
        emitDeny(buildGatekeeperDeleteDenyContext(resolvedTarget));
        process.exit(0);
      }
    } else if (toolName === "Edit") {
      const newString = typeof toolInput.new_string === "string" ? toolInput.new_string : "";
      if (newString === "") {
        emitDeny(buildGatekeeperDeleteDenyContext(resolvedTarget));
        process.exit(0);
      }
    } else if (toolName === "MultiEdit") {
      const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
      const hasWipingEdit = edits.some(
        (e) => typeof e.new_string === "string" && e.new_string === ""
      );
      if (hasWipingEdit) {
        emitDeny(buildGatekeeperDeleteDenyContext(resolvedTarget));
        process.exit(0);
      }
    }
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Hard-deny MEMORY.md (non-Bash path)
  // -------------------------------------------------------------------------
  if (parsed.rest === "MEMORY.md") {
    emitDeny(buildMemoryMdDenyContext());
    process.exit(0);
  }

  if (toolName === "Write") {
    const content = typeof toolInput.content === "string" ? toolInput.content : "";

    // Reject empty content.
    if (content === "") {
      emitDeny(buildEmptyWriteDenyContext(gatekeeperPath));
      process.exit(0);
    }

    // Stamp project: frontmatter.
    const projectName = deriveProjectName();
    const stampedContent = stampProjectFrontmatter(content, projectName);

    fs.mkdirSync(gatekeeperDir, { recursive: true });
    fs.writeFileSync(gatekeeperPath, stampedContent);
    emitDeny(buildAdditionalContext(gatekeeperPath));
    bootstrapObsidian(gatekeeperRoot, parsed.base);
    generateMemoryIndex(gatekeeperDir);
    process.exit(0);
  }

  if (toolName === "Edit" || toolName === "MultiEdit") {
    const liveFilePath = path.resolve(targetPath);
    const editCase = classifyEditCase(gatekeeperPath, liveFilePath);

    if (editCase === "pass-through") {
      // Neither gatekeeper copy nor live file — let Claude Code surface the error.
      process.exit(0);
    }

    if (editCase === "seed-and-apply") {
      // Seed from live (with project: stamp), then apply the edit.
      try {
        const liveContent = fs.readFileSync(liveFilePath, "utf8");
        const projectName = deriveProjectName();
        const seededContent = stampProjectFrontmatter(liveContent, projectName);
        fs.mkdirSync(gatekeeperDir, { recursive: true });
        fs.writeFileSync(gatekeeperPath, seededContent);

        // Apply the edit(s) to the newly-seeded copy.
        if (toolName === "Edit") {
          const oldString = typeof toolInput.old_string === "string" ? toolInput.old_string : "";
          const newString = typeof toolInput.new_string === "string" ? toolInput.new_string : "";
          const replaceAll = toolInput.replace_all === true;
          try {
            const currentContent = fs.readFileSync(gatekeeperPath, "utf8");
            const updatedContent = applyEdit(currentContent, oldString, newString, replaceAll);
            fs.writeFileSync(gatekeeperPath, updatedContent);
          } catch {
            // Edit apply failed — fall through with seeded content, emit divergent.
            emitDeny(buildDivergentContext(gatekeeperPath));
            bootstrapObsidian(gatekeeperRoot, parsed.base);
            generateMemoryIndex(gatekeeperDir);
            process.exit(0);
          }
        } else {
          // MultiEdit — apply sequentially.
          const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
          let currentContent = fs.readFileSync(gatekeeperPath, "utf8");
          let applyFailed = false;
          for (const edit of edits) {
            try {
              currentContent = applyEdit(
                currentContent,
                typeof edit.old_string === "string" ? edit.old_string : "",
                typeof edit.new_string === "string" ? edit.new_string : "",
                edit.replace_all === true
              );
            } catch {
              applyFailed = true;
              break;
            }
          }
          if (applyFailed) {
            emitDeny(buildDivergentContext(gatekeeperPath));
            bootstrapObsidian(gatekeeperRoot, parsed.base);
            generateMemoryIndex(gatekeeperDir);
            process.exit(0);
          }
          fs.writeFileSync(gatekeeperPath, currentContent);
        }

        emitDeny(buildAppliedContext(gatekeeperPath));
        bootstrapObsidian(gatekeeperRoot, parsed.base);
        generateMemoryIndex(gatekeeperDir);
        process.exit(0);
      } catch {
        // Any FS error during seed — emit divergent feedback.
        emitDeny(buildDivergentContext(gatekeeperPath));
        bootstrapObsidian(gatekeeperRoot, parsed.base);
        process.exit(0);
      }
    }

    if (editCase === "apply") {
      // Gatekeeper copy == live: apply the edit(s) directly to review copy.
      if (toolName === "Edit") {
        const oldString = typeof toolInput.old_string === "string" ? toolInput.old_string : "";
        const newString = typeof toolInput.new_string === "string" ? toolInput.new_string : "";
        const replaceAll = toolInput.replace_all === true;
        try {
          const currentContent = fs.readFileSync(gatekeeperPath, "utf8");
          const updatedContent = applyEdit(currentContent, oldString, newString, replaceAll);
          fs.writeFileSync(gatekeeperPath, updatedContent);
          emitDeny(buildAppliedContext(gatekeeperPath));
        } catch {
          emitDeny(buildDivergentContext(gatekeeperPath));
        }
      } else {
        // MultiEdit.
        const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
        let currentContent;
        try {
          currentContent = fs.readFileSync(gatekeeperPath, "utf8");
        } catch {
          emitDeny(buildDivergentContext(gatekeeperPath));
          bootstrapObsidian(gatekeeperRoot, parsed.base);
          generateMemoryIndex(gatekeeperDir);
          process.exit(0);
        }
        let applyFailed = false;
        for (const edit of edits) {
          try {
            currentContent = applyEdit(
              currentContent,
              typeof edit.old_string === "string" ? edit.old_string : "",
              typeof edit.new_string === "string" ? edit.new_string : "",
              edit.replace_all === true
            );
          } catch {
            applyFailed = true;
            break;
          }
        }
        if (applyFailed) {
          emitDeny(buildDivergentContext(gatekeeperPath));
        } else {
          try {
            fs.writeFileSync(gatekeeperPath, currentContent);
            emitDeny(buildAppliedContext(gatekeeperPath));
          } catch {
            emitDeny(buildDivergentContext(gatekeeperPath));
          }
        }
      }
      bootstrapObsidian(gatekeeperRoot, parsed.base);
      generateMemoryIndex(gatekeeperDir);
      process.exit(0);
    }

    // editCase === "divergent"
    emitDeny(buildDivergentContext(gatekeeperPath));
    bootstrapObsidian(gatekeeperRoot, parsed.base);
    generateMemoryIndex(gatekeeperDir);
    process.exit(0);
  }

  if (toolName === "NotebookEdit") {
    const liveFilePath = path.resolve(targetPath);
    const editCase = classifyEditCase(gatekeeperPath, liveFilePath);

    if (editCase === "pass-through") {
      process.exit(0);
    }

    if (editCase === "seed-and-apply") {
      fs.mkdirSync(gatekeeperDir, { recursive: true });
      try {
        fs.copyFileSync(liveFilePath, gatekeeperPath);
      } catch {
        // Fault-tolerant.
      }
    }

    emitDeny(buildAdditionalContext(gatekeeperPath));
    bootstrapObsidian(gatekeeperRoot, parsed.base);
    generateMemoryIndex(gatekeeperDir);
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
  // New exports for ticket #6
  isInsideGatekeeperTree,
  deriveProjectName,
  stampProjectFrontmatter,
  applyEdit,
  buildAppliedContext,
  buildDivergentContext,
  buildMemoryMdDenyContext,
  buildEmptyWriteDenyContext,
  // New export for ticket #14
  parseGatekeeperTreePath,
  // New export for ticket #15
  generateMemoryIndex,
  // New exports for ticket #16
  buildGatekeeperDeleteDenyContext,
  parseGatekeeperBashCommand,
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
