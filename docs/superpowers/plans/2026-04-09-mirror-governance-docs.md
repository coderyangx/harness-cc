# Mirror Governance Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add permanent repository-level governance docs that codify this project as the upstream course's TypeScript mirror and define the default sync rules.

**Architecture:** Create one hard-rules file at the repo root and one detailed policy document under `docs/`. The root file defines mandatory operational rules for future sync and implementation work; the detailed doc explains sync workflow, priority rules, audit requirements, and verification expectations.

**Tech Stack:** Markdown, git

---

### Task 1: Add Root `AGENTS.md`

**Files:**
- Create: `AGENTS.md`
- Test: manual review via `sed -n '1,220p' AGENTS.md`

- [ ] **Step 1: Write the governance file**

```md
# Repository Rules

## Project Identity

- This repository is the TypeScript mirror of the upstream `shareAI-lab/learn-claude-code` course.
- The mirror target is not just docs or site structure. It includes chapter semantics and TypeScript implementations.

## Hard Rules

- Keep chapter numbering, ordering, titles, bridge docs, navigation, and page structure aligned with upstream.
- Do not keep Python source files in the repository after sync work completes.
- Do not expose Python filenames or Python source in generated data, source viewers, diff views, compare views, or docs pages.
- Python may be read only as migration input when translating upstream changes into TypeScript.
- Every upstream session chapter mirrored in the site must have a corresponding TypeScript implementation in this repository.
- Do not use `planned`, placeholder, or fallback chapter states for missing TypeScript session implementations.
- If upstream changes the semantics or key mechanism of an existing chapter, update the matching TypeScript implementation, docs, and web metadata in the same sync effort.
- Always audit already-converted chapters when syncing upstream changes; do not assume previous TypeScript conversions remain correct.

## Priority Rules

- Prioritize course-semantic alignment over superficial code similarity.
- When code parity and course-semantic clarity conflict, choose the version that best preserves the upstream teaching meaning, then continue translating implementation details into TypeScript.

## Required Verification

- Run repository tests relevant to the change.
- Run `npm run typecheck` when TypeScript source changes.
- Run `npm test` when tests or source behavior changes.
- Run `npm run build` in `web/` when site structure, generated data, or web rendering changes.
```

- [ ] **Step 2: Verify the file exists and contains the expected headings**

Run:

```bash
sed -n '1,220p' AGENTS.md
```

Expected:

- Output contains `# Repository Rules`
- Output contains `## Project Identity`
- Output contains `## Hard Rules`

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: add mirror governance rules"
```

### Task 2: Add Detailed Sync Policy Doc

**Files:**
- Create: `docs/mirror-sync-policy.md`
- Test: manual review via `sed -n '1,260p' docs/mirror-sync-policy.md`

- [ ] **Step 1: Write the detailed policy doc**

```md
# TypeScript Mirror Sync Policy

## Purpose

This document defines the default workflow for syncing this repository with the upstream course while preserving the repository's role as a TypeScript mirror.

## Core Policy

- Upstream chapter structure and teaching semantics must stay aligned.
- Session chapters must be implemented in TypeScript, not represented by placeholders.
- Python is a migration input only, never a retained project artifact.

## Sync Workflow

1. Fetch upstream changes.
2. Identify affected chapters, bridge docs, web routes, and generated data.
3. Audit existing TypeScript chapters that overlap the changed upstream area.
4. Read upstream Python chapter code when needed to understand mechanism changes.
5. Translate those changes into TypeScript implementations.
6. Update mirrored docs, metadata, localized strings, and web surfaces.
7. Remove any temporary Python artifacts before concluding the sync.
8. Run verification commands.

## Chapter Audit Rules

For already-converted chapters, review:

- title and subtitle
- core addition and key insight
- doc narrative and section ordering
- web-generated metadata
- source viewer and compare semantics
- TypeScript implementation boundaries where semantics changed upstream

## No-Fallback Rule

- Do not ship missing session chapters as `planned`.
- Do not render placeholder implementation states for mirrored upstream sessions.
- Complete the TypeScript implementation before considering the sync complete.

## Required Verification

- `npm run typecheck`
- `npm test`
- `npm run build` in `web/` when web or generated content changes

## Done Criteria

A sync is complete only when:

- no Python source remains in the repo
- no Python source is exposed in the site or generated payloads
- affected session chapters are implemented in TypeScript
- mirrored docs and web structure match upstream
- verification passes
```

- [ ] **Step 2: Verify the policy doc exists and contains the expected sections**

Run:

```bash
sed -n '1,260p' docs/mirror-sync-policy.md
```

Expected:

- Output contains `# TypeScript Mirror Sync Policy`
- Output contains `## Sync Workflow`
- Output contains `## No-Fallback Rule`

- [ ] **Step 3: Commit**

```bash
git add docs/mirror-sync-policy.md
git commit -m "docs: add TS mirror sync policy"
```

### Task 3: Link Governance Docs to Existing Spec

**Files:**
- Modify: `docs/superpowers/specs/2026-04-09-ts-mirror-course-sync-design.md`
- Test: manual review via `rg -n "AGENTS.md|mirror-sync-policy" docs/superpowers/specs/2026-04-09-ts-mirror-course-sync-design.md`

- [ ] **Step 1: Add explicit references to the governance files**

Add a short section or bullets that reference:

```md
- `AGENTS.md` as the hard-rule execution contract
- `docs/mirror-sync-policy.md` as the detailed sync workflow document
```

- [ ] **Step 2: Verify the spec references both governance docs**

Run:

```bash
rg -n "AGENTS.md|mirror-sync-policy" docs/superpowers/specs/2026-04-09-ts-mirror-course-sync-design.md
```

Expected:

- At least one match for `AGENTS.md`
- At least one match for `mirror-sync-policy`

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-04-09-ts-mirror-course-sync-design.md
git commit -m "docs: link mirror governance docs in spec"
```

### Task 4: Final Verification

**Files:**
- Verify: `AGENTS.md`
- Verify: `docs/mirror-sync-policy.md`
- Verify: `docs/superpowers/specs/2026-04-09-ts-mirror-course-sync-design.md`

- [ ] **Step 1: Verify repo status only contains the intended governance changes**

Run:

```bash
git status --short
```

Expected:

- Only the governance doc files changed before the final commit sequence

- [ ] **Step 2: Re-read the three governance files**

Run:

```bash
sed -n '1,220p' AGENTS.md
sed -n '1,260p' docs/mirror-sync-policy.md
sed -n '1,260p' docs/superpowers/specs/2026-04-09-ts-mirror-course-sync-design.md
```

Expected:

- All three files describe the same no-Python, no-placeholder TS mirror policy

- [ ] **Step 3: Commit any final adjustments**

```bash
git add AGENTS.md docs/mirror-sync-policy.md docs/superpowers/specs/2026-04-09-ts-mirror-course-sync-design.md
git commit -m "docs: finalize mirror governance contract"
```
