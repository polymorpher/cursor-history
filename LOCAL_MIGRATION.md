# Migrating Cursor Chat History Between Machines

This guide covers how to transfer all your Cursor AI chat history from one machine to another using `cursor-history` backup/restore plus manual SQLite merging.

The built-in `restore` command overwrites existing data, so if the destination machine already has its own Cursor chats, you need the merge workflow below to keep both.

## Prerequisites

- `cursor-history` installed on both machines (`npm install -g cursor-history`)
- `sqlite3` CLI available on both machines (pre-installed on macOS/Linux)
- `jq` for JSON processing (optional, for verification)

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

## Step 1: Back Up the Source Machine

On the machine you're migrating **from**:

```bash
cursor-history backup
```

This creates a zip file at `~/cursor-history-backups/cursor_history_backup_YYYY-MM-DD_HHMMSS.zip` containing all global and workspace databases.

Copy the zip file to the destination machine (via USB, scp, cloud storage, etc.).

## Step 2: Extract the Backup on the Destination Machine

Restore to a **temporary location** (not the live Cursor directory):

```bash
cursor-history restore /path/to/backup.zip --target /tmp/cursor-restore/workspaceStorage
```

This extracts `globalStorage/` and `workspaceStorage/` into `/tmp/cursor-restore/`.

Verify the extracted sessions:

```bash
cursor-history list --all --data-path /tmp/cursor-restore/workspaceStorage
```

## Step 3: Back Up the Destination Machine

Safety net in case anything goes wrong:

```bash
cursor-history backup
```

## Step 4: Fully Quit Cursor

**Important:** Cursor must not be running during the merge. It caches database state in memory and will overwrite your changes on disk.

- macOS: Cmd+Q (or force quit from Activity Monitor)
- Linux/Windows: Fully close all Cursor windows and processes

## Step 5: Check for Colliding Workspace Folders

Workspace storage folder names are hashes of the workspace URI. If the same project path exists on both machines (e.g., both have `/Users/yourname/git/my-project`), the hash will be identical.

```bash
# List workspace hashes from both locations
ls /tmp/cursor-restore/workspaceStorage/ > /tmp/backup_ids.txt
ls "$HOME/Library/Application Support/Cursor/User/workspaceStorage/" > /tmp/local_ids.txt

# Show colliding hashes
comm -12 <(sort /tmp/backup_ids.txt) <(sort /tmp/local_ids.txt)
```

Adjust the second `ls` path for Linux (`~/.config/Cursor/User/workspaceStorage/`) or Windows (`%APPDATA%/Cursor/User/workspaceStorage/`).

## Step 6: Copy Non-Colliding Workspace Folders

These folders don't exist on the destination, so a straight copy is safe:

```bash
CURSOR_USER="$HOME/Library/Application Support/Cursor/User"

comm -23 <(sort /tmp/backup_ids.txt) <(sort /tmp/local_ids.txt) | while read id; do
  cp -R "/tmp/cursor-restore/workspaceStorage/$id" "$CURSOR_USER/workspaceStorage/"
done
```

## Step 7: Handle Colliding Workspace Folders

For each colliding hash from Step 5, you have two options:

### Option A: Overwrite (discard destination sessions for that workspace)

```bash
WORKSPACE_ID="<the colliding hash>"
cp -R "/tmp/cursor-restore/workspaceStorage/$WORKSPACE_ID/state.vscdb" \
  "$CURSOR_USER/workspaceStorage/$WORKSPACE_ID/state.vscdb"
```

### Option B: Merge (keep sessions from both machines)

```bash
WORKSPACE_ID="<the colliding hash>"
BACKUP_DB="/tmp/cursor-restore/workspaceStorage/$WORKSPACE_ID/state.vscdb"
LOCAL_DB="$CURSOR_USER/workspaceStorage/$WORKSPACE_ID/state.vscdb"

# Extract composer arrays from both databases
BACKUP_DATA=$(sqlite3 "$BACKUP_DB" "SELECT value FROM ItemTable WHERE key = 'composer.composerData';")
LOCAL_DATA=$(sqlite3 "$LOCAL_DB" "SELECT value FROM ItemTable WHERE key = 'composer.composerData';")

# Merge: combine allComposers arrays, deduplicate by composerId
MERGED=$(echo "$LOCAL_DATA" | jq --argjson backup "$BACKUP_DATA" '
  .allComposers += ($backup.allComposers // [])
  | .allComposers |= unique_by(.composerId)
')

# Write merged data back
sqlite3 "$LOCAL_DB" "UPDATE ItemTable SET value = '$(echo "$MERGED" | jq -c .)' WHERE key = 'composer.composerData';"
```

## Step 8: Merge the Global Database

The global database stores full AI responses. Session and bubble IDs are UUIDs, so there are no collisions — `INSERT OR IGNORE` safely skips any duplicates:

```bash
sqlite3 "$CURSOR_USER/globalStorage/state.vscdb" \
  "ATTACH '/tmp/cursor-restore/globalStorage/state.vscdb' AS backup;
   INSERT OR IGNORE INTO cursorDiskKV SELECT * FROM backup.cursorDiskKV;"
```

## Step 9: Verify

```bash
cursor-history list --all --json | jq '.count'
```

For a thorough check, compare session IDs:

```bash
# Sessions from the backup
cursor-history list --all --json --data-path /tmp/cursor-restore/workspaceStorage \
  | jq -r '.sessions[].id' | sort > /tmp/backup_sessions.txt

# Sessions now on the destination
cursor-history list --all --json | jq -r '.sessions[].id' | sort > /tmp/local_sessions.txt

# Any missing?
comm -23 /tmp/backup_sessions.txt /tmp/local_sessions.txt
```

Empty output means all sessions were imported successfully.

## Step 10: Reopen Cursor

Launch Cursor. The imported sessions should appear in the chat sidebar for each workspace.

If they don't appear immediately, fully quit Cursor (Cmd+Q / close all) and reopen it — Cursor caches session state in memory on startup.

## Cleanup

Once verified, remove the temporary extraction:

```bash
rm -rf /tmp/cursor-restore
```

## Troubleshooting

**Sessions show up in `cursor-history list` but not in Cursor's sidebar:**
Cursor was not fully quit before the merge. Quit Cursor completely and reopen.

**`--workspace` filter doesn't find sessions for a `.code-workspace` file:**
This is a known limitation. Multi-root workspaces (`.code-workspace` files) use a `workspace` key in `workspace.json` instead of `folder`, which `cursor-history` doesn't read yet. The sessions are still accessible via `cursor-history list --all` and `cursor-history show`.

**`restore` says "Target directory already has Cursor data":**
Don't use `restore --force` on a live Cursor directory — it overwrites everything. Use the merge workflow above instead.
