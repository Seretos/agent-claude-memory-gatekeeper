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
  classifyEditCase,
  buildAdditionalContext,
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
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
