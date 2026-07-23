# Migrating Cursor Chat History Between Machines

Transfer your Cursor AI chat history from one machine to another.

## Quick Method (Recommended)

The simplest approach uses `--merge` to import sessions without overwriting existing data.

**On the source machine:**

```bash
# Full backup
cursor-history backup

# Or only sessions from the last N days (much smaller)
cursor-history backup -r 7d
cursor-history backup --since 2026-03-13
```

Copy the zip file to the destination machine.

**On the destination machine:**

```bash
# Fully quit Cursor first (Cmd+Q / force quit)

# Preview the import (no target files are modified)
cursor-history restore /path/to/backup.zip --merge --dry-run

# Apply when the backup sessions are disjoint
cursor-history restore /path/to/backup.zip --merge

# If sessions overlap, preview and apply "newer session wins"
cursor-history restore /path/to/backup.zip --merge --dry-run --auto-resolve-conflicts
cursor-history restore /path/to/backup.zip --merge --auto-resolve-conflicts

# If usernames/project roots differ, generate and review a mapping proposal
cursor-history restore /path/to/backup.zip --merge --dry-run --auto-map-workspaces
cursor-history restore /path/to/backup.zip --merge \
  --workspace-map /path/to/backup.workspace-map.toml

# Reopen Cursor
```

The merge automatically:
- Imports session data into the global database (`cursorDiskKV`)
- Merges session headers into the Cursor sidebar index (`composer.composerHeaders`)
- Copies workspace pane keys for UI state
- Copies agent transcript JSONL files for sidebar visibility
- Matches workspaces by project path (not hash) for cross-machine compatibility
- Aborts on overlapping session IDs by default
- Can resolve overlaps with `newer`, `local`, or `backup` conflict strategies

`--auto-resolve-conflicts` is shorthand for `--conflict-strategy newer`: backup
metadata wins only when its timestamp is newer; local-newer sessions are
skipped. Equal or timestamp-less divergent sessions remain blocked instead of
being guessed. `--conflict-strategy local` and `backup` explicitly choose one
side for every overlap.

Workspace path mappings are approval-based. `--auto-map-workspaces` is accepted
only during dry-run and writes a TOML proposal. A real restore requires that
reviewed file via `--workspace-map`, or explicit repeatable
`--map-path-prefix SOURCE=TARGET` / `--map-workspace SOURCE=TARGET` options.

### Verify

```bash
cursor-history list --all --json | jq '.count'
```

### Incremental Sync

For ongoing synchronization, repeat the same steps with `--recent`:

```bash
# Source machine: backup only recent changes
cursor-history backup -r 3d

# Destination machine: preview, then merge using newer-session resolution
cursor-history restore /path/to/backup.zip --merge --dry-run --auto-resolve-conflicts
cursor-history restore /path/to/backup.zip --merge --auto-resolve-conflicts
```

## Cursor Data Locations

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Cursor/User/` |
| Linux | `~/.config/Cursor/User/` |
| Windows | `%APPDATA%/Cursor/User/` |

Inside this directory:
- `globalStorage/state.vscdb` -- global database with two key tables:
  - `cursorDiskKV`: session data (`composerData:*`), bubble content (`bubbleId:*`), checkpoints, etc.
  - `ItemTable`: sidebar session index (`composer.composerHeaders`), UI state, telemetry
- `workspaceStorage/{hash}/state.vscdb` -- per-workspace UI state (pane keys, layout)
- `workspaceStorage/{hash}/workspace.json` -- maps the hash folder to a project path

Additional data in `~/.cursor/`:
- `projects/{slug}/agent-transcripts/{sessionId}/{sessionId}.jsonl` -- conversation transcripts
- `ai-tracking/ai-code-tracking.db` -- AI attribution data (not backed up)

### Cursor 3.0 Storage Migration

Cursor 3.0 moved session metadata from per-workspace `composer.composerData` arrays to the global `cursorDiskKV` table (individual `composerData:*` rows). The sidebar session list is now stored in `composer.composerHeaders` in the global `ItemTable`. The backup/restore tool handles both pre- and post-migration formats automatically.

## Troubleshooting

**Sessions show up in `cursor-history list` but not in Cursor's sidebar:**
Cursor must be fully quit (Cmd+Q / force quit) before the merge restore. Cursor overwrites workspace DB state on startup, so restoring while Cursor is running has no effect. If you already restored while Cursor was open, quit Cursor, re-run the restore, then reopen.

**`restore` says "Target directory already has Cursor data":**
Use `--merge` to import sessions, or `--force` to overwrite everything. Prefer `--merge` to avoid losing existing data on the target machine.

**Workspace hashes differ between machines for the same project:**
The `--merge` mode matches workspaces by project path (from `workspace.json`), not by hash folder name. It handles same-path-different-hash cases automatically.

**Usernames or workspace roots differ between machines:**
Generate a mapping proposal with `--dry-run --auto-map-workspaces`, review the
TOML, then pass it to the real restore with `--workspace-map`. Restore rewrites
workspace identifiers, workspace-rooted message paths, sidebar headers, and
transcript project slugs.

**Full backup fails with "File size is greater than 2 GiB":**
Update to the latest version. Backup now uses streaming zip (yazl) which supports files of any size via ZIP64.
