# Cursor History

[![npm version](https://img.shields.io/npm/v/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)

Browse, search, export, migrate, back up, and restore chat data stored by Cursor.
The project provides both a command-line interface and an asynchronous Node.js
library.

This fork builds on the original
[S2thend/cursor-history](https://github.com/S2thend/cursor-history) project. Its
current focus is safe, inspectable cross-machine restore for newer Cursor data:
dry-run preflight, conflict-aware merge, workspace path mapping, Cursor 3
sidebar data, transcripts, subagents, and known continuation context.

> [!IMPORTANT]
> The advanced restore workflow documented here is newer than the published
> `v0.16.0` npm package. Build this fork's current `main` branch to use it, and
> verify your installed command with `cursor-history restore --help`.

## What it does

- Lists sessions across Cursor workspaces, including global-only sessions.
- Shows extracted messages, thinking, tool calls, diffs, model/token metadata,
  and timing when Cursor stored those fields.
- Searches extracted message text and exports sessions as Markdown or JSON.
- Moves or copies sessions between workspaces already registered on one
  machine.
- Creates checksum-manifested full or date-filtered backup archives.
- Previews and applies cross-machine merge restores with explicit conflict and
  path-mapping policies.
- Restores Cursor 3 sidebar metadata and archived agent transcripts, and can
  synthesize missing transcripts on a best-effort basis.
- Handles sessions attached to `.code-workspace` files and preserves recognized
  parent/subagent relationships.

Cursor's storage format is private and changes over time. The tool recovers the
data it recognizes; it cannot guarantee that every field from every Cursor
version is present or resumable.

## Cross-machine workflow

![A source machine creates a portable Cursor history archive, the archive can be inspected read-only, and a destination machine performs dry-run preflight before an explicit merge restore. This is manual snapshot transfer, not live sync.](https://raw.githubusercontent.com/polymorpher/cursor-history/main/docs/cross-machine-backup-restore.svg)

This is **manual snapshot transfer**, not live or bidirectional sync. Repeat the
backup, copy, preflight, and restore steps when you want to transfer newer
sessions.

## Requirements

- Node.js 20 or newer.
- Cursor with existing local chat history.
- Enough free disk space for the archive, extraction staging, and destination
  rollback snapshots.

Node.js 22.5 or newer can use the built-in `node:sqlite` driver. Older supported
Node versions use `better-sqlite3`.

## Installation

### Current fork

Use this when following the advanced restore documentation:

```bash
git clone https://github.com/polymorpher/cursor-history.git
cd cursor-history
npm install
npm run build
npm link

cursor-history --version
cursor-history restore --help
```

### Published npm package

The published package currently follows the original project's release line:

```bash
npm install -g cursor-history
cursor-history list
```

For use as a library:

```bash
npm install cursor-history
```

## Quick start

```bash
# Recent sessions
cursor-history list

# All sessions with stable composer IDs
cursor-history list --all --ids

# Show by 1-based list index or composer ID
cursor-history show 1
cursor-history show 5f4d2a2e-...

# Search extracted message content
cursor-history search "database migration"

# Export writes a file; it does not stream the transcript to stdout
cursor-history export 1
cursor-history export 1 --format json -o session.json
```

JSON command output uses result envelopes:

```bash
cursor-history list --all --json |
  jq '.sessions[] | select(.messageCount > 10)'

cursor-history search "bug" --json |
  jq -r '.results[].sessionId'
```

## Browse, search, and export

### List

```bash
cursor-history list                     # 20 most recent sessions
cursor-history list --all               # all sessions
cursor-history list --ids               # include composer IDs
cursor-history list --workspaces        # known workspaces
cursor-history list --backup backup.zip # inspect an archive
```

Without `--workspace`, duplicate session IDs found in more than one workspace
are shown once. Attribution is deterministic: `.code-workspace` entries are
preferred, then paths are sorted lexically. This is display attribution, not
proof that only one workspace owns the session.

For a multi-root workspace, pass the absolute `.code-workspace` file path:

```bash
cursor-history --workspace /work/lp-projects.code-workspace list
```

Setting `--workspace` disables cross-workspace deduplication and currently
scopes `list` and `search`.

### Show

```bash
cursor-history show 1
cursor-history show 1 --short
cursor-history show 1 --think
cursor-history show 1 --tool
cursor-history show 1 --error
cursor-history show 1 --only user,assistant
cursor-history show 1 --only tool,error --tool
cursor-history show 1 --json
```

Long thinking, commands, tool content/results, diffs, and errors are previewed
by default. `--think`, `--tool`, and `--error` expand the extracted payload.
They cannot recover fields Cursor did not store.

Consecutive duplicate messages are folded only in the human-readable `show`
view. JSON, exports, and the library retain individual records.

### Search

Search is a case-insensitive substring match over extracted message content.
CLI context is measured in characters:

```bash
cursor-history search "react hooks"
cursor-history search "error" --limit 5 --context 120
cursor-history search "query" --backup backup.zip
```

### Export

```bash
cursor-history export 1
cursor-history export <composer-id> --format json
cursor-history export --all -o ./exports/
cursor-history export 1 --backup backup.zip
cursor-history export 1 --force
```

`--format json` selects the transcript file format. Global `--json` only changes
the command result envelope.

## Move sessions between local workspaces

Migration reassigns sessions between workspaces already registered in the same
Cursor profile. It is not a backup archive or a complete cross-machine restore.

Create a backup first, open the destination workspace in Cursor once, fully quit
Cursor, and preview the migration:

```bash
cursor-history migrate-session --dry-run 1 /path/to/destination
cursor-history migrate-session 1 /path/to/destination

cursor-history migrate-session --copy 1,3,5 /path/to/destination

cursor-history migrate --dry-run /old/project /new/project
cursor-history migrate /old/project /new/project
```

Use `--debug` to print recognized path rewrites. `--force` permits adding
sessions alongside history already present at the destination; it does not make
the operation atomic.

## Backup

Archives contain prompts, responses, code, commands, paths, and possibly
secrets. They are **not encrypted or authenticated**. Store and transfer them as
sensitive files.

For the strongest snapshot, fully quit Cursor on the source before backup.
Individual SQLite copies are consistent, but the collection of global,
workspace, and transcript files is not captured as one atomic transaction.

```bash
# Full history snapshot
cursor-history backup

# Explicit output
cursor-history backup -o ~/cursor-history-backups/source.zip

# Whole sessions updated in a recent window
cursor-history backup --recent 7d
cursor-history backup --since 2026-07-01T00:00:00Z

# Inventory archives; validate or dry-run before trusting one
cursor-history list-backups
```

`--recent` accepts hours (`h`), days (`d`), weeks (`w`), or months (`m`).
Date-only `--since` values are interpreted by JavaScript as UTC midnight.

### Full versus filtered archives

A full archive snapshots the detected global database, matching workspace
databases and metadata, and available agent transcript JSONLs. It is not a full
Cursor profile backup: project source files, settings, extensions, editor
history, AI attribution data, and unrelated Cursor state are outside its scope.

A filtered archive selects complete sessions whose update time, or creation
time fallback, meets the cutoff. It includes the known session-scoped global
rows, the agent-context blob closure recognized by the current parser, matching
workspace snapshots, and available transcripts. It is not a row-level
incremental delta. Workspace database snapshots can contain unrelated UI
metadata, while restore constrains session import to the manifest scope.

Filtered archives must be restored with `--merge`. Older filtered archives that
lack blob-closure metadata are blocked. A filtered manifest without exact
session IDs produces a warning and can omit workspace-only sessions. Recreate
either form with the current build.

## Safe restore

Restore directly modifies Cursor databases and transcript files.

Before restoring on the destination:

1. Copy or clone project source separately; backups do not contain it.
2. Open every destination workspace in Cursor once so Cursor registers it.
3. Create a separate destination backup.
4. Fully quit Cursor and keep it stopped between preflight and apply.
5. Keep both the source archive and destination safety backup until the
   restored sessions are verified.

### Preview and merge

```bash
# Read-only preflight: verifies integrity and reports conflicts/files/actions
cursor-history restore /path/to/source.zip --merge --dry-run

# Apply only when the plan reports that it can proceed
cursor-history restore /path/to/source.zip --merge
```

A normal dry run does not modify target Cursor data. A dry run with
`--auto-map-workspaces` may write a TOML proposal file for review.

Merge aborts on overlapping session IDs by default. It merges session payload
rows additively rather than replacing every row byte-for-byte.

| Strategy | Behavior for an overlapping session ID |
| --- | --- |
| `abort` | Block the restore before target changes. |
| `newer` | Choose the metadata/header owner only when both sides have unequal usable timestamps; ambiguous divergence remains blocked. |
| `local` | Retain local metadata and transcript while adding missing recognized session rows from the archive. |
| `backup` | Prefer archive metadata, header, and transcript while retaining existing same-key payload rows and adding missing rows. |

```bash
cursor-history restore source.zip --merge --dry-run \
  --conflict-strategy newer

cursor-history restore source.zip --merge \
  --conflict-strategy newer
```

`--auto-resolve-conflicts` is an alias for `--conflict-strategy newer`.

### Different usernames or project roots

Exact workspace paths already registered on the destination are matched
automatically. If paths changed, generate a proposal during dry-run:

```bash
cursor-history restore source.zip --merge --dry-run \
  --auto-map-workspaces
```

Review the generated TOML, ensure every target path exists and has been opened
in Cursor, then approve it explicitly:

```bash
cursor-history restore source.zip --merge \
  --workspace-map source.workspace-map.toml
```

Mappings can also be supplied directly:

```bash
cursor-history restore source.zip --merge \
  --map-path-prefix "/Users/source=/Users/destination" \
  --map-workspace \
  "/Users/source/work/lp.code-workspace=/Users/destination/work/lp.code-workspace"
```

Mappings recursively rewrite recognized stored strings that equal or begin with
an approved source root. This includes workspace identifiers and path/URI
fields, but message text beginning with that root can also change. Review broad
prefix mappings carefully.

### Cursor 3 sidebar, transcripts, and subagents

Restore updates both known Cursor 3 sidebar representations: the legacy
`composer.composerHeaders` item and the dedicated `composerHeaders` table.
Recognized subagents remain associated with their parent instead of being added
as ordinary top-level legacy chats.

Archived transcript JSONLs are copied when available. Missing transcripts are
synthesized by default from representable bubble text and tool inputs. This is
best effort and does not recreate every original tool result, thinking event,
or agent harness record.

```bash
# Inspect or repair missing transcripts separately
cursor-history fix-transcripts --dry-run
cursor-history fix-transcripts

# Skip synthesis during restore
cursor-history restore source.zip --merge --no-synth
```

Restart Cursor after restore or transcript repair.

### Destructive overwrite restore

`--force` is for intentional recovery from a known full-scope archive:

```bash
cursor-history restore full-backup.zip --dry-run --force
cursor-history restore full-backup.zip --force
```

It can replace destination database/transcript files included in the archive
and discard newer local changes. It does not erase unrelated files. Filtered
archives are merge-only, and forced overwrite requires a declared full-scope
archive. A legacy unknown-scope archive can restore without `--force` only when
its destinations do not already exist.

See the
[cross-machine guide](https://github.com/polymorpher/cursor-history/blob/main/LOCAL_MIGRATION.md)
for a complete transfer checklist and troubleshooting.

## Read an archive without restoring it

```bash
cursor-history list --backup backup.zip
cursor-history show 1 --backup backup.zip
cursor-history search "query" --backup backup.zip
cursor-history export 1 --backup backup.zip
```

These commands validate and read extracted archive copies; they do not modify
live Cursor data.

## Cursor data locations

The default `--data-path` is the `workspaceStorage` directory:

| Platform | Default workspace storage |
| --- | --- |
| macOS | `~/Library/Application Support/Cursor/User/workspaceStorage` |
| Windows | `%APPDATA%/Cursor/User/workspaceStorage` |
| Linux | `~/.config/Cursor/User/workspaceStorage` |

The full conversation database is the sibling
`globalStorage/state.vscdb`. Cursor 3 agent transcripts are stored separately
under:

```text
~/.cursor/projects/<workspace-slug>/agent-transcripts/<session-id>/<session-id>.jsonl
```

Use an exact `workspaceStorage` path for a custom profile:

```bash
cursor-history \
  --data-path "$HOME/Library/Application Support/Cursor/User/workspaceStorage" \
  list
```

`CURSOR_DATA_PATH` is honored by browse/search reads. For write commands, pass
the profile explicitly: use global `--data-path` before `backup` or
`fix-transcripts`, and use restore's `--target`. All of these values point to
`workspaceStorage`.

Transcript locations are separate. Restore output is controlled by
`--projects-path`; backup transcript discovery currently uses the current
user's `~/.cursor/projects` even when a custom database path is selected.

## SQLite driver

The tool auto-selects `node:sqlite` when available and otherwise uses
`better-sqlite3`. The reliable override is an environment variable set before
the first database operation:

```bash
CURSOR_HISTORY_SQLITE_DRIVER=node:sqlite cursor-history list
CURSOR_HISTORY_SQLITE_DRIVER=better-sqlite3 cursor-history list
DEBUG=cursor-history:* cursor-history list
```

## Library API

All data, migration, backup, restore, and validation functions are asynchronous.
Examples use ESM. Numeric read/export indices are zero-based in the library,
while migration identifiers currently use CLI-style one-based indices; composer
IDs are safest across API boundaries.

Library callers should pass normal absolute paths. Shell `~` expansion does not
apply inside JavaScript.

```typescript
import {
  exportSessionToMarkdown,
  getSession,
  listSessions,
  searchSessions,
} from 'cursor-history';

const page = await listSessions({ limit: 10 });
console.log(page.pagination.total);

const session = await getSession(0);
console.log(session.source, session.messages.length);

const matches = await searchSessions('authentication', { context: 2 });
const markdown = await exportSessionToMarkdown(session.id);
```

Sessions can expose stable message IDs, structured tool calls, active-branch
bubble IDs, model/token/timing fields, and a `source` value indicating full
global data or degraded workspace fallback.

### Backup and restore

```typescript
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createBackup,
  restoreBackup,
  validateBackup,
} from 'cursor-history';

const backupPath = join(homedir(), 'cursor-history-backups', 'transfer.zip');

const backup = await createBackup({ outputPath: backupPath });
if (!backup.success) {
  throw new Error(backup.error);
}

const validation = await validateBackup(backupPath);
if (validation.status !== 'valid') {
  throw new Error(validation.errors.join('\n'));
}

const preflight = await restoreBackup({
  backupPath,
  merge: true,
  dryRun: true,
  conflictStrategy: 'abort',
});

if (!preflight.success || !preflight.plan?.canApply) {
  console.error(preflight.plan?.blockers ?? preflight.error);
} else {
  const restored = await restoreBackup({
    backupPath,
    merge: true,
    conflictStrategy: 'abort',
  });
  if (!restored.success) throw new Error(restored.error);
}
```

Expected backup/restore failures are generally returned as
`{ success: false, error, plan? }`; database/configuration failures from read
APIs can reject. Always inspect the result before continuing.

Primary exports include:

- Read: `listSessions`, `getSession`, `searchSessions`
- Export: `exportSessionToJson`, `exportSessionToMarkdown`,
  `exportAllSessionsToJson`, `exportAllSessionsToMarkdown`
- Local migration: `migrateSession`, `migrateWorkspace`
- Backup: `createBackup`, `validateBackup`, `listBackups`,
  `getDefaultBackupDir`
- Restore: `restoreBackup`, `fixTranscripts`
- Message filtering: `MESSAGE_TYPES`, `getMessageType`, `filterMessages`,
  `validateMessageTypes`

## Limitations and safety

- This is not a live synchronization service.
- Cursor must be fully quit before write operations. Pending WAL or journal
  files and detected target changes can block restore.
- Backup archives do not contain project source files or a complete Cursor
  profile.
- Search works on extracted text, not semantic embeddings.
- Missing timestamps can be estimated from neighboring messages or session
  time.
- Transcript synthesis is a useful compatibility fallback, not an exact
  reconstruction.
- Tests use SQLite fixtures; no automated test launches Cursor or guarantees
  compatibility with a future private storage schema.

## Development

```bash
npm install
npm run build
npm test
npm run lint
npm run typecheck
npm run format:check
```

Report issues and submit changes in this fork:

- [Issues](https://github.com/polymorpher/cursor-history/issues)
- [Pull requests](https://github.com/polymorpher/cursor-history/pulls)

## Attribution and license

This fork is based on
[S2thend/cursor-history](https://github.com/S2thend/cursor-history), originally
copyright 2025 Borui. Thanks to the original author and contributors for the
CLI, library, storage extraction, migration, and backup foundation.

Licensed under the [MIT License](./LICENSE).
