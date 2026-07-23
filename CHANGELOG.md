# Changelog

Notable user-visible changes are documented here.

## Unreleased

These changes are present on
[`polymorpher/cursor-history` `main`](https://github.com/polymorpher/cursor-history)
and are newer than the published `v0.16.0` npm package.

### Added

- Date-filtered backups using `backup --since` or `backup --recent`. Filtered
  archives record an exact merge-only session scope and the agent-context blob
  closure recognized by the current parser.
- Target-read-only restore preflight with integrity, scope, conflict,
  workspace, transcript, non-empty WAL/journal, archive-change, and target-race
  checks. Auto-mapping dry runs can write a TOML proposal outside Cursor data.
- Additive `restore --merge` with explicit `abort`, `newer`, `local`, and
  `backup` conflict policies.
- Reviewed cross-machine workspace mapping through TOML, exact mappings, and
  path-prefix mappings. Heuristic proposals are generated only during dry-run.
- Cursor 3 sidebar restoration for both legacy `composer.composerHeaders` JSON
  and the dedicated `composerHeaders` table.
- Agent transcript backup/restore plus best-effort synthesis of missing
  transcripts. Added the `fix-transcripts` CLI and `fixTranscripts()` library
  API.
- Preservation of recognized parent/subagent metadata and continuation-context
  blobs recognized by the current parser.
- Restore rollback snapshots and staged application of database, workspace, and
  transcript changes.

### Changed

- Backup ZIP creation and extraction now stream data with ZIP64 support instead
  of buffering multi-gigabyte databases in memory.
- Cross-machine restore rewrites recognized workspace identifiers,
  workspace-rooted path/URI fields, metadata, sidebar headers, and transcript
  project slugs when an approved mapping is supplied.
- Filtered backups require merge restore. Unknown-scope legacy archives and
  incomplete filtered archives are blocked from unsafe overwrite paths.
- Session merge remains additive: conflict policies choose metadata/header/
  transcript ownership while missing payload rows are unioned.

### Fixed

- Filtered backups now include the sidebar/header state needed for restored
  sessions to appear in modern Cursor.
- Restore now maintains the dedicated Cursor 3 `composerHeaders` table and
  version key, including recognized subagent classification.
- Large global databases no longer trigger repeated full-table scans during
  session listing; prefix queries can use SQLite indexes.
- Restore preflight rejects missing declared continuation blobs, non-empty
  WAL/journal files, archive mutation, and destination races before applying
  changes.

### Documentation

- Replaced the stale README with a canonical current-main guide, explicit
  released-versus-unreleased status, safer restore examples, and accurate
  async library examples.
- Rewrote the cross-machine guide to describe manual snapshot transfer rather
  than live synchronization.
- Added a cross-machine backup/preflight/restore workflow illustration.
- Marked old data-model reports as historical research snapshots.

## 0.16.0 - 2026-07-03

### Added

- Recovery of modern Cursor sessions that have global composer data but no
  reliable workspace stamp.

### Fixed

- Preserved session visibility across workspace migration and mixed legacy/
  global storage.
- Scoped global recovery to the active Cursor data path.

## 0.15.0 - 2026-04-06

### Added

- Stable bubble IDs in library messages and JSON/Markdown exports.
- Ordered `activeBranchBubbleIds` when Cursor provides active conversation
  headers.

## 0.14.0 - 2026-03-24

### Fixed

- Preserved complete extracted tool payloads for modern and legacy file,
  terminal, and generic tool records.
- Kept terminal display previews bounded while allowing `show --tool` to expand
  the extracted payload.
- Unblocked pnpm builds affected by the tool-content changes.

## 0.13.0 - 2026-03-20

### Added

- Structured `message.toolCalls`, bubble-type metadata, and
  `session.source: 'global' | 'workspace-fallback'`.

### Fixed

- Preserved empty bubbles and represented malformed global rows as corrupted
  placeholders instead of silently dropping them.
- Added diagnostics for missing global databases/tables, empty bubble sets,
  malformed rows, and fallback reads.

## 0.12.1 - 2026-03-19

### Added

- Support for workspaces opened through `.code-workspace` files.

### Changed

- Preferred `.code-workspace` attribution and deterministically deduplicated
  repeated session IDs when listing all workspaces.

## 0.12.0 - 2026-03-18

### Added

- Composer-ID lookup for CLI `show` and `export`.

### Changed

- Aligned CLI and library session lookup behavior.
- Improved cross-platform path handling and package export ordering.

## 0.11.2 - 2026-02-20

### Fixed

- Corrected timestamp fallback for older sessions by reading alternate timing
  fields, interpolating gaps, and using session time only as a final fallback.

## 0.11.0 - 2026-02-02

### Added

- Per-message model, token usage, and duration extraction.
- Session-level context and token summaries in CLI, JSON, and library output.

Older releases are available in the
[Git tag history](https://github.com/S2thend/cursor-history/tags).
