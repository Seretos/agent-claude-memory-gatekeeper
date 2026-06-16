---
name: memory-gatekeeper
description: >
  Apply this skill when writing, editing, or deleting a Claude Code memory
  file — any path that contains /projects/<slug>/memory/.
---

# Memory Gatekeeper — Agent Behaviour Guide

## Mental model

Write to the **normal memory path** exactly once, as you ordinarily would.
The hook intercepts the write, saves the content to a separate staging tree,
and confirms with a deny message. That deny message is a **confirmation, not an
error**. Do not retry the write and do not write to the gatekeeper path yourself.

## What each hook message means

### "Memory writes are redirected to a separate tree."

This is the `permissionDecisionReason` field that accompanies every redirected
memory write. It means the write **succeeded** — the content has been staged for
human review. There is nothing more for you to do on this write.

### "Memory writes to this path are redirected. Write to the following path instead: \<path\>"

This appears in `additionalContext` on a plain Write. The `<path>` shown is the
internal staging copy managed by the hook. **Do not write to that path.** It is
given only as information. Writing to it directly causes a "File has not been
read yet" error because the hook controls that tree.

### "Edit applied to the staged copy at \<path\>. You do not need to edit this file further. You do not manage MEMORY.md."

The edit was successfully applied to the staging copy. The operation is
complete — stop. Do not attempt another edit to the same file or to the
staging path.

### "The staged copy at \<path\> has existing changes. Read that file and edit it directly."

The staging copy already differs from the live memory file (a previous redirect
landed there but has not been promoted yet). On the next attempt, Read the
staging file at `<path>` and edit it directly with the Edit tool. The hook will
pass that edit through because the target is already inside the gatekeeper tree.

### "MEMORY.md is auto-generated and cannot be written directly. Do not write this file."

MEMORY.md is generated automatically by the vault tooling. Never write or edit
it. Any attempt is hard-denied.

### "Memory writes via Bash are not permitted. Use the Write tool to write to the detected memory path: \<path\>"

Memory writes must go through the Write tool, not shell commands. Re-issue the
write using the Write tool targeting the path shown.

### "Memory deletions via Bash are intercepted. A deletion marker has been recorded for: \<path\>. No further action is needed."

A deletion attempt on a memory path via Bash is intercepted and a deletion
marker is recorded automatically in the staging tree. The operation is
complete — do not retry the deletion or issue any follow-up command.

## The `project:` frontmatter field

The hook stamps `project: <name>` into every memory file it stages. **Do not
add this field yourself.** If you include it in the content you pass to Write,
the hook will update it to the correct value anyway — but if your frontmatter
already has a `project:` line the hook will overwrite it, so there is no
benefit and a potential mismatch. Leave `project:` out of any memory content
you write.

## Quick reference

| Situation | What to do |
|---|---|
| Writing a new memory file | Write to the normal memory path once. Done. |
| Editing a memory file (gatekeeper copy == live) | Edit the normal memory path. Hook applies the edit. Done. |
| Editing — divergent staging copy | Read the gatekeeper path shown in the message, then Edit it directly. |
| Got "Memory writes are redirected" | The write succeeded. Stop. |
| Got "Edit applied to the staged copy" | The edit succeeded. Stop. |
| MEMORY.md | Never write or edit it. |
| Bash memory write | Use the Write tool instead. |
| Bash memory deletion | Marker recorded automatically. Stop. |
