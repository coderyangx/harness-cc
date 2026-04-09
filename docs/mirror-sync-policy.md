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
