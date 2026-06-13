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
function makeEditEvent(filePath) {
  return {
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
  };
}

/**
 * Build a MultiEdit tool event for the given file path.
 */
function makeMultiEditEvent(filePath) {
  return {
    tool_name: "MultiEdit",
    tool_input: {
      file_path: filePath,
      edits: [{ old_string: "a", new_string: "b" }],
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

test("classifyEditCase: deny-existing when gatekeeper copy exists", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-classify-"));
  const gkPath = path.join(tmpDir, "gk.md");
  fs.writeFileSync(gkPath, "existing");
  const liveFile = path.join(tmpDir, "live.md"); // does not exist
  assertEqual(classifyEditCase(gkPath, liveFile), "deny-existing", "deny-existing");
  fs.rmSync(tmpDir, { recursive: true });
});

test("classifyEditCase: seed-and-deny when only live file exists", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gk-classify-"));
  const gkPath = path.join(tmpDir, "gk.md"); // does not exist
  const liveFile = path.join(tmpDir, "live.md");
  fs.writeFileSync(liveFile, "live content");
  assertEqual(classifyEditCase(gkPath, liveFile), "seed-and-deny", "seed-and-deny");
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
  assertEqual(fs.readFileSync(gkPath, "utf8"), "test content", "content correct");
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
  assertEqual(fs.readFileSync(gkPath, "utf8"), "custom dir content", "content correct");

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
  assertEqual(fs.readFileSync(gkPath, "utf8"), "live original content", "seeded from live");

  // Live file must be untouched.
  assertEqual(fs.readFileSync(liveFile, "utf8"), "live original content", "live untouched");

  fs.rmSync(base, { recursive: true });
});

test("Edit in-scope, gatekeeper copy already exists → no re-seed, content preserved, deny", () => {
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

  // Gatekeeper content must be unchanged (not re-seeded from live).
  assertEqual(fs.readFileSync(gkPath, "utf8"), "gatekeeper original content", "content preserved, not re-seeded");

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
  assertEqual(fs.readFileSync(gkPath, "utf8"), "nested content", "content correct");

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
  assertEqual(fs.readFileSync(gkPath, "utf8"), "live original content", "seeded from live");

  fs.rmSync(base, { recursive: true });
});

test("MultiEdit in-scope, gatekeeper copy already exists → no re-seed, deny", () => {
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

test("E2E Edit seed-and-deny → .obsidian bootstrapped", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("boot-edit1", "LIVE.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live content");

  const result = runHook(makeEditEvent(liveFile));
  assertEqual(result.status, 0, "exit 0");

  const obsidianDir = path.join(base, "gatekeeper", ".obsidian");
  assert(fs.existsSync(path.join(obsidianDir, "app.json")), ".obsidian/app.json created on Edit seed-and-deny");

  fs.rmSync(base, { recursive: true });
});

test("E2E Edit deny-existing → .obsidian bootstrapped (idempotent on second call)", () => {
  const { base, slug, memoryDir, liveFile } = makeTempBase("boot-edit2", "GK.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(liveFile, "live content");

  const gkPath = path.join(base, "gatekeeper", slug, "memory", "GK.md");
  fs.mkdirSync(path.dirname(gkPath), { recursive: true });
  fs.writeFileSync(gkPath, "gatekeeper content");

  // First Edit: deny-existing, bootstrap fires.
  runHook(makeEditEvent(liveFile));

  const obsidianDir = path.join(base, "gatekeeper", ".obsidian");
  assert(fs.existsSync(path.join(obsidianDir, "app.json")), ".obsidian/app.json after first deny-existing");

  // Write a sentinel to verify idempotency.
  const sentinel = path.join(obsidianDir, "sentinel.txt");
  fs.writeFileSync(sentinel, "keep-me");

  // Second Edit: deny-existing, bootstrap is idempotent.
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
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
