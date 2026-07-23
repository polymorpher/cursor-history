# Moving Cursor Chat History Between Machines

This guide transfers selected Cursor chat history with explicit backup and
restore commands. It is a **manual snapshot workflow**, not continuous or
bidirectional synchronization.

> [!IMPORTANT]
> The restore options in this guide are newer than the published `v0.16.0` npm
> package. Build the current
> [polymorpher/cursor-history](https://github.com/polymorpher/cursor-history)
> `main` branch and confirm the options with
> `cursor-history restore --help`.

## Before you start

- Use the same current build on the source and destination.
- Copy or clone project source files separately. Chat archives do not contain
  your repositories.
- Ensure the destination project paths exist.
- Open each destination folder or `.code-workspace` file in Cursor once so its
  workspace is registered.
- Have enough free disk space for the archive, extraction staging, and
  destination rollback snapshots.
- Treat archives as sensitive. They are unencrypted and can contain prompts,
  code, commands, tool output, paths, and secrets.

For the strongest source snapshot, fully quit Cursor before creating the
backup. Individual SQLite copies are consistent, but all global, workspace, and
transcript files are not captured as one atomic transaction.

## One-time transfer

### 1. Create the source archive

```bash
# Full chat-history snapshot
cursor-history backup -o ~/cursor-history-backups/source-full.zip

# Or select whole sessions updated during a recent window
cursor-history backup --recent 7d \
  -o ~/cursor-history-backups/source-recent.zip

# An explicit timestamp is less ambiguous for recurring transfers
cursor-history backup \
  --since 2026-07-01T00:00:00Z \
  -o ~/cursor-history-backups/source-since.zip
```

`--recent` accepts `h`, `d`, `w`, and `m` for hours, days, weeks, and months.
Date-only `--since` values are parsed at UTC midnight.

A filtered archive selects complete sessions by update time, with creation time
as a fallback. It is not a row-level incremental database delta. Filtered
archives are merge-only.

Copy the ZIP to the destination without modifying it.

### 2. Prepare the destination

Create a separate local safety backup:

```bash
cursor-history backup \
  -o ~/cursor-history-backups/destination-before-restore.zip
```

Then fully quit Cursor. Keep it stopped between preflight and the real restore.
This prevents Cursor from changing databases after the plan was calculated or
overwriting restored state from memory.

### 3. Run restore preflight

```bash
cursor-history restore /path/to/source.zip --merge --dry-run
```

Preflight validates checksums and scope, compares session IDs, checks workspace
paths, blocks non-empty SQLite WAL/journal files, detects target races, and
lists files and transcript actions. Apply only when the plan says the restore
can proceed.

A normal dry run does not modify target Cursor files. A dry run with
`--auto-map-workspaces` can write a mapping proposal TOML.

### 4. Apply the same plan

For disjoint session IDs:

```bash
cursor-history restore /path/to/source.zip --merge
```

If sessions overlap, choose and preview a conflict policy before applying it:

```bash
cursor-history restore /path/to/source.zip --merge --dry-run \
  --conflict-strategy newer

cursor-history restore /path/to/source.zip --merge \
  --conflict-strategy newer
```

Do not reopen Cursor between these two commands. Restore performs preflight
again and can stop if the target or archive changed.

### 5. Verify before deleting backups

```bash
# Keep a before-list if exact verification matters
cursor-history list --all --ids

# Inspect one known imported session by composer ID
cursor-history show <imported-composer-id> --tool
```

Then reopen Cursor and check:

1. Imported chats appear in the expected workspace/sidebar.
2. A known chat has the expected messages and tool history.
3. The chat can be referenced from Cursor's past-chat context UI.
4. Continuation behaves as expected for your Cursor version.

Keep both archives until this verification is complete.

## Different usernames or workspace roots

Exact workspace paths already present on the destination are matched
automatically. Changed paths require approved mappings, and every mapping target
must exist and be registered in Cursor.

Generate heuristic proposals only during dry-run:

```bash
cursor-history restore source.zip --merge --dry-run \
  --auto-map-workspaces
```

It is expected for this preflight to remain blocked when a proposal needs
approval. Review the TOML carefully, then pass it to the real restore:

```bash
cursor-history restore source.zip --merge \
  --workspace-map source.workspace-map.toml
```

Choose the proposal output path explicitly when useful:

```bash
cursor-history restore source.zip --merge --dry-run \
  --auto-map-workspaces \
  --mapping-output ./reviewed-workspace-map.toml
```

Mappings can also be supplied directly and repeatedly:

```bash
cursor-history restore source.zip --merge \
  --map-path-prefix "/Users/source=/Users/destination" \
  --map-workspace \
  "/Users/source/work/team.code-workspace=/Users/destination/work/team.code-workspace"
```

`--map-workspace` changes one exact workspace. `--map-path-prefix` is broader
and can affect multiple recognized workspace-rooted fields. Restore rewrites
stored strings that equal or begin with an approved source root, including
known path/URI fields, sidebar/workspace identifiers, and transcript project
slugs. Message text beginning with that root can also change, so review broad
prefix mappings carefully.

## Conflict policies

Merge is additive. A policy chooses ownership of metadata, headers, and
transcripts; it is not a byte-for-byte whole-session replacement.

| Policy | Overlapping session behavior |
| --- | --- |
| `abort` | Default. Block before target changes. |
| `newer` | Choose the metadata owner only when both sides have unequal usable timestamps. Identical sessions are skipped; equal-time or timestamp-less divergence remains blocked. |
| `local` | Keep local metadata and transcript, while adding missing recognized session-scoped rows from the archive. |
| `backup` | Prefer archive metadata/header/transcript while retaining existing same-key payload rows and adding missing rows. |

`--auto-resolve-conflicts` is shorthand for `--conflict-strategy newer`.

Here, "identical" means the conflict fingerprints match. The fingerprint covers
composer metadata plus global bubble and checkpoint rows; it does not compare
headers, transcripts, request-context rows, or OFS content.

If two machines continued the same chat independently, these policies do not
merge the divergent conversation branches into a new coherent branch.

## Recurring transfers

Use an explicit last-successful cutoff and repeat the manual workflow:

```bash
# Source
cursor-history backup \
  --since 2026-07-20T18:30:00Z \
  -o transfer-2026-07-23.zip

# Destination, with Cursor fully quit
cursor-history restore transfer-2026-07-23.zip --merge --dry-run \
  --conflict-strategy newer
cursor-history restore transfer-2026-07-23.zip --merge \
  --conflict-strategy newer
```

Advance the cutoff only after verifying the destination. A small overlap is
usually safer than a gap; identical sessions are skipped.

Old filtered archives without blob-closure metadata are blocked. A filtered
manifest without exact session IDs produces a warning and can omit
workspace-only sessions. Recreate either form with the current build.

## What restore maintains

For recognized data, merge restore can add or update:

- Global `composerData:*`, `bubbleId:*`, checkpoint, request-context, and
  related session rows.
- The content-addressed agent context blob closure recognized by the current
  parser.
- Workspace metadata and known pane/session references.
- Legacy `composer.composerHeaders` sidebar JSON.
- Cursor 3's dedicated `composerHeaders` table and version key.
- Available archived agent transcript JSONLs.
- Parent/subagent classification in recognized modern header records.

Missing transcripts are synthesized by default from representable bubble text
and tool-use inputs. Synthesis is best effort; it is not an exact copy of every
original thinking block, tool result, code artifact, or agent harness event.

```bash
cursor-history fix-transcripts --dry-run
cursor-history fix-transcripts

# Disable synthesis for one restore
cursor-history restore source.zip --merge --no-synth
```

## Data locations

The default Cursor user data roots are:

| Platform | Cursor user data |
| --- | --- |
| macOS | `~/Library/Application Support/Cursor/User` |
| Linux | `~/.config/Cursor/User` |
| Windows | `%APPDATA%/Cursor/User` |

Relevant locations:

```text
<User>/globalStorage/state.vscdb
<User>/workspaceStorage/<hash>/state.vscdb
<User>/workspaceStorage/<hash>/workspace.json
~/.cursor/projects/<slug>/agent-transcripts/<session-id>/<session-id>.jsonl
```

Custom `--data-path` and restore `--target` values point to the exact
`workspaceStorage` directory, not the `User` directory. Transcript destinations
are independent; use restore `--projects-path` to override
`~/.cursor/projects`. Backup transcript discovery currently uses the source
user's `~/.cursor/projects` even when a custom database path is selected.

Backups exclude project source, Cursor settings/extensions, editor history,
`~/.cursor/ai-tracking/ai-code-tracking.db`, and unrelated profile files.

## Troubleshooting

### Preflight reports unmapped workspaces

Create/open the destination workspaces in Cursor, quit Cursor, then rerun
preflight. If roots differ, use reviewed exact or prefix mappings.

### Preflight reports WAL, journal, SHM, or target changes

Non-empty WAL/journal files block restore because they can contain pending
database frames. SHM and zero-byte sidecars are reported as inert warnings.
Fully quit Cursor, wait for it to exit, and rerun preflight. Do not delete
sidecars blindly; preserve them with a destination backup.

### Sessions appear in `cursor-history list` but not Cursor

Restart Cursor after restore. Check that the destination workspace is
registered and that preflight reported sidebar/header and transcript actions.
Then run:

```bash
cursor-history fix-transcripts --dry-run
```

Transcript synthesis helps past-chat tagging/continuation, while sidebar listing
also depends on Cursor's header tables.

### Filtered archive refuses overwrite restore

This is intentional. Use `--merge`. Overwrite restore requires a known
full-scope archive when `--force` is used. A legacy unknown-scope archive can
restore without `--force` only when its destinations do not already exist.

### Preflight reports missing agent context blobs

The filtered archive does not contain the continuation-data closure expected by
the current format. Recreate the archive with the current build.

### Checksum or archive-change blocker

Do not force past it. Recopy or recreate the archive and rerun preflight.

### Intentional full-scope chat-history overwrite

Only use `--force` with a declared full-scope archive after taking a
destination backup. Legacy unknown-scope archives are blocked from forced
overwrite:

```bash
cursor-history restore full.zip --dry-run --force
cursor-history restore full.zip --force
```

This can replace included destination database/transcript files and discard
newer local changes. It leaves unrelated files in place.
