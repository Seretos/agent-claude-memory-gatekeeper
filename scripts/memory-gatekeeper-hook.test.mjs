#!/usr/bin/env node
/**
 * Tests for memory-gatekeeper-hook.mjs
 *
 * Plain Node.js — no test framework, no external dependencies.
 * Uses fs.mkdtempSync for isolated temp directories per test.
 * Exit code 0 = all pass, non-zero = at least one failure.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  parseMemoryPath,
  resolveGatekeeperPath,
  resolveGatekeeperRoot,
  classifyEditCase,
  buildAdditionalContext,
  bootstrapObsidian,
  parseBashCommand,
  classifyBashIntent,
  buildBashDenyContext,
  // New exports (ticket #6)
  isInsideGatekeeperTree,
  deriveProjectName,
  stampProjectFrontmatter,
  applyEdit,
  buildAppliedContext,
  buildDivergentContext,
  buildMemoryMdDenyContext,
  buildEmptyWriteDenyContext,
  // New exports (ticket #16)
  buildGatekeeperDeleteDenyContext,
  parseGatekeeperBashCommand,
} from "./memory-gatekeeper-hook.mjs";

const HOOK_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "memory-gatekeeper-hook.mjs"
);

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the hook script with given stdin JSON and optional env overrides.
 * Returns { stdout, stderr, status }.
 */
function runHook(inputObj, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [HOOK_SCRIPT],
    {
      input: JSON.stringify(inputObj),
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
    }
  );
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

/**
 * Run the hook script with raw string stdin (for malformed-input tests).
 */
function runHookRaw(rawStdin, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [HOOK_SCRIPT],
    {
      input: rawStdin,
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
    }
  );
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

/**
 * Create a temp directory to serve as the `base` for a fake Claude projects
 * tree. Returns:
 *   { base, slug, memoryDir, liveFile, projectsDir }
 *
 * The caller can create files inside as needed.
 */
function makeTempBase(slug = "my-slug", relPath = "NOTE.md") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-test-"));
  const memoryDir = path.join(base, "projects", slug, "memory");
  const liveFile = path.join(memoryDir, ...relPath.split("/"));
  return { base, slug, memoryDir, liveFile };
}

/**
 * Build a Write tool event for the given file path + content.
 */
function makeWriteEvent(filePath, content = "hello memory") {
  return {
    tool_name: "Write",
    tool_input: { file_path: filePath, content },
  };
}

/**
 * Build an Edit tool event for the given file path.
 */
function makeEditEvent(filePath, oldString = "a", newString = "b") {
  return {
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
  };
}

/**
 * Build a MultiEdit tool event for the given file path.
 */
function makeMultiEditEvent(filePath, edits = [{ old_string: "a", new_string: "b" }]) {
  return {
    tool_name: "MultiEdit",
    tool_input: {
      file_path: filePath,
      edits,
    },
  };
}

/**
 * Build a NotebookEdit tool event for the given notebook path.
 * NotebookEdit uses notebook_path, not file_path.
 */
function makeNotebookEditEvent(notebookPath) {
  return {
    tool_name: "NotebookEdit",
    tool_input: {
      notebook_path: notebookPath,
      cell_type: "code",
      source: "print('hello')",
    },
  };
}

/**
 * Build a Bash tool event for the given command string.
 */
function makeBashEvent(command) {
  return {
    tool_name: "Bash",
    tool_input: { command },
  };
}

/**
 * Create a minimal fake template dir containing at least app.json.
 * Returns the templateDir path.
 */
function makeFakeTemplate() {
  const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-tpl-"));
  fs.writeFileSync(path.join(templateDir, "app.json"), JSON.stringify({ userIgnoreFilters: ["(?<!\\.md)$"] }));
  const pluginDir = path.join(templateDir, "plugins", "memory-gatekeeper");
  fs.mkdirSync(pluginDir, { recursive: true });
  return templateDir;
}

// ---------------------------------------------------------------------------
// Unit tests — pure helpers
// ---------------------------------------------------------------------------

console.log("\n--- Unit tests ---");

test("parseMemoryPath: returns null for path outside projects/*/memory", () => {
  const result = parseMemoryPath("/home/user/CLAUDE.md");
  assertEqual(result, null, "non-memory path");
});

test("parseMemoryPath: returns null for projects/<slug>/CLAUDE.md (no memory segment)", () => {
  const result = parseMemoryPath("/home/user/projects/my-slug/CLAUDE.md");
  assertEqual(result, null, "no memory segment");
});

test("parseMemoryPath: parses a valid memory path", () => {
  const result = parseMemoryPath("/home/user/projects/my-slug/memory/NOTE.md");
  assert(result !== null, "result should not be null");
  assert(result.slug === "my-slug", `slug should be my-slug, got ${result.slug}`);
  assert(result.rest === "NOTE.md", `rest should be NOTE.md, got ${result.rest}`);
});

test("parseMemoryPath: preserves nested sub-path in rest", () => {
  const result = parseMemoryPath("/home/user/projects/my-slug/memory/sub/dir/NOTE.md");
  assert(result !== null, "result should not be null");
  assert(result.rest === "sub/dir/NOTE.md", `rest should be sub/dir/NOTE.md, got ${result.rest}`);
});

test("resolveGatekeeperPath: uses default base/gatekeeper when no env var", () => {
  const parsed = { base: "/home/user", slug: "my-slug", rest: "NOTE.md" };
  const result = resolveGatekeeperPath(parsed, undefined);
  const expected = path.join("/home/user", "gatekeeper", "my-slug", "memory", "NOTE.md");
  assertEqual(result, expected, "default gatekeeper path");
});

test("resolveGatekeeperPath: uses absolute env var when provided", () => {
  const parsed = { base: "/home/user", slug: "my-slug", rest: "NOTE.md" };
  const result = resolveGatekeeperPath(parsed, "/custom/gk");
  const expected = path.join("/custom/gk", "my-slug", "memory", "NOTE.md");
  assertEqual(result, expected, "absolute env var gatekeeper path");
});

test("resolveGatekeeperPath: falls back to default when env var is relative", () => {
  const parsed = { base: "/home/user", slug: "my-slug", rest: "NOTE.md" };
  const result = resolveGatekeeperPath(parsed, "relative/path");
  const expected = path.join("/home/user", "gatekeeper", "my-slug", "memory", "NOTE.md");
  assertEqual(result, expected, "relative env var falls back");
});

test("resolveGatekeeperPath: falls back to default when env var is empty string", () => {
  const parsed = { base: "/home/user", slug: "my-slug", rest: "NOTE.md" };
  const result = resolveGatekeeperPath(parsed, "");
  const expected = path.join("/home/user", "gatekeeper", "my-slug", "memory", "NOTE.md");
  assertEqual(result, expected, "empty env var falls back");
});

// classifyEditCase now returns four outcomes.
test("classifyEditCase: apply when gatekeeper copy exists and content equals live", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-classify-"));
  const gkPath = path.join(tmpDir, "gk.md");
  const liveFile = path.join(tmpDir, "live.md");
  fs.writeFileSync(gkPath, "same content");
  fs.writeFileSync(liveFile, "same content");
  assertEqual(classifyEditCase(gkPath, liveFile), "apply", "apply when contents equal");
  fs.rmSync(tmpDir, { recursive: true });
});

test("classifyEditCase: divergent when gatekeeper copy exists and content differs from live", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-classify-"));
  const gkPath = path.join(tmpDir, "gk.md");
  const liveFile = path.join(tmpDir, "live.md");
  fs.writeFileSync(gkPath, "gatekeeper content");
  fs.writeFileSync(liveFile, "live content");
  assertEqual(classifyEditCase(gkPath, liveFile), "divergent", "divergent when contents differ");
  fs.rmSync(tmpDir, { recursive: true });
});

test("classifyEditCase: divergent when gatekeeper copy exists but live does not", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-classify-"));
  const gkPath = path.join(tmpDir, "gk.md");
  fs.writeFileSync(gkPath, "existing");
  const liveFile = path.join(tmpDir, "live.md"); // does not exist
  assertEqual(classifyEditCase(gkPath, liveFile), "divergent", "divergent when live absent");
  fs.rmSync(tmpDir, { recursive: true });
});

test("classifyEditCase: seed-and-apply when only live file exists", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-classify-"));
  const gkPath = path.join(tmpDir, "gk.md"); // does not exist
  const liveFile = path.join(tmpDir, "live.md");
  fs.writeFileSync(liveFile, "live content");
  assertEqual(classifyEditCase(gkPath, liveFile), "seed-and-apply", "seed-and-apply");
  fs.rmSync(tmpDir, { recursive: true });
});

test("classifyEditCase: pass-through when neither exists", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-classify-"));
  const gkPath = path.join(tmpDir, "gk.md");
  const liveFile = path.join(tmpDir, "live.md");
  assertEqual(classifyEditCase(gkPath, liveFile), "pass-through", "pass-through");
  fs.rmSync(tmpDir, { recursive: true });
});

test("buildAdditionalContext: contains the gatekeeper path", () => {
  const ctx = buildAdditionalContext("/some/gk/path/NOTE.md");
  assert(ctx.includes("/some/gk/path/NOTE.md"), "context contains gatekeeper path");
});

test("buildAdditionalContext: does not contain forbidden words", () => {
  const ctx = buildAdditionalContext("/some/gk/path/NOTE.md").toLowerCase();
  const forbidden = ["approval", "pending", "review", "gatekeeper"];
  for (const word of forbidden) {
    assert(!ctx.includes(word), `additionalContext must not contain '${word}'`);
  }
});

// ---------------------------------------------------------------------------
// Unit tests — resolveGatekeeperRoot
// ---------------------------------------------------------------------------

console.log("\n--- Unit tests: resolveGatekeeperRoot ---");

test("resolveGatekeeperRoot: undefined envDir → base/gatekeeper", () => {
  const parsed = { base: "/home/user", slug: "my-slug", rest: "NOTE.md" };
  const result = resolveGatekeeperRoot(parsed, undefined);
  assertEqual(result, path.join("/home/user", "gatekeeper"), "default root");
});

test("resolveGatekeeperRoot: relative envDir → base/gatekeeper", () => {
  const parsed = { base: "/home/user", slug: "my-slug", rest: "NOTE.md" };
  const result = resolveGatekeeperRoot(parsed, "relative/path");
  assertEqual(result, path.join("/home/user", "gatekeeper"), "relative falls back");
});

test("resolveGatekeeperRoot: empty string envDir → base/gatekeeper", () => {
  const parsed = { base: "/home/user", slug: "my-slug", rest: "NOTE.md" };
  const result = resolveGatekeeperRoot(parsed, "");
  assertEqual(result, path.join("/home/user", "gatekeeper"), "empty falls back");
});

test("resolveGatekeeperRoot: absolute envDir → returns envDir", () => {
  const parsed = { base: "/home/user", slug: "my-slug", rest: "NOTE.md" };
  // Use an OS-valid absolute path.
  const absDir = os.platform() === "win32" ? "C:\\custom\\gk" : "/custom/gk";
  const result = resolveGatekeeperRoot(parsed, absDir);
  assertEqual(result, absDir, "absolute env var returned as-is");
});

// ---------------------------------------------------------------------------
// Unit tests — bootstrapObsidian
// ---------------------------------------------------------------------------

console.log("\n--- Unit tests: bootstrapObsidian ---");

test("bootstrapObsidian: happy path creates .obsidian/app.json and data.json with targetFolder", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-boot-"));
  const gatekeeperRoot = path.join(tmpDir, "gatekeeper");
  const base = path.join(tmpDir, "base");
  const templateDir = makeFakeTemplate();

  bootstrapObsidian(gatekeeperRoot, base, templateDir);

  const obsidianDir = path.join(gatekeeperRoot, ".obsidian");
  assert(fs.existsSync(path.join(obsidianDir, "app.json")), ".obsidian/app.json created");

  const dataJsonPath = path.join(obsidianDir, "plugins", "memory-gatekeeper", "data.json");
  assert(fs.existsSync(dataJsonPath), "data.json created");
  const data = JSON.parse(fs.readFileSync(dataJsonPath, "utf8"));
  assertEqual(data.targetFolder, path.join(base, "projects"), "targetFolder is base/projects");

  fs.rmSync(tmpDir, { recursive: true });
  fs.rmSync(templateDir, { recursive: true });
});

test("bootstrapObsidian: idempotent — sentinel file survives second call", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-boot-"));
  const gatekeeperRoot = path.join(tmpDir, "gatekeeper");
  const base = path.join(tmpDir, "base");
  const templateDir = makeFakeTemplate();

  bootstrapObsidian(gatekeeperRoot, base, templateDir);

  // Write a sentinel file into .obsidian after first bootstrap.
  const sentinel = path.join(gatekeeperRoot, ".obsidian", "sentinel.txt");
  fs.writeFileSync(sentinel, "do-not-overwrite");

  // Second call should be a no-op (obsidianDir already exists).
  bootstrapObsidian(gatekeeperRoot, base, templateDir);

  assert(fs.existsSync(sentinel), "sentinel file still present after second call");
  assertEqual(fs.readFileSync(sentinel, "utf8"), "do-not-overwrite", "sentinel content unchanged");

  fs.rmSync(tmpDir, { recursive: true });
  fs.rmSync(templateDir, { recursive: true });
});

test("bootstrapObsidian: missing template → no throw, no .obsidian created", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-boot-"));
  const gatekeeperRoot = path.join(tmpDir, "gatekeeper");
  const base = path.join(tmpDir, "base");
  const missingTemplate = path.join(tmpDir, "does-not-exist");

  // Must not throw.
  bootstrapObsidian(gatekeeperRoot, base, missingTemplate);

  const obsidianDir = path.join(gatekeeperRoot, ".obsidian");
  assert(!fs.existsSync(obsidianDir), ".obsidian NOT created when template absent");

  fs.rmSync(tmpDir, { recursive: true });
});

test("bootstrapObsidian: error path (gatekeeperRoot is a file) → no throw", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-boot-"));
  // Make gatekeeperRoot a FILE, not a directory, so fs.cpSync will fail.
  const gatekeeperRoot = path.join(tmpDir, "is-a-file");
  fs.writeFileSync(gatekeeperRoot, "i am a file");
  const base = path.join(tmpDir, "base");
  const templateDir = makeFakeTemplate();

  // Must not throw.
  bootstrapObsidian(gatekeeperRoot, base, templateDir);

  fs.rmSync(tmpDir, { recursive: true });
  fs.rmSync(templateDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Unit tests — Bash helpers
// ---------------------------------------------------------------------------

console.log("\n--- Unit tests: parseBashCommand ---");

test("parseBashCommand: returns null for command with no memory path", () => {
  assertEqual(parseBashCommand("ls -la /home/user"), null, "no memory path");
});

test("parseBashCommand: returns null for non-string input", () => {
  assertEqual(parseBashCommand(null), null, "null input");
  assertEqual(parseBashCommand(undefined), null, "undefined input");
});

test("parseBashCommand: detects memory path as first token", () => {
  const result = parseBashCommand("cat projects/my-slug/memory/NOTE.md");
  assert(result !== null, "should match");
  assert(result.includes("projects/my-slug/memory/NOTE.md"), `got: ${result}`);
});

test("parseBashCommand: detects memory path mid-string", () => {
  const result = parseBashCommand("rm -f /base/projects/my-slug/memory/NOTE.md --force");
  assert(result !== null, "should match mid-string");
  assert(result.includes("projects/my-slug/memory/NOTE.md"), `got: ${result}`);
});

test("parseBashCommand: detects memory path at end of string", () => {
  const result = parseBashCommand("cat /some/prefix/projects/my-slug/memory/sub/dir/NOTE.md");
  assert(result !== null, "should match");
  assert(result.includes("projects/my-slug/memory/sub/dir/NOTE.md"), `got: ${result}`);
});

test("parseBashCommand: returns null for projects/<slug>/CLAUDE.md (no memory segment)", () => {
  const result = parseBashCommand("cat projects/my-slug/CLAUDE.md");
  assertEqual(result, null, "no memory segment");
});

console.log("\n--- Unit tests: classifyBashIntent ---");

test("classifyBashIntent: rm → delete", () => {
  assertEqual(classifyBashIntent("rm projects/slug/memory/NOTE.md"), "delete", "rm");
});

test("classifyBashIntent: rm -rf → delete", () => {
  assertEqual(classifyBashIntent("rm -rf projects/slug/memory/NOTE.md"), "delete", "rm -rf");
});

test("classifyBashIntent: del → delete", () => {
  assertEqual(classifyBashIntent("del projects/slug/memory/NOTE.md"), "delete", "del");
});

test("classifyBashIntent: Remove-Item → delete (PowerShell)", () => {
  assertEqual(classifyBashIntent("Remove-Item projects/slug/memory/NOTE.md"), "delete", "Remove-Item");
});

test("classifyBashIntent: remove-item case-insensitive → delete", () => {
  assertEqual(classifyBashIntent("remove-item projects/slug/memory/NOTE.md"), "delete", "remove-item lower");
});

test("classifyBashIntent: unlink → delete", () => {
  assertEqual(classifyBashIntent("unlink projects/slug/memory/NOTE.md"), "delete", "unlink");
});

test("classifyBashIntent: truncate → delete", () => {
  assertEqual(classifyBashIntent("truncate -s 0 projects/slug/memory/NOTE.md"), "delete", "truncate");
});

test("classifyBashIntent: Clear-Content → delete (PowerShell)", () => {
  assertEqual(classifyBashIntent("Clear-Content projects/slug/memory/NOTE.md"), "delete", "Clear-Content");
});

test("classifyBashIntent: cat (read) → write", () => {
  assertEqual(classifyBashIntent("cat projects/slug/memory/NOTE.md"), "write", "cat");
});

test("classifyBashIntent: echo redirect → write", () => {
  assertEqual(classifyBashIntent("echo hello > projects/slug/memory/NOTE.md"), "write", "echo");
});

test("classifyBashIntent: cp → write", () => {
  assertEqual(classifyBashIntent("cp file.txt projects/slug/memory/NOTE.md"), "write", "cp");
});

console.log("\n--- Unit tests: buildBashDenyContext ---");

test("buildBashDenyContext: delete intent contains detected path", () => {
  const ctx = buildBashDenyContext("projects/slug/memory/NOTE.md", "delete");
  assert(ctx.includes("projects/slug/memory/NOTE.md"), "contains path");
});

test("buildBashDenyContext: write intent mentions Write tool and detected path", () => {
  const ctx = buildBashDenyContext("projects/slug/memory/NOTE.md", "write");
  assert(ctx.includes("projects/slug/memory/NOTE.md"), "contains path");
  assert(ctx.includes("Write"), "mentions Write tool");
});

test("buildBashDenyContext: delete intent has no forbidden words", () => {
  const ctx = buildBashDenyContext("projects/slug/memory/NOTE.md", "delete").toLowerCase();
  // Strip the embedded path first (may contain segments like 'memory').
  const proseOnly = ctx.replace("projects/slug/memory/note.md", "");
  for (const word of ["approval", "pending", "review", "gatekeeper"]) {
    assert(!proseOnly.includes(word), `delete context must not contain '${word}'`);
  }
});

test("buildBashDenyContext: write intent has no forbidden words", () => {
  const ctx = buildBashDenyContext("projects/slug/memory/NOTE.md", "write").toLowerCase();
  const proseOnly = ctx.replace("projects/slug/memory/note.md", "");
  for (const word of ["approval", "pending", "review", "gatekeeper"]) {
    assert(!proseOnly.includes(word), `write context must not contain '${word}'`);
  }
});

// ---------------------------------------------------------------------------
// Unit tests — new helpers (ticket #6)
// ---------------------------------------------------------------------------

console.log("\n--- Unit tests: isInsideGatekeeperTree ---");

test("isInsideGatekeeperTree: path inside root → true", () => {
  const root = "/some/gatekeeper";
  const target = "/some/gatekeeper/slug/memory/NOTE.md";
  assert(isInsideGatekeeperTree(target, root), "inside → true");
});

test("isInsideGatekeeperTree: path equals root → true", () => {
  const root = "/some/gatekeeper";
  assert(isInsideGatekeeperTree(root, root), "equals root → true");
});

test("isInsideGatekeeperTree: shared prefix but not inside → false", () => {
  const root = "/some/gatekeeper";
  const target = "/some/gatekeeperExtra/slug/memory/NOTE.md";
  assert(!isInsideGatekeeperTree(target, root), "shared prefix but outside → false");
});

test("isInsideGatekeeperTree: completely unrelated path → false", () => {
  const root = "/some/gatekeeper";
  const target = "/other/path/NOTE.md";
  assert(!isInsideGatekeeperTree(target, root), "unrelated path → false");
});

console.log("\n--- Unit tests: applyEdit ---");

test("applyEdit: single occurrence replaced", () => {
  const result = applyEdit("hello world", "world", "there");
  assertEqual(result, "hello there", "single replacement");
});

test("applyEdit: zero occurrences throws", () => {
  let threw = false;
  try {
    applyEdit("hello world", "missing", "replacement");
  } catch (e) {
    threw = true;
    assert(e.message.includes("not found"), `error should mention not found: ${e.message}`);
  }
  assert(threw, "should throw when old_string not found");
});

test("applyEdit: two occurrences without replace_all throws", () => {
  let threw = false;
  try {
    applyEdit("hello hello world", "hello", "hi");
  } catch (e) {
    threw = true;
    assert(e.message.includes("2"), `error should mention count: ${e.message}`);
  }
  assert(threw, "should throw when multiple occurrences without replace_all");
});

test("applyEdit: two occurrences with replace_all:true both replaced", () => {
  const result = applyEdit("hello hello world", "hello", "hi", true);
  assertEqual(result, "hi hi world", "all occurrences replaced");
});

test("applyEdit: zero occurrences with replace_all:true returns content unchanged", () => {
  const result = applyEdit("hello world", "missing", "x", true);
  assertEqual(result, "hello world", "no change when not found with replaceAll");
});

console.log("\n--- Unit tests: stampProjectFrontmatter ---");

test("stampProjectFrontmatter: no frontmatter → block prepended", () => {
  const result = stampProjectFrontmatter("# My Note\n\nContent.", "my-project");
  assert(result.startsWith("---\nproject: my-project\n---\n"), "frontmatter prepended");
  assert(result.includes("# My Note"), "original content preserved");
});

test("stampProjectFrontmatter: existing --- block without project: → inserted inside", () => {
  const input = "---\ntitle: My Note\n---\n# Heading\n";
  const result = stampProjectFrontmatter(input, "my-project");
  assert(result.startsWith("---\nproject: my-project\n"), "project inserted at top of block");
  assert(result.includes("title: My Note"), "existing frontmatter preserved");
  assert(result.includes("# Heading"), "body preserved");
});

test("stampProjectFrontmatter: existing project: line → updated in place", () => {
  const input = "---\nproject: old-project\ntitle: My Note\n---\n# Heading\n";
  const result = stampProjectFrontmatter(input, "new-project");
  assert(result.includes("project: new-project"), "project updated");
  assert(!result.includes("project: old-project"), "old project removed");
  assert(result.includes("title: My Note"), "other frontmatter preserved");
});

test("stampProjectFrontmatter: empty content → block prepended", () => {
  const result = stampProjectFrontmatter("", "my-project");
  assertEqual(result, "---\nproject: my-project\n---\n", "block prepended to empty content");
});

test("stampProjectFrontmatter: existing --- block with project: already set → only one project: line", () => {
  const input = "---\nproject: old\n---\ncontent";
  const result = stampProjectFrontmatter(input, "new-project");
  const count = (result.match(/^project:/gm) || []).length;
  assertEqual(count, 1, "only one project: line");
});

console.log("\n--- Unit tests: new message builders ---");

test("buildAppliedContext: contains gatekeeper path", () => {
  const gkPath = "/some/staged/copy/NOTE.md";
  const ctx = buildAppliedContext(gkPath);
  assert(ctx.includes(gkPath), "contains gatekeeper path");
});

test("buildAppliedContext: no forbidden words in prose", () => {
  const gkPath = "/some/path/NOTE.md";
  const ctx = buildAppliedContext(gkPath).toLowerCase();
  const proseOnly = ctx.replace(gkPath.toLowerCase(), "");
  for (const word of ["approval", "pending", "review", "gatekeeper"]) {
    assert(!proseOnly.includes(word), `buildAppliedContext must not contain '${word}'`);
  }
});

test("buildDivergentContext: contains gatekeeper path", () => {
  const gkPath = "/some/staged/copy/NOTE.md";
  const ctx = buildDivergentContext(gkPath);
  assert(ctx.includes(gkPath), "contains gatekeeper path");
});

test("buildDivergentContext: no forbidden words in prose", () => {
  const gkPath = "/some/path/NOTE.md";
  const ctx = buildDivergentContext(gkPath).toLowerCase();
  const proseOnly = ctx.replace(gkPath.toLowerCase(), "");
  for (const word of ["approval", "pending", "review", "gatekeeper"]) {
    assert(!proseOnly.includes(word), `buildDivergentContext must not contain '${word}'`);
  }
});

test("buildMemoryMdDenyContext: no forbidden words in prose", () => {
  const ctx = buildMemoryMdDenyContext().toLowerCase();
  for (const word of ["approval", "pending", "review", "gatekeeper"]) {
    assert(!ctx.includes(word), `buildMemoryMdDenyContext must not contain '${word}'`);
  }
});

test("buildMemoryMdDenyContext: mentions MEMORY.md", () => {
  const ctx = buildMemoryMdDenyContext();
  assert(ctx.includes("MEMORY.md"), "mentions MEMORY.md");
});

test("buildEmptyWriteDenyContext: contains gatekeeper path", () => {
  const gkPath = "/some/staged/copy/NOTE.md";
  const ctx = buildEmptyWriteDenyContext(gkPath);
  assert(ctx.includes(gkPath), "contains gatekeeper path");
});

test("buildEmptyWriteDenyContext: no forbidden words in prose", () => {
  const gkPath = "/some/path/NOTE.md";
  const ctx = buildEmptyWriteDenyContext(gkPath).toLowerCase();
  const proseOnly = ctx.replace(gkPath.toLowerCase(), "");
  for (const word of ["approval", "pending", "review", "gatekeeper"]) {
    assert(!proseOnly.includes(word), `buildEmptyWriteDenyContext must not contain '${word}'`);
  }
});

// ---------------------------------------------------------------------------
// End-to-end tests — via spawned process
// ---------------------------------------------------------------------------

console.log("\n--- End-to-end tests ---");

test("Write in-scope → file lands under base/gatekeeper, not under projects/, deny emitted", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("my-slug", "NOTE.md");
  // liveFile = <base>/projects/my-slug/memory/NOTE.md

  const result = runHook(makeWriteEvent(liveFile, "test content"));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(
    out.hookSpecificOutput.permissionDecision,
    "deny",
    "permissionDecision is deny"
  );

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  assert(fs.existsSync(gkPath), "gatekeeper file created");
  assert(!fs.existsSync(liveFile), "live file NOT created");

  fs.rmSync(base, { recursive: true });
});

test("Write in-scope with absolute CLAUDE_MEMORY_GATEKEEPER_DIR → lands under that root", () => {
  const { base, slug, liveFile } = makeTempBase("proj1", "MEMO.md");
  const customGk = fs.mkdtempSync(path.join(os.tmpdir(), "custom-gk-"));

  const result = runHook(
    makeWriteEvent(liveFile, "custom dir content"),
    { CLAUDE_MEMORY_GATEKEEPER_DIR: customGk }
  );
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const gkPath = path.join(customGk, slug, "memory", "MEMO.md");
  assert(fs.existsSync(gkPath), "file in custom gatekeeper dir");

  fs.rmSync(base, { recursive: true });
  fs.rmSync(customGk, { recursive: true });
});

test("Write in-scope with relative CLAUDE_MEMORY_GATEKEEPER_DIR → falls back to default", () => {
  const { base, slug, liveFile } = makeTempBase("proj2", "NOTE.md");

  const result = runHook(
    makeWriteEvent(liveFile, "relative fallback"),
    { CLAUDE_MEMORY_GATEKEEPER_DIR: "relative/path" }
  );
  assertEqual(result.status, 0, "exit 0");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  assert(fs.existsSync(gkPath), "default gatekeeper used");

  fs.rmSync(base, { recursive: true });
});

test("Write in-scope with empty CLAUDE_MEMORY_GATEKEEPER_DIR → falls back to default", () => {
  const { base, slug, liveFile } = makeTempBase("proj3", "NOTE.md");

  const result = runHook(
    makeWriteEvent(liveFile, "empty fallback"),
    { CLAUDE_MEMORY_GATEKEEPER_DIR: "" }
  );
  assertEqual(result.status, 0, "exit 0");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  assert(fs.existsSync(gkPath), "default gatekeeper used");

  fs.rmSync(base, { recursive: true });
});

test("additionalContext names absolute gatekeeper path and prose contains no forbidden words", () => {
  const { base, slug, liveFile } = makeTempBase("proj4", "NOTE.md");

  const result = runHook(makeWriteEvent(liveFile, "ctx test"));
  const out = JSON.parse(result.stdout.trim());
  const ctx = out.hookSpecificOutput.additionalContext;

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  assert(ctx.includes(gkPath), "additionalContext names gatekeeper path");

  // Strip the embedded path before checking for forbidden prose words —
  // the path may legitimately contain directory names like "gatekeeper"
  // as part of the default tree layout.  What must be absent is forbidden
  // *language* in the surrounding prose.
  const proseOnly = ctx.replace(gkPath, "").toLowerCase();
  for (const word of ["approval", "pending", "review", "gatekeeper"]) {
    assert(!proseOnly.includes(word), `additionalContext prose must not contain '${word}'`);
  }

  fs.rmSync(base, { recursive: true });
});

test("Edit in-scope, only live exists → gatekeeper seeded from live, live untouched, deny", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-edit1", "LIVE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live original content");

  const result = runHook(makeEditEvent(liveFile));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "LIVE.md");
  assert(fs.existsSync(gkPath), "gatekeeper copy created");

  // Live file must be untouched.
  assertEqual(fs.readFileSync(liveFile, "utf8"), "live original content", "live untouched");

  fs.rmSync(base, { recursive: true });
});

test("Edit in-scope, gatekeeper copy exists and differs from live → divergent feedback, content unchanged", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-edit2", "GK.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live content");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "GK.md");
  fs.mkdirSync(path.dirname(gkPath), { recursive: true });
  fs.writeFileSync(gkPath, "gatekeeper original content");

  const result = runHook(makeEditEvent(liveFile));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  // Gatekeeper content must be unchanged.
  assertEqual(fs.readFileSync(gkPath, "utf8"), "gatekeeper original content", "content preserved, not modified");
  // Context must mention the gatekeeper path.
  const ctx = out.hookSpecificOutput.additionalContext;
  assert(ctx.includes(gkPath), "context mentions gatekeeper path");

  fs.rmSync(base, { recursive: true });
});

test("Edit in-scope, neither gatekeeper nor live exists → no output, exit 0", () => {
  const { base, liveFile } = makeTempBase("slug-edit3", "GHOST.md");
  // Neither gkPath nor liveFile exists.

  const result = runHook(makeEditEvent(liveFile));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output");

  fs.rmSync(base, { recursive: true });
});

test("Out-of-scope Write (outside projects/*/memory/) → no output, exit 0", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-oos-"));
  const filePath = path.join(tmpDir, "some", "other", "file.txt");

  const result = runHook(makeWriteEvent(filePath, "out of scope"));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output");

  fs.rmSync(tmpDir, { recursive: true });
});

test("Out-of-scope CLAUDE.md at root → no output, exit 0", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-oos-"));
  const filePath = path.join(tmpDir, "CLAUDE.md");

  const result = runHook(makeWriteEvent(filePath, "root claude md"));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output");

  fs.rmSync(tmpDir, { recursive: true });
});

test("Out-of-scope projects/<slug>/CLAUDE.md (no memory segment) → no output, exit 0", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-oos-"));
  const filePath = path.join(tmpDir, "projects", "my-slug", "CLAUDE.md");

  const result = runHook(makeWriteEvent(filePath, "project claude md"));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output");

  fs.rmSync(tmpDir, { recursive: true });
});

test("Nested sub-path preserved: projects/my-slug/memory/sub/dir/NOTE.md → gatekeeper/my-slug/memory/sub/dir/NOTE.md", () => {
  const { base, slug, liveFile } = makeTempBase("my-slug", "sub/dir/NOTE.md");

  const result = runHook(makeWriteEvent(liveFile, "nested content"));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "sub", "dir", "NOTE.md");
  assert(fs.existsSync(gkPath), "nested gatekeeper file created");

  fs.rmSync(base, { recursive: true });
});

test("Malformed stdin (not JSON) → exit 0, no write, no output", () => {
  const result = runHookRaw("this is not json");
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output");
});

test("Empty stdin → exit 0, no write, no output", () => {
  const result = runHookRaw("");
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output");
});

// ---------------------------------------------------------------------------
// End-to-end tests — MultiEdit
// ---------------------------------------------------------------------------

console.log("\n--- End-to-end tests: MultiEdit ---");

test("MultiEdit in-scope, only live exists → gatekeeper seeded from live, deny", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-multiedit1", "LIVE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live original content");

  const result = runHook(makeMultiEditEvent(liveFile));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "LIVE.md");
  assert(fs.existsSync(gkPath), "gatekeeper copy created");

  fs.rmSync(base, { recursive: true });
});

test("MultiEdit in-scope, gatekeeper copy exists and differs from live → divergent feedback, no modification", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-multiedit2", "GK.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live content");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "GK.md");
  fs.mkdirSync(path.dirname(gkPath), { recursive: true });
  fs.writeFileSync(gkPath, "gatekeeper original content");

  const result = runHook(makeMultiEditEvent(liveFile));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");
  assertEqual(fs.readFileSync(gkPath, "utf8"), "gatekeeper original content", "content preserved");

  fs.rmSync(base, { recursive: true });
});

test("MultiEdit in-scope, neither gatekeeper nor live exists → pass-through", () => {
  const { base, liveFile } = makeTempBase("slug-multiedit3", "GHOST.md");

  const result = runHook(makeMultiEditEvent(liveFile));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output on pass-through");

  fs.rmSync(base, { recursive: true });
});

test("MultiEdit out-of-scope → no output, exit 0", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-oos-"));
  const filePath = path.join(tmpDir, "some", "other", "file.md");

  const result = runHook(makeMultiEditEvent(filePath));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output");

  fs.rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// End-to-end tests — NotebookEdit
// ---------------------------------------------------------------------------

console.log("\n--- End-to-end tests: NotebookEdit ---");

test("NotebookEdit in-scope via notebook_path, live exists → deny", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-nbedit1", "notebook.ipynb");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, '{"cells": []}');

  const result = runHook(makeNotebookEditEvent(liveFile));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "notebook.ipynb");
  assert(fs.existsSync(gkPath), "gatekeeper copy created");

  fs.rmSync(base, { recursive: true });
});

test("NotebookEdit in-scope via notebook_path, neither exists → pass-through", () => {
  const { base, liveFile } = makeTempBase("slug-nbedit2", "ghost.ipynb");

  const result = runHook(makeNotebookEditEvent(liveFile));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output on pass-through");

  fs.rmSync(base, { recursive: true });
});

test("NotebookEdit out-of-scope → no output, exit 0", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-oos-"));
  const filePath = path.join(tmpDir, "some", "notebook.ipynb");

  const result = runHook(makeNotebookEditEvent(filePath));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output");

  fs.rmSync(tmpDir, { recursive: true });
});

test("NotebookEdit missing notebook_path field → pass-through (fault-tolerant)", () => {
  // Send a NotebookEdit event with neither notebook_path nor file_path.
  const result = runHook({
    tool_name: "NotebookEdit",
    tool_input: { cell_type: "code", source: "print('hello')" },
  });
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output when path missing");
});

// ---------------------------------------------------------------------------
// End-to-end tests — Bash
// ---------------------------------------------------------------------------

console.log("\n--- End-to-end tests: Bash ---");

test("Bash: no memory path in command → pass-through, exit 0", () => {
  const result = runHook(makeBashEvent("ls -la /home/user && echo done"));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output");
});

test("Bash write-intent (cat redirect) → deny, NO gatekeeper file written", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-bash1", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  // liveFile = <base>/projects/slug-bash1/memory/NOTE.md

  const command = `cat some_file.txt > ${liveFile}`;
  const result = runHook(makeBashEvent(command));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  // No gatekeeper file should be written for write-intent.
  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  assert(!fs.existsSync(gkPath), "no gatekeeper file for write-intent");

  // additionalContext must mention Write tool.
  const ctx = out.hookSpecificOutput.additionalContext;
  assert(ctx.includes("Write"), "mentions Write tool");

  fs.rmSync(base, { recursive: true });
});

test("Bash write-intent additionalContext has no forbidden words", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-bash2", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });

  const command = `echo hello > ${liveFile}`;
  const result = runHook(makeBashEvent(command));
  const out = JSON.parse(result.stdout.trim());
  const ctx = out.hookSpecificOutput.additionalContext.toLowerCase();

  // Strip path segments before forbidden-word check.
  const pathFragment = `projects/slug-bash2/memory/note.md`;
  const proseOnly = ctx.replace(new RegExp(pathFragment.replace(/\//g, "."), "gi"), "");
  for (const word of ["approval", "pending", "review", "gatekeeper"]) {
    assert(!proseOnly.includes(word), `Bash write context must not contain '${word}'`);
  }

  fs.rmSync(base, { recursive: true });
});

test("Bash delete-intent (rm) → deny + zero-byte tombstone created", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-bash3", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live content");

  const command = `rm ${liveFile}`;
  const result = runHook(makeBashEvent(command));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  assert(fs.existsSync(gkPath), "tombstone file created");
  assertEqual(fs.readFileSync(gkPath).length, 0, "tombstone is zero-byte");

  fs.rmSync(base, { recursive: true });
});

test("Bash delete-intent (Remove-Item) → deny + zero-byte tombstone", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-bash4", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live content");

  const command = `Remove-Item -Path ${liveFile}`;
  const result = runHook(makeBashEvent(command));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  assert(fs.existsSync(gkPath), "tombstone created for Remove-Item");
  assertEqual(fs.readFileSync(gkPath).length, 0, "tombstone is zero-byte");

  fs.rmSync(base, { recursive: true });
});

test("Bash delete-intent (rm -rf mid-string) → deny + tombstone", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-bash5", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live content");

  // Memory path appears mid-string (not first token).
  const command = `echo before && rm -rf ${liveFile} && echo after`;
  const result = runHook(makeBashEvent(command));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  assert(fs.existsSync(gkPath), "tombstone created for mid-string rm");
  assertEqual(fs.readFileSync(gkPath).length, 0, "tombstone is zero-byte");

  fs.rmSync(base, { recursive: true });
});

// ---------------------------------------------------------------------------
// End-to-end tests — Default-deny (fail-closed)
// ---------------------------------------------------------------------------

console.log("\n--- End-to-end tests: Default-deny ---");

test("Unknown tool + in-scope path → deny (fail-closed)", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-unknown1", "NOTE.md");

  const result = runHook({
    tool_name: "FutureTool",
    tool_input: { file_path: liveFile },
  });
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny for unknown tool in-scope");

  fs.rmSync(base, { recursive: true });
});

test("Unknown tool + out-of-scope path → pass-through", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-oos-"));
  const filePath = path.join(tmpDir, "some", "other", "file.md");

  const result = runHook({
    tool_name: "FutureTool",
    tool_input: { file_path: filePath },
  });
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output for out-of-scope unknown tool");

  fs.rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// E2E tests — Obsidian bootstrap
// ---------------------------------------------------------------------------

console.log("\n--- E2E tests: Obsidian bootstrap ---");

test("E2E Write in-scope → .obsidian bootstrapped at base/gatekeeper", () => {
  const { base, slug, liveFile } = makeTempBase("boot-slug1", "NOTE.md");

  const result = runHook(makeWriteEvent(liveFile, "boot test"));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stderr.trim(), "", "no stderr errors");

  const gatekeeperRoot = path.join(base, "gatekeeper");
  const obsidianDir = path.join(gatekeeperRoot, ".obsidian");
  // The static template is in the repo — app.json should be present.
  assert(fs.existsSync(path.join(obsidianDir, "app.json")), ".obsidian/app.json created");

  const dataJsonPath = path.join(obsidianDir, "plugins", "memory-gatekeeper", "data.json");
  assert(fs.existsSync(dataJsonPath), "data.json created");
  const data = JSON.parse(fs.readFileSync(dataJsonPath, "utf8"));
  assertEqual(data.targetFolder, path.join(base, "projects"), "targetFolder correct");

  fs.rmSync(base, { recursive: true });
});

test("E2E Write with absolute CLAUDE_MEMORY_GATEKEEPER_DIR → .obsidian bootstrapped at that root", () => {
  const { base, liveFile } = makeTempBase("boot-slug2", "NOTE.md");
  const customGk = fs.mkdtempSync(path.join(os.tmpdir(), "boot-custom-gk-"));

  const result = runHook(
    makeWriteEvent(liveFile, "boot custom"),
    { CLAUDE_MEMORY_GATEKEEPER_DIR: customGk }
  );
  assertEqual(result.status, 0, "exit 0");

  const obsidianDir = path.join(customGk, ".obsidian");
  assert(fs.existsSync(path.join(obsidianDir, "app.json")), ".obsidian/app.json at custom root");

  const dataJsonPath = path.join(obsidianDir, "plugins", "memory-gatekeeper", "data.json");
  assert(fs.existsSync(dataJsonPath), "data.json at custom root");
  const data = JSON.parse(fs.readFileSync(dataJsonPath, "utf8"));
  assertEqual(data.targetFolder, path.join(base, "projects"), "targetFolder uses parsed.base");

  fs.rmSync(base, { recursive: true });
  fs.rmSync(customGk, { recursive: true });
});

test("E2E Edit seed-and-apply → .obsidian bootstrapped", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("boot-edit1", "LIVE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live content");

  const result = runHook(makeEditEvent(liveFile));
  assertEqual(result.status, 0, "exit 0");

  const obsidianDir = path.join(base, "gatekeeper", ".obsidian");
  assert(fs.existsSync(path.join(obsidianDir, "app.json")), ".obsidian/app.json created on Edit seed-and-apply");

  fs.rmSync(base, { recursive: true });
});

test("E2E Edit divergent → .obsidian bootstrapped (idempotent on second call)", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("boot-edit2", "GK.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live content");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "GK.md");
  fs.mkdirSync(path.dirname(gkPath), { recursive: true });
  fs.writeFileSync(gkPath, "gatekeeper content");

  // First Edit: divergent, bootstrap fires.
  runHook(makeEditEvent(liveFile));

  const obsidianDir = path.join(base, "gatekeeper", ".obsidian");
  assert(fs.existsSync(path.join(obsidianDir, "app.json")), ".obsidian/app.json after first divergent Edit");

  // Write a sentinel to verify idempotency.
  const sentinel = path.join(obsidianDir, "sentinel.txt");
  fs.writeFileSync(sentinel, "keep-me");

  // Second Edit: divergent, bootstrap is idempotent.
  runHook(makeEditEvent(liveFile));
  assert(fs.existsSync(sentinel), "sentinel survives second Edit call");

  fs.rmSync(base, { recursive: true });
});

test("E2E Edit pass-through → .obsidian NOT created", () => {
  const { base, liveFile } = makeTempBase("boot-edit3", "GHOST.md");
  // Neither gatekeeper copy nor live file — pass-through.

  const result = runHook(makeEditEvent(liveFile));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no output");

  const obsidianDir = path.join(base, "gatekeeper", ".obsidian");
  assert(!fs.existsSync(obsidianDir), ".obsidian NOT created on pass-through");

  fs.rmSync(base, { recursive: true });
});

test("E2E second Write to same root → no re-bootstrap (.obsidian unchanged)", () => {
  const { base, slug, liveFile } = makeTempBase("boot-slug3", "NOTE.md");

  // First Write: bootstrap fires.
  runHook(makeWriteEvent(liveFile, "first write"));

  const obsidianDir = path.join(base, "gatekeeper", ".obsidian");
  assert(fs.existsSync(path.join(obsidianDir, "app.json")), "app.json after first write");

  // Write a sentinel.
  const sentinel = path.join(obsidianDir, "sentinel.txt");
  fs.writeFileSync(sentinel, "keep-me");

  // Second Write: bootstrap is a no-op.
  const liveFile2 = path.join(base, "projects", slug, "memory", "NOTE2.md");
  runHook(makeWriteEvent(liveFile2, "second write"));

  assert(fs.existsSync(sentinel), "sentinel survives second Write");
  assertEqual(fs.readFileSync(sentinel, "utf8"), "keep-me", "sentinel content unchanged");

  fs.rmSync(base, { recursive: true });
});

// ---------------------------------------------------------------------------
// New E2E tests — ticket #6 features
// ---------------------------------------------------------------------------

console.log("\n--- New E2E tests (ticket #6) ---");

// 1. MEMORY.md hard-deny (Write)
test("E2E Write MEMORY.md → hard-deny, no file written to gatekeeper", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-memmd1", "MEMORY.md");
  // liveFile ends in MEMORY.md

  const result = runHook(makeWriteEvent(liveFile, "some content"));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "MEMORY.md");
  assert(!fs.existsSync(gkPath), "no gatekeeper file written for MEMORY.md");

  const ctx = out.hookSpecificOutput.additionalContext;
  assert(ctx.includes("MEMORY.md"), "context mentions MEMORY.md");

  fs.rmSync(base, { recursive: true });
});

// 2. MEMORY.md hard-deny (Edit)
test("E2E Edit MEMORY.md → hard-deny", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-memmd2", "MEMORY.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "# Memory Index\n- [[NOTE]]\n");

  const result = runHook(makeEditEvent(liveFile, "NOTE", "OTHER"));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const ctx = out.hookSpecificOutput.additionalContext;
  assert(ctx.includes("MEMORY.md"), "context mentions MEMORY.md");

  fs.rmSync(base, { recursive: true });
});

// 3. MEMORY.md hard-deny (Bash delete-intent)
test("E2E Bash rm MEMORY.md → hard-deny, no tombstone", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-memmd3", "MEMORY.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "# Memory Index\n");

  const command = `rm ${liveFile}`;
  const result = runHook(makeBashEvent(command));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "MEMORY.md");
  assert(!fs.existsSync(gkPath), "no tombstone written for MEMORY.md");

  fs.rmSync(base, { recursive: true });
});

// 4. Review-path pass-through
test("E2E Write directly to gatekeeper path → pass-through (exit 0, no deny)", () => {
  const { base, slug, memoryDir } = makeTempBase("slug-passthru", "NOTE.md");

  // The gatekeeper path is inside <base>/gatekeeper/...
  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");

  const result = runHook(makeWriteEvent(gkPath, "direct write to gatekeeper"));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no deny output for gatekeeper-path write");

  fs.rmSync(base, { recursive: true });
});

// 5. Write empty content rejected
test("E2E Write empty content → deny, no file written", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-empty1", "NOTE.md");

  const result = runHook(makeWriteEvent(liveFile, ""));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny for empty content");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  assert(!fs.existsSync(gkPath), "no file written for empty content");

  const ctx = out.hookSpecificOutput.additionalContext;
  // The deny context should be from buildEmptyWriteDenyContext.
  assert(ctx.length > 0, "has context");

  fs.rmSync(base, { recursive: true });
});

// 6. Write non-empty → review copy contains project: frontmatter
test("E2E Write non-empty → review copy has project: frontmatter", () => {
  const { base, slug, liveFile } = makeTempBase("slug-stamp1", "NOTE.md");

  const result = runHook(makeWriteEvent(liveFile, "# My Note\n\nSome content."));
  assertEqual(result.status, 0, "exit 0");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  assert(fs.existsSync(gkPath), "gatekeeper file created");
  const content = fs.readFileSync(gkPath, "utf8");
  assert(content.includes("project:"), "review copy has project: frontmatter");

  fs.rmSync(base, { recursive: true });
});

// 7. Edit equal case (regression test) → applied
test("Regression: Edit in-scope, review copy == live → edit applied to review copy, live untouched, applied message", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-equal1", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  const sharedContent = "hello world\nsome more text\n";
  fs.writeFileSync(liveFile, sharedContent);

  // Seed the gatekeeper copy with the same content (simulating "in sync").
  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  fs.mkdirSync(path.dirname(gkPath), { recursive: true });
  fs.writeFileSync(gkPath, sharedContent);

  const result = runHook(makeEditEvent(liveFile, "world", "there"));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  // Review copy must have the edit applied.
  const gkContent = fs.readFileSync(gkPath, "utf8");
  assert(gkContent.includes("there"), "review copy has new_string");
  assert(!gkContent.includes("world"), "review copy no longer has old_string");

  // Live file must be untouched.
  assertEqual(fs.readFileSync(liveFile, "utf8"), sharedContent, "live file untouched");

  // additionalContext must NOT say "write here instead" (the old broken behavior).
  const ctx = out.hookSpecificOutput.additionalContext;
  assert(!ctx.toLowerCase().includes("write here instead"), "no 'write here instead' in context");
  // Should say "applied" instead.
  assert(ctx.toLowerCase().includes("applied"), "context says 'applied'");

  fs.rmSync(base, { recursive: true });
});

// 8. Edit divergent case → feedback, content unchanged
test("E2E Edit divergent → feedback deny, review copy content unchanged", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-divergent1", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live version");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  fs.mkdirSync(path.dirname(gkPath), { recursive: true });
  fs.writeFileSync(gkPath, "diverged version with edits");

  const result = runHook(makeEditEvent(liveFile, "live", "modified"));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  // Review copy must be unchanged.
  assertEqual(fs.readFileSync(gkPath, "utf8"), "diverged version with edits", "review copy unchanged");

  // Context should tell agent to edit the review copy directly.
  const ctx = out.hookSpecificOutput.additionalContext;
  assert(ctx.includes(gkPath), "context mentions gatekeeper path");

  fs.rmSync(base, { recursive: true });
});

// 9. Edit apply error (old_string not found) → graceful fallback to divergent-style feedback
test("E2E Edit apply error: old_string not in review copy → graceful fallback", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-applyerr1", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  const sharedContent = "hello world\n";
  fs.writeFileSync(liveFile, sharedContent);

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  fs.mkdirSync(path.dirname(gkPath), { recursive: true });
  fs.writeFileSync(gkPath, sharedContent);

  // old_string that does NOT exist in the content.
  const result = runHook(makeEditEvent(liveFile, "DOES NOT EXIST", "replacement"));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  // Review copy should remain unchanged (or seeded content — not broken).
  const gkContent = fs.readFileSync(gkPath, "utf8");
  assert(!gkContent.includes("replacement"), "replacement not applied when old_string not found");

  fs.rmSync(base, { recursive: true });
});

// 10. Edit apply error (old_string twice, no replace_all) → graceful fallback
test("E2E Edit apply error: old_string found twice without replace_all → graceful fallback", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-applyerr2", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  const sharedContent = "foo bar foo baz\n";
  fs.writeFileSync(liveFile, sharedContent);

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  fs.mkdirSync(path.dirname(gkPath), { recursive: true });
  fs.writeFileSync(gkPath, sharedContent);

  // old_string appears twice — should fail gracefully.
  const result = runHook(makeEditEvent(liveFile, "foo", "qux"));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const gkContent = fs.readFileSync(gkPath, "utf8");
  assert(!gkContent.includes("qux"), "partial replacement not applied");

  fs.rmSync(base, { recursive: true });
});

// 11. MultiEdit equal case → all edits applied sequentially
test("E2E MultiEdit equal case → all edits applied to review copy", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-meq1", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  const sharedContent = "alpha beta gamma\n";
  fs.writeFileSync(liveFile, sharedContent);

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  fs.mkdirSync(path.dirname(gkPath), { recursive: true });
  fs.writeFileSync(gkPath, sharedContent);

  const result = runHook(makeMultiEditEvent(liveFile, [
    { old_string: "alpha", new_string: "one" },
    { old_string: "beta", new_string: "two" },
    { old_string: "gamma", new_string: "three" },
  ]));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  const gkContent = fs.readFileSync(gkPath, "utf8");
  assert(gkContent.includes("one"), "first edit applied");
  assert(gkContent.includes("two"), "second edit applied");
  assert(gkContent.includes("three"), "third edit applied");
  assert(!gkContent.includes("alpha"), "old alpha removed");

  // Live untouched.
  assertEqual(fs.readFileSync(liveFile, "utf8"), sharedContent, "live untouched");

  fs.rmSync(base, { recursive: true });
});

// 12. MultiEdit divergent case → feedback
test("E2E MultiEdit divergent case → feedback, review copy unchanged", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-mdiv1", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live version alpha");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  fs.mkdirSync(path.dirname(gkPath), { recursive: true });
  fs.writeFileSync(gkPath, "diverged version alpha");

  const result = runHook(makeMultiEditEvent(liveFile, [
    { old_string: "alpha", new_string: "beta" },
  ]));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  // Review copy must be unchanged.
  assertEqual(fs.readFileSync(gkPath, "utf8"), "diverged version alpha", "review copy unchanged");

  fs.rmSync(base, { recursive: true });
});

// 13. Seed stamps project: frontmatter AND applies the edit (seed-and-apply path)
test("E2E Edit seed-and-apply stamps project: frontmatter in seeded copy", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-seedstamp1", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "hello world\nsome content\n");

  const result = runHook(makeEditEvent(liveFile, "world", "there"));
  assertEqual(result.status, 0, "exit 0");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  assert(fs.existsSync(gkPath), "gatekeeper file created");
  const content = fs.readFileSync(gkPath, "utf8");
  assert(content.includes("project:"), "seeded copy has project: frontmatter");
  // The edit must also have been applied during seed-and-apply (not merely seeded).
  assert(content.includes("there"), "new_string landed in seeded copy");
  assert(!content.includes("world"), "old_string no longer in seeded copy");

  fs.rmSync(base, { recursive: true });
});

// 14. Second Write to same file → project: frontmatter preserved
test("E2E second Write to same gatekeeper file → project: frontmatter preserved", () => {
  const { base, slug, liveFile } = makeTempBase("slug-stamp2", "NOTE.md");

  // First write — stamps frontmatter.
  runHook(makeWriteEvent(liveFile, "# My Note\n\nFirst content."));

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");
  const firstContent = fs.readFileSync(gkPath, "utf8");
  assert(firstContent.includes("project:"), "first write has project: frontmatter");

  // Second write — should also stamp frontmatter (Write always stamps).
  runHook(makeWriteEvent(liveFile, "# My Note\n\nUpdated content."));
  const secondContent = fs.readFileSync(gkPath, "utf8");
  assert(secondContent.includes("project:"), "second write preserves project: frontmatter");

  // Should only have one project: line.
  const count = (secondContent.match(/^project:/gm) || []).length;
  assertEqual(count, 1, "only one project: line after second write");

  fs.rmSync(base, { recursive: true });
});

// ---------------------------------------------------------------------------
// New E2E tests — MEMORY.md hard-deny for MultiEdit and NotebookEdit (ticket #6 review)
// ---------------------------------------------------------------------------

console.log("\n--- New E2E tests: MEMORY.md hard-deny for MultiEdit and NotebookEdit ---");

// MEMORY.md hard-deny (MultiEdit)
test("E2E MultiEdit MEMORY.md → hard-deny (auto-generated message), no file written", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-memmd-me1", "MEMORY.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "# Memory Index\n- [[NOTE]]\n");

  const result = runHook(makeMultiEditEvent(liveFile, [{ old_string: "NOTE", new_string: "OTHER" }]));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  // Must use the auto-generated MEMORY.md deny message.
  const ctx = out.hookSpecificOutput.additionalContext;
  assert(ctx.includes("MEMORY.md"), "context mentions MEMORY.md");

  // No gatekeeper file may be created.
  const gkPath = path.join(base, "gatekeeper", slug, "memory", "MEMORY.md");
  assert(!fs.existsSync(gkPath), "no gatekeeper file written for MEMORY.md MultiEdit");

  fs.rmSync(base, { recursive: true });
});

// MEMORY.md hard-deny (NotebookEdit)
test("E2E NotebookEdit MEMORY.md → hard-deny (auto-generated message), no file written", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-memmd-nbe1", "MEMORY.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "# Memory Index\n");

  const result = runHook(makeNotebookEditEvent(liveFile));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny");

  // Must use the auto-generated MEMORY.md deny message.
  const ctx = out.hookSpecificOutput.additionalContext;
  assert(ctx.includes("MEMORY.md"), "context mentions MEMORY.md");

  // No gatekeeper file may be created.
  const gkPath = path.join(base, "gatekeeper", slug, "memory", "MEMORY.md");
  assert(!fs.existsSync(gkPath), "no gatekeeper file written for MEMORY.md NotebookEdit");

  fs.rmSync(base, { recursive: true });
});

// ---------------------------------------------------------------------------
// New E2E tests — Bash delete tombstone failure still emits deny (ticket #6 review)
// ---------------------------------------------------------------------------

console.log("\n--- New E2E tests: Bash delete tombstone failure → still deny ---");

// Regression test: tombstone FS write fails (gatekeeper dir is a file, not a dir) →
// deny is still emitted, the destructive rm command is never allowed through.
test("Regression: Bash delete tombstone write fails → deny still emitted (fail-closed)", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("slug-bash-tombfail", "NOTE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live content");

  // Pre-create a FILE at the path where mkdirSync would try to create a directory.
  // This will cause mkdirSync to throw because the path already exists as a file.
  const gkMemDir = path.join(base, "gatekeeper", slug, "memory");
  // Create the parent dir so we can plant a file at gkMemDir itself.
  fs.mkdirSync(path.dirname(gkMemDir), { recursive: true });
  // Plant a file at what should be a directory — mkdirSync({recursive:true}) on
  // a path that exists as a regular file throws EEXIST / ENOTDIR on all platforms.
  fs.writeFileSync(gkMemDir, "i am a file, not a directory");

  const command = `rm ${liveFile}`;
  const result = runHook(makeBashEvent(command));
  assertEqual(result.status, 0, "exit 0");

  // The deny MUST still be emitted even though the tombstone write failed.
  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny still emitted when tombstone write fails");

  // The gatekeeper file should NOT exist (write failed, and we didn't
  // accidentally overwrite the file we planted).
  const gkPath = path.join(gkMemDir, "NOTE.md");
  assert(!fs.existsSync(gkPath), "no tombstone file when mkdir failed");

  // stderr should mention the failure.
  assert(result.stderr.includes("tombstone write failed"), "stderr mentions tombstone write failure");

  fs.rmSync(base, { recursive: true });
});

// ---------------------------------------------------------------------------
// New E2E tests — ticket #14: MEMORY.md hard-deny inside gatekeeper tree
// ---------------------------------------------------------------------------

console.log("\n--- New E2E tests (ticket #14): gatekeeper-tree MEMORY.md hard-deny ---");

// 1. KEY REGRESSION TEST: Direct Write to the default gatekeeper MEMORY.md path
// (no `projects/` segment, no env var) → hard-deny, no file written.
//
// Target path: <base>/gatekeeper/<slug>/memory/MEMORY.md
// parseMemoryPath returns null (no `projects/` segment).
// Before this fix: hook exits silently (pass-through). After: parseGatekeeperTreePath
// matches the /gatekeeper/…/memory/MEMORY.md pattern and emits a hard deny.
test("Regression #14: Write to <base>/gatekeeper/<slug>/memory/MEMORY.md → hard-deny, no file written", () => {
  const { base, slug } = makeTempBase("slug-gk14-memmd1", "MEMORY.md");
  const gkMemoryMd = path.join(base, "gatekeeper", slug, "memory", "MEMORY.md");

  const result = runHook(
    makeWriteEvent(gkMemoryMd, "auto-generated content")
    // No env var — exercises the default /gatekeeper/ path detection.
  );
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "permissionDecision is deny");

  // additionalContext must mention MEMORY.md (from buildMemoryMdDenyContext).
  const ctx = out.hookSpecificOutput.additionalContext;
  assert(ctx.includes("MEMORY.md"), "additionalContext includes MEMORY.md");

  // The file must NOT have been written to disk.
  assert(!fs.existsSync(gkMemoryMd), "MEMORY.md was NOT written to disk");

  fs.rmSync(base, { recursive: true });
});

// 2. Direct Edit to the default gatekeeper MEMORY.md path → hard-deny.
// Same key scenario as test 1, but using an Edit event.
test("Regression #14: Edit to <base>/gatekeeper/<slug>/memory/MEMORY.md → hard-deny", () => {
  const { base, slug } = makeTempBase("slug-gk14-memmd2", "MEMORY.md");
  const gkMemDir = path.join(base, "gatekeeper", slug, "memory");
  const gkMemoryMd = path.join(gkMemDir, "MEMORY.md");
  fs.mkdirSync(gkMemDir, { recursive: true });
  fs.writeFileSync(gkMemoryMd, "# Memory Index\n- [[NOTE]]\n");

  const result = runHook(
    makeEditEvent(gkMemoryMd, "NOTE", "OTHER")
    // No env var — exercises the default /gatekeeper/ path detection.
  );
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "permissionDecision is deny");

  const ctx = out.hookSpecificOutput.additionalContext;
  assert(ctx.includes("MEMORY.md"), "additionalContext includes MEMORY.md");

  // The file on disk must be untouched (no edit applied).
  assertEqual(
    fs.readFileSync(gkMemoryMd, "utf8"),
    "# Memory Index\n- [[NOTE]]\n",
    "gatekeeper MEMORY.md untouched after deny"
  );

  fs.rmSync(base, { recursive: true });
});

// 3. Direct Write to <custom>/<slug>/memory/MEMORY.md with CLAUDE_MEMORY_GATEKEEPER_DIR
//    set to a custom absolute dir that does NOT enclose the projects tree → hard-deny.
//
// parseMemoryPath returns null (path has no `projects/` segment).
// parseGatekeeperTreePath matches via the env-var branch: path starts with <custom>/
// and contains <slug>/memory/MEMORY.md.
test("Regression #14: Write to <custom>/<slug>/memory/MEMORY.md with CLAUDE_MEMORY_GATEKEEPER_DIR=<custom> → hard-deny", () => {
  // Two separate temp dirs: one for the custom gatekeeper root, one for the
  // projects tree.  They do NOT share a common parent, so the env-var path is
  // NOT a parent of the projects tree.
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-custom-"));
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-proj-"));
  const slug = "slug-gk14-memmd3";
  const targetPath = path.join(customDir, slug, "memory", "MEMORY.md");

  const result = runHook(
    makeWriteEvent(targetPath, "auto-generated content"),
    { CLAUDE_MEMORY_GATEKEEPER_DIR: customDir }
  );
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "permissionDecision is deny");

  const ctx = out.hookSpecificOutput.additionalContext;
  assert(ctx.includes("MEMORY.md"), "additionalContext includes MEMORY.md");

  // The file must NOT have been written to disk.
  assert(!fs.existsSync(targetPath), "MEMORY.md was NOT written to disk");

  fs.rmSync(customDir, { recursive: true });
  fs.rmSync(projectsDir, { recursive: true });
});

// 4. Non-MEMORY.md file in the gatekeeper tree passes through (exit 0, no deny).
// Verifies the fix does not break pass-through for non-MEMORY.md gatekeeper writes.
test("Regression #14: Write to <base>/gatekeeper/<slug>/memory/NOTE.md → pass-through (exit 0, no deny)", () => {
  const { base, slug } = makeTempBase("slug-gk14-passthru", "NOTE.md");
  const gkNoteMd = path.join(base, "gatekeeper", slug, "memory", "NOTE.md");

  const result = runHook(makeWriteEvent(gkNoteMd, "some content"));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no deny output for non-MEMORY.md gatekeeper write");

  fs.rmSync(base, { recursive: true });
});

// ---------------------------------------------------------------------------
// Unit tests — ticket #16: buildGatekeeperDeleteDenyContext
// ---------------------------------------------------------------------------

console.log("\n--- Unit tests (ticket #16): buildGatekeeperDeleteDenyContext ---");

test("buildGatekeeperDeleteDenyContext: contains the file path", () => {
  const filePath = "/some/gatekeeper/slug/memory/NOTE.md";
  const ctx = buildGatekeeperDeleteDenyContext(filePath);
  assert(ctx.includes(filePath), "context contains the file path");
});

test("buildGatekeeperDeleteDenyContext: no forbidden words in prose (path stripped)", () => {
  const filePath = "/some/gatekeeper/slug/memory/NOTE.md";
  const ctx = buildGatekeeperDeleteDenyContext(filePath).toLowerCase();
  // Strip the embedded path — it may contain segments like 'gatekeeper'.
  const proseOnly = ctx.replace(filePath.toLowerCase(), "");
  for (const word of ["approval", "pending", "review", "gatekeeper"]) {
    assert(!proseOnly.includes(word), `buildGatekeeperDeleteDenyContext must not contain '${word}' in prose`);
  }
});

// ---------------------------------------------------------------------------
// Unit tests — ticket #16: parseGatekeeperBashCommand
// ---------------------------------------------------------------------------

console.log("\n--- Unit tests (ticket #16): parseGatekeeperBashCommand ---");

test("parseGatekeeperBashCommand: returns null when no gatekeeper path in command", () => {
  assertEqual(parseGatekeeperBashCommand("rm -rf /home/user/projects/slug/memory/NOTE.md"), null, "no gatekeeper path");
});

test("parseGatekeeperBashCommand: returns null for non-string input", () => {
  assertEqual(parseGatekeeperBashCommand(null), null, "null input");
  assertEqual(parseGatekeeperBashCommand(undefined), null, "undefined input");
});

test("parseGatekeeperBashCommand: matches a default-root gatekeeper path", () => {
  const result = parseGatekeeperBashCommand("rm /base/gatekeeper/my-slug/memory/NOTE.md");
  assert(result !== null, "should match");
  assert(result.includes("gatekeeper/my-slug/memory/NOTE.md"), `got: ${result}`);
});

test("parseGatekeeperBashCommand: matches when command embeds a gatekeeper path mid-string", () => {
  const result = parseGatekeeperBashCommand("echo before && Remove-Item /some/gatekeeper/proj/memory/FILE.md && echo after");
  assert(result !== null, "should match mid-string");
  assert(result.includes("gatekeeper/proj/memory/FILE.md"), `got: ${result}`);
});

test("parseGatekeeperBashCommand: returns null for command with no path segment at all", () => {
  assertEqual(parseGatekeeperBashCommand("ls -la /home/user"), null, "no matching path");
});

test("parseGatekeeperBashCommand: env-var strategy matches custom root path", () => {
  // On this OS, use an absolute path that does NOT contain 'gatekeeper'.
  const customRoot = os.platform() === "win32" ? "C:/custom/myroot" : "/custom/myroot";
  const command = `rm ${customRoot}/my-slug/memory/NOTE.md`;
  const result = parseGatekeeperBashCommand(command, customRoot);
  assert(result !== null, "should match via env-var strategy");
  assert(result.includes("my-slug/memory/NOTE.md"), `got: ${result}`);
});

test("parseGatekeeperBashCommand: env-var strategy returns null when path does not start with envDir", () => {
  const customRoot = os.platform() === "win32" ? "C:/custom/myroot" : "/custom/myroot";
  const command = `rm /other/path/my-slug/memory/NOTE.md`;
  const result = parseGatekeeperBashCommand(command, customRoot);
  assertEqual(result, null, "should not match path outside envDir");
});

// ---------------------------------------------------------------------------
// E2E regression tests — ticket #16: prevent deletion in the gatekeeper
// ---------------------------------------------------------------------------

console.log("\n--- E2E regression tests (ticket #16): prevent deletion in gatekeeper ---");

// Helper: make a gatekeeper memory file directly (not via a projects/ path).
function makeGatekeeperFile(base, slug, filename, content = "existing gatekeeper content") {
  const gkMemDir = path.join(base, "gatekeeper", slug, "memory");
  fs.mkdirSync(gkMemDir, { recursive: true });
  const gkFile = path.join(gkMemDir, filename);
  fs.writeFileSync(gkFile, content);
  return gkFile;
}

// Regression: Bash rm on a gatekeeper-tree path → deny, file NOT deleted.
test("Regression #16: Bash rm on gatekeeper-tree path → deny, file unchanged", () => {
  const { base, slug } = makeTempBase("slug-gk16-rm", "NOTE.md");
  const gkFile = makeGatekeeperFile(base, slug, "NOTE.md");

  const command = `rm ${gkFile}`;
  const result = runHook(makeBashEvent(command));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny emitted");

  // File must still exist with its original content.
  assert(fs.existsSync(gkFile), "gatekeeper file still exists");
  assertEqual(fs.readFileSync(gkFile, "utf8"), "existing gatekeeper content", "content unchanged");

  fs.rmSync(base, { recursive: true });
});

// Regression: Bash Remove-Item on a gatekeeper-tree path → deny, file NOT deleted.
test("Regression #16: Bash Remove-Item on gatekeeper-tree path → deny, file unchanged", () => {
  const { base, slug } = makeTempBase("slug-gk16-ri", "NOTE.md");
  const gkFile = makeGatekeeperFile(base, slug, "NOTE.md");

  const command = `Remove-Item -Path ${gkFile}`;
  const result = runHook(makeBashEvent(command));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny emitted");

  assert(fs.existsSync(gkFile), "gatekeeper file still exists after Remove-Item");
  assertEqual(fs.readFileSync(gkFile, "utf8"), "existing gatekeeper content", "content unchanged");

  fs.rmSync(base, { recursive: true });
});

// Regression: Bash rm on gatekeeper-tree path with CLAUDE_MEMORY_GATEKEEPER_DIR env var → deny.
test("Regression #16: Bash rm on gatekeeper-tree path with CLAUDE_MEMORY_GATEKEEPER_DIR → deny, file unchanged", () => {
  const customGk = fs.mkdtempSync(path.join(os.tmpdir(), "gk16-custom-"));
  const slug = "slug-gk16-envvar";
  const gkMemDir = path.join(customGk, slug, "memory");
  fs.mkdirSync(gkMemDir, { recursive: true });
  const gkFile = path.join(gkMemDir, "NOTE.md");
  fs.writeFileSync(gkFile, "existing content");

  const command = `rm ${gkFile}`;
  const result = runHook(makeBashEvent(command), { CLAUDE_MEMORY_GATEKEEPER_DIR: customGk });
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny emitted");

  assert(fs.existsSync(gkFile), "gatekeeper file still exists");
  assertEqual(fs.readFileSync(gkFile, "utf8"), "existing content", "content unchanged");

  fs.rmSync(customGk, { recursive: true });
});

// Regression: Write empty content to a gatekeeper-tree path (no projects/ segment) → deny, file unchanged.
test("Regression #16: Write empty content to gatekeeper-tree path → deny, file on disk unchanged", () => {
  const { base, slug } = makeTempBase("slug-gk16-empty-write", "NOTE.md");
  const gkFile = makeGatekeeperFile(base, slug, "NOTE.md");

  const result = runHook(makeWriteEvent(gkFile, ""));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny for empty write to gatekeeper-tree path");

  // File must still have original content (not overwritten with empty).
  assertEqual(fs.readFileSync(gkFile, "utf8"), "existing gatekeeper content", "content unchanged");

  fs.rmSync(base, { recursive: true });
});

// Regression: Write empty content via pass-through guard branch (path has projects/ segment AND is inside gatekeeper tree).
test("Regression #16: Write empty content via pass-through guard (projects/ segment inside gatekeeper tree) → deny", () => {
  const { base, slug } = makeTempBase("slug-gk16-passthru-empty");
  // Construct a path that has BOTH 'projects/' AND 'gatekeeper/' — e.g.
  // <base>/gatekeeper/<slug>/projects/<slug>/memory/NOTE.md
  // parseMemoryPath will match it AND isInsideGatekeeperTree will be true.
  const gkRoot = path.join(base, "gatekeeper");
  const artificialPath = path.join(gkRoot, slug, "projects", slug, "memory", "NOTE.md");
  fs.mkdirSync(path.dirname(artificialPath), { recursive: true });
  fs.writeFileSync(artificialPath, "original content");

  const result = runHook(makeWriteEvent(artificialPath, ""));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny for empty write via pass-through guard");

  // File must be unchanged.
  assertEqual(fs.readFileSync(artificialPath, "utf8"), "original content", "file content unchanged");

  fs.rmSync(base, { recursive: true });
});

// Regression: Edit with new_string === "" targeting a gatekeeper-tree path → deny.
test("Regression #16: Edit with new_string='' on gatekeeper-tree path → deny", () => {
  const { base, slug } = makeTempBase("slug-gk16-edit-wipe", "NOTE.md");
  const gkFile = makeGatekeeperFile(base, slug, "NOTE.md", "hello world");

  const result = runHook(makeEditEvent(gkFile, "hello world", ""));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny for wiping edit");

  // Content must be unchanged.
  assertEqual(fs.readFileSync(gkFile, "utf8"), "hello world", "file content unchanged after wiping Edit");

  fs.rmSync(base, { recursive: true });
});

// Regression: MultiEdit where one edit has new_string === "" → deny.
test("Regression #16: MultiEdit with one new_string='' on gatekeeper-tree path → deny", () => {
  const { base, slug } = makeTempBase("slug-gk16-multiedit-wipe", "NOTE.md");
  const gkFile = makeGatekeeperFile(base, slug, "NOTE.md", "hello world");

  const result = runHook(makeMultiEditEvent(gkFile, [
    { old_string: "hello", new_string: "hi" },
    { old_string: " world", new_string: "" },
  ]));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny for wiping MultiEdit");

  // Content must be unchanged.
  assertEqual(fs.readFileSync(gkFile, "utf8"), "hello world", "file content unchanged after wiping MultiEdit");

  fs.rmSync(base, { recursive: true });
});

// Non-regression: Write non-empty to gatekeeper-tree path → still passes through.
test("Non-regression #16: Write non-empty to gatekeeper-tree path → pass-through (exit 0, no deny)", () => {
  const { base, slug } = makeTempBase("slug-gk16-nonempty-write", "NOTE.md");
  const gkFile = makeGatekeeperFile(base, slug, "NOTE.md");

  const result = runHook(makeWriteEvent(gkFile, "new non-empty content"));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no deny for non-empty write to gatekeeper-tree path");

  fs.rmSync(base, { recursive: true });
});

// Non-regression: substantive Edit (non-empty new_string) to gatekeeper-tree path → still passes through.
test("Non-regression #16: substantive Edit to gatekeeper-tree path → pass-through (exit 0, no deny)", () => {
  const { base, slug } = makeTempBase("slug-gk16-nonempty-edit", "NOTE.md");
  const gkFile = makeGatekeeperFile(base, slug, "NOTE.md", "hello world");

  const result = runHook(makeEditEvent(gkFile, "hello", "hi"));
  assertEqual(result.status, 0, "exit 0");
  assertEqual(result.stdout.trim(), "", "no deny for substantive Edit to gatekeeper-tree path");

  fs.rmSync(base, { recursive: true });
});

// Alternate delete verb: unlink on gatekeeper-tree path → deny.
test("Regression #16 (alternate verb): Bash unlink on gatekeeper-tree path → deny, file unchanged", () => {
  const { base, slug } = makeTempBase("slug-gk16-unlink", "NOTE.md");
  const gkFile = makeGatekeeperFile(base, slug, "NOTE.md");

  const command = `unlink ${gkFile}`;
  const result = runHook(makeBashEvent(command));
  assertEqual(result.status, 0, "exit 0");

  const out = JSON.parse(result.stdout.trim());
  assertEqual(out.hookSpecificOutput.permissionDecision, "deny", "deny for unlink");

  assert(fs.existsSync(gkFile), "gatekeeper file still exists after unlink intercept");
  assertEqual(fs.readFileSync(gkFile, "utf8"), "existing gatekeeper content", "content unchanged");

  fs.rmSync(base, { recursive: true });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
