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

# Merge backup into existing data
cursor-history restore /path/to/backup.zip --merge

# Reopen Cursor
```

The merge automatically:
- Copies new workspace folders as-is
- Merges sessions into existing workspaces (matched by project path, not hash)
- Imports missing global database entries (full AI responses)
- Deduplicates by session ID — safe to run repeatedly

### Verify

```bash
cursor-history list --all --json | jq '.count'
```

### Incremental Sync

For ongoing sync between machines, repeat the same steps with `--recent`:

```bash
# Source machine: backup only recent changes
cursor-history backup -r 3d

# Destination machine: merge
cursor-history restore /path/to/backup.zip --merge
```

## Cursor Data Locations

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Cursor/User/` |
| Linux | `~/.config/Cursor/User/` |
| Windows | `%APPDATA%/Cursor/User/` |

Inside this directory:
- `globalStorage/state.vscdb` — full AI responses and bubble data for all sessions
- `workspaceStorage/{hash}/state.vscdb` — per-workspace session metadata
- `workspaceStorage/{hash}/workspace.json` — maps the hash folder to a project path

## Manual Method

If you need finer control, you can extract the backup to a temp location and merge manually.

### Step 1: Back Up Both Machines

```bash
cursor-history backup
```

### Step 2: Extract to Temp Location

```bash
cursor-history restore /path/to/backup.zip --target /tmp/cursor-restore/workspaceStorage
```

This extracts `globalStorage/` and `workspaceStorage/` into `/tmp/cursor-restore/`.

### Step 3: Fully Quit Cursor

Cursor caches database state in memory and will overwrite changes on disk.

### Step 4: Check for Collisions

```bash
ls /tmp/cursor-restore/workspaceStorage/ > /tmp/backup_ids.txt
ls "$HOME/Library/Application Support/Cursor/User/workspaceStorage/" > /tmp/local_ids.txt
comm -12 <(sort /tmp/backup_ids.txt) <(sort /tmp/local_ids.txt)
```

### Step 5: Copy Non-Colliding Workspace Folders

```bash
CURSOR_USER="$HOME/Library/Application Support/Cursor/User"

comm -23 <(sort /tmp/backup_ids.txt) <(sort /tmp/local_ids.txt) | while read id; do
  cp -R "/tmp/cursor-restore/workspaceStorage/$id" "$CURSOR_USER/workspaceStorage/"
done
```

### Step 6: Handle Colliding Workspace Folders

For each colliding hash, merge the composer arrays:

```bash
WORKSPACE_ID="<the colliding hash>"
BACKUP_DB="/tmp/cursor-restore/workspaceStorage/$WORKSPACE_ID/state.vscdb"
LOCAL_DB="$CURSOR_USER/workspaceStorage/$WORKSPACE_ID/state.vscdb"

BACKUP_DATA=$(sqlite3 "$BACKUP_DB" "SELECT value FROM ItemTable WHERE key = 'composer.composerData';")
LOCAL_DATA=$(sqlite3 "$LOCAL_DB" "SELECT value FROM ItemTable WHERE key = 'composer.composerData';")

MERGED=$(echo "$LOCAL_DATA" | jq --argjson backup "$BACKUP_DATA" '
  .allComposers += ($backup.allComposers // [])
  | .allComposers |= unique_by(.composerId)
')

sqlite3 "$LOCAL_DB" "UPDATE ItemTable SET value = '$(echo "$MERGED" | jq -c .)' WHERE key = 'composer.composerData';"
```

### Step 7: Merge the Global Database

```bash
sqlite3 "$CURSOR_USER/globalStorage/state.vscdb" \
  "ATTACH '/tmp/cursor-restore/globalStorage/state.vscdb' AS backup;
   INSERT OR IGNORE INTO cursorDiskKV SELECT * FROM backup.cursorDiskKV;"
```

### Step 8: Verify and Reopen Cursor

```bash
cursor-history list --all --json | jq '.count'
```

Then reopen Cursor. Clean up the temp directory once verified:

```bash
rm -rf /tmp/cursor-restore
```

## Troubleshooting

**Sessions show up in `cursor-history list` but not in Cursor's sidebar:**
Cursor was not fully quit before the merge. Quit Cursor completely (Cmd+Q / force quit) and reopen.

**`restore` says "Target directory already has Cursor data":**
Use `--merge` to import sessions, or `--force` to overwrite everything.

**Workspace hashes differ between machines for the same project:**
The `--merge` mode matches workspaces by project path (from `workspace.json`), not by hash folder name. It handles same-path-different-hash cases automatically.
