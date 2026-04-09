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
