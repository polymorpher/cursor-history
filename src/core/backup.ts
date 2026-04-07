/**
 * Core backup and restore functionality
 *
 * This module provides low-level backup operations:
 * - SQLite database backup using pluggable driver system
 * - Zip creation/extraction using jszip
 * - Manifest generation with checksums
 * - Integrity validation
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  rmdirSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import JSZip from 'jszip';
import type { Database as DatabaseInterface, Statement } from './database/types.js';
import { registry } from './database/registry.js';
import { backupDatabase } from './database/index.js';
import type {
  BackupManifest,
  BackupFileEntry,
  BackupStats,
  BackupConfig,
  BackupResult,
  RestoreConfig,
  RestoreResult,
  MergeStats,
  BackupValidation,
  BackupInfo,
} from './types.js';
import { readWorkspaceJson } from './storage.js';
import { normalizePath } from '../lib/platform.js';

// Package version for manifest
const CURSOR_HISTORY_VERSION = '0.9.2';
const MANIFEST_VERSION = '1.0.0';

// ============================================================================
// Foundational Utilities (T005-T009)
// ============================================================================

/**
 * T005: Get the default backup directory path
 * Returns ~/cursor-history-backups/
 */
export function getDefaultBackupDir(): string {
  return join(homedir(), 'cursor-history-backups');
}

/**
 * T006: Compute SHA-256 checksum of a buffer
 */
export function computeChecksum(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

/**
 * T007: Generate a timestamped backup filename
 * Format: cursor_history_backup_YYYY-MM-DD_HHMMSS.zip
 */
export function generateBackupFilename(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `cursor_history_backup_${year}-${month}-${day}_${hours}${minutes}${seconds}.zip`;
}

/**
 * Information about a discovered database file
 */
export interface DatabaseFileInfo {
  /** Absolute path to the database file */
  absolutePath: string;
  /** Path relative to the Cursor data directory (for zip storage) */
  relativePath: string;
  /** File size in bytes */
  size: number;
  /** File type */
  type: 'global-db' | 'workspace-db' | 'workspace-json' | 'transcript';
  /** Workspace ID (for workspace DBs) */
  workspaceId?: string;
  /** Session ID (for transcript files) */
  sessionId?: string;
}

/**
 * Derive the ~/.cursor/projects/ slug from a workspace file URI.
 * e.g. "file:///Users/polymorpher/git/cursor-history" -> "Users-polymorpher-git-cursor-history"
 */
export function workspaceUriToProjectSlug(uri: string): string {
  const fsPath = uri.replace(/^file:\/\//, '');
  return fsPath.replace(/^\//, '').replace(/[/.]/g, '-');
}

/**
 * Get the ~/.cursor/projects directory path.
 */
function getCursorProjectsPath(): string {
  return join(homedir(), '.cursor', 'projects');
}

/**
 * Scan for all data files in the Cursor data directory.
 * Discovers globalStorage/state.vscdb, workspaceStorage state.vscdb files,
 * and agent transcript JSONL files under ~/.cursor/projects/.
 */
export function scanDatabaseFiles(dataPath: string): DatabaseFileInfo[] {
  const files: DatabaseFileInfo[] = [];

  // The dataPath typically points to workspaceStorage directory
  // We need to go up one level to find both globalStorage and workspaceStorage
  const userDir = dirname(dataPath);

  // Check for globalStorage/state.vscdb
  const globalDbPath = join(userDir, 'globalStorage', 'state.vscdb');
  if (existsSync(globalDbPath)) {
    const stat = statSync(globalDbPath);
    files.push({
      absolutePath: globalDbPath,
      relativePath: 'globalStorage/state.vscdb',
      size: stat.size,
      type: 'global-db',
    });
  }

  // Scan workspaceStorage for all workspace databases and workspace.json files
  const workspaceStorageDir = dataPath;
  if (existsSync(workspaceStorageDir)) {
    try {
      const entries = readdirSync(workspaceStorageDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const workspaceDir = join(workspaceStorageDir, entry.name);

          // Add state.vscdb if exists
          const workspaceDbPath = join(workspaceDir, 'state.vscdb');
          if (existsSync(workspaceDbPath)) {
            const stat = statSync(workspaceDbPath);
            files.push({
              absolutePath: workspaceDbPath,
              relativePath: `workspaceStorage/${entry.name}/state.vscdb`,
              size: stat.size,
              type: 'workspace-db',
              workspaceId: entry.name,
            });
          }

          // Add workspace.json if exists (contains workspace path metadata)
          const workspaceJsonPath = join(workspaceDir, 'workspace.json');
          if (existsSync(workspaceJsonPath)) {
            const stat = statSync(workspaceJsonPath);
            files.push({
              absolutePath: workspaceJsonPath,
              relativePath: `workspaceStorage/${entry.name}/workspace.json`,
              size: stat.size,
              type: 'workspace-json',
              workspaceId: entry.name,
            });
          }
        }
      }
    } catch {
      // Directory might not be accessible
    }
  }

  // Scan ~/.cursor/projects/*/agent-transcripts/ for JSONL transcript files
  const projectsDir = getCursorProjectsPath();
  if (existsSync(projectsDir)) {
    try {
      const projectEntries = readdirSync(projectsDir, { withFileTypes: true });
      for (const projEntry of projectEntries) {
        if (projEntry.isDirectory() === false) continue;
        const transcriptDir = join(projectsDir, projEntry.name, 'agent-transcripts');
        if (existsSync(transcriptDir) === false) continue;

        try {
          const sessionDirs = readdirSync(transcriptDir, { withFileTypes: true });
          for (const sessionDir of sessionDirs) {
            if (sessionDir.isDirectory() === false) continue;
            const jsonlPath = join(transcriptDir, sessionDir.name, `${sessionDir.name}.jsonl`);
            if (existsSync(jsonlPath) === false) continue;

            const stat = statSync(jsonlPath);
            files.push({
              absolutePath: jsonlPath,
              relativePath: `projects/${projEntry.name}/agent-transcripts/${sessionDir.name}/${sessionDir.name}.jsonl`,
              size: stat.size,
              type: 'transcript',
              sessionId: sessionDir.name,
            });
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Projects directory not accessible
    }
  }

  return files;
}

/**
 * T009: Create a manifest object from file entries and stats
 */
export function createManifest(files: BackupFileEntry[], stats: BackupStats): BackupManifest {
  const platform = process.platform as 'darwin' | 'win32' | 'linux';

  return {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    sourcePlatform: platform,
    cursorHistoryVersion: CURSOR_HISTORY_VERSION,
    files,
    stats,
  };
}

/**
 * Count sessions in a database file
 * Uses the pluggable driver system (requires driver to be pre-selected)
 */
function countSessions(dbPath: string): number {
  try {
    const db = registry.openSync(dbPath, { readonly: true });
    try {
      // Try workspace-local ItemTable first (may not exist in filtered backups)
      try {
        const row = db
          .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
          .get() as { value: string } | undefined;
        if (row) {
          const data = JSON.parse(row.value) as {
            allComposers?: unknown[];
            hasMigratedComposerData?: boolean;
          } | unknown[];
          if (Array.isArray(data)) {
            return data.length;
          }
          if (data.allComposers && Array.isArray(data.allComposers)) {
            return data.allComposers.length;
          }
          if (!Array.isArray(data) && data.hasMigratedComposerData) {
            return countSessionsFromDiskKV(db);
          }
        }
      } catch {
        // ItemTable doesn't exist (e.g. filtered global DB) -- fall through
      }

      return countSessionsFromDiskKV(db);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

function countSessionsFromDiskKV(db: ReturnType<typeof registry.openSync>): number {
  try {
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
      .get();
    if (!tableCheck) return 0;

    const result = db
      .prepare("SELECT COUNT(*) as count FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .get() as { count: number } | undefined;
    return result?.count ?? 0;
  } catch {
    return 0;
  }
}

// ============================================================================
// Backup Operations (T011-T016)
// ============================================================================

/**
 * T013: Check if there's enough disk space for the backup
 * Returns { available, required, sufficient }
 */
export function checkDiskSpace(
  outputPath: string,
  requiredBytes: number
): { available: number; required: number; sufficient: boolean } {
  // Node.js doesn't have a built-in way to check disk space
  // We'll use a simple heuristic: check if we can write a small file
  // For a proper implementation, we could use the 'check-disk-space' package
  // For now, we'll estimate available space is sufficient if the directory exists/can be created

  const dir = dirname(outputPath);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // Simplified check - assume sufficient space
    // In production, use 'check-disk-space' or similar package
    return {
      available: Number.MAX_SAFE_INTEGER,
      required: requiredBytes,
      sufficient: true,
    };
  } catch {
    return {
      available: 0,
      required: requiredBytes,
      sufficient: false,
    };
  }
}

// ============================================================================
// Date-Filtered Backup Helpers
// ============================================================================

interface ComposerHead {
  composerId?: string;
  lastUpdatedAt?: number;
  createdAt?: number;
}

/**
 * Read composer heads from a workspace database (sync, requires driver pre-selected).
 */
function readComposerHeads(dbPath: string): ComposerHead[] {
  try {
    const db = registry.openSync(dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
        .get() as { value: string } | undefined;
      if (!row) return [];
      const data = JSON.parse(row.value) as
        | { allComposers?: ComposerHead[]; hasMigratedComposerData?: boolean }
        | ComposerHead[];
      if (Array.isArray(data)) return data;
      return data.allComposers ?? [];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Read composer heads from the global cursorDiskKV table.
 */
function readGlobalComposerHeads(globalDbPath: string): ComposerHead[] {
  try {
    const db = registry.openSync(globalDbPath, { readonly: true });
    try {
      const tableCheck = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
        .get();
      if (!tableCheck) return [];

      const rows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .all() as { key: string; value: string }[];

      const heads: ComposerHead[] = [];
      for (const row of rows) {
        try {
          const data = JSON.parse(row.value) as {
            composerId?: string;
            createdAt?: number;
            lastUpdatedAt?: number;
          } | null;
          if (!data) continue;
          heads.push({
            composerId: data.composerId ?? row.key.replace('composerData:', ''),
            createdAt: typeof data.createdAt === 'number' ? data.createdAt : undefined,
            lastUpdatedAt: typeof data.lastUpdatedAt === 'number' ? data.lastUpdatedAt : undefined,
          });
        } catch {
          continue;
        }
      }
      return heads;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Get session IDs from all workspace DBs and global DB whose lastUpdatedAt >= since.
 */
function getFilteredSessionIds(dataPath: string, since: Date): Set<string> {
  const cutoff = since.getTime();
  const ids = new Set<string>();
  const basePath = dataPath;

  if (!existsSync(basePath)) return ids;

  // Scan workspace DBs
  try {
    const entries = readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dbPath = join(basePath, entry.name, 'state.vscdb');
      if (!existsSync(dbPath)) continue;

      for (const head of readComposerHeads(dbPath)) {
        if (!head.composerId) continue;
        const ts = head.lastUpdatedAt ?? head.createdAt ?? 0;
        if (ts >= cutoff) {
          ids.add(head.composerId);
        }
      }
    }
  } catch {
    // Directory not readable
  }

  // Scan global cursorDiskKV (catches sessions migrated out of workspace DBs)
  try {
    const globalDbPath = join(basePath, '..', 'globalStorage', 'state.vscdb');
    if (existsSync(globalDbPath)) {
      for (const head of readGlobalComposerHeads(globalDbPath)) {
        if (!head.composerId) continue;
        const ts = head.lastUpdatedAt ?? head.createdAt ?? 0;
        if (ts >= cutoff) {
          ids.add(head.composerId);
        }
      }
    }
  } catch {
    // Best-effort
  }

  return ids;
}

/**
 * Check whether a workspace DB has any session updated on or after `since`,
 * or contains pane-key references to any of the already-filtered session IDs.
 */
function shouldIncludeWorkspace(
  dbPath: string,
  since: Date,
  filteredIds?: Set<string>
): boolean {
  const cutoff = since.getTime();

  // Legacy path: check allComposers timestamps
  for (const head of readComposerHeads(dbPath)) {
    const ts = head.lastUpdatedAt ?? head.createdAt ?? 0;
    if (ts >= cutoff) return true;
  }

  // Post-migration: check if any filtered session IDs appear in workspace pane keys
  if (filteredIds && filteredIds.size > 0) {
    const paneSessionIds = readWorkspacePaneSessionIds(dbPath);
    for (const id of paneSessionIds) {
      if (filteredIds.has(id)) return true;
    }
  }

  return false;
}

/**
 * Extract session IDs referenced by composerChatViewPane keys in a workspace DB.
 * Each pane value contains keys like "workbench.panel.aichat.view.<sessionId>".
 */
function readWorkspacePaneSessionIds(dbPath: string): string[] {
  try {
    const db = registry.openSync(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare("SELECT value FROM ItemTable WHERE key LIKE 'workbench.panel.composerChatViewPane.%'")
        .all() as { value: string }[];

      const ids: string[] = [];
      for (const row of rows) {
        try {
          const paneData = JSON.parse(row.value) as Record<string, unknown>;
          for (const key of Object.keys(paneData)) {
            const match = key.match(/^workbench\.panel\.aichat\.view\.(.+)$/);
            if (match?.[1]) {
              ids.push(match[1]);
            }
          }
        } catch {
          continue;
        }
      }
      return ids;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Create a filtered copy of the global database containing only rows for
 * the given session IDs. Much smaller than a full copy for incremental backups.
 */
async function createFilteredGlobalDb(
  sourceDbPath: string,
  sessionIds: Set<string>,
  destPath: string
): Promise<void> {
  await registry.ensureDriver();
  const sourceDb = registry.openSync(sourceDbPath, { readonly: true });
  const destDb = registry.openSync(destPath, { readonly: false });

  try {
    destDb.runSQL('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT NOT NULL, value TEXT NOT NULL)');
    destDb.runSQL('CREATE UNIQUE INDEX IF NOT EXISTS cursorDiskKV_key ON cursorDiskKV(key)');

    const insertStmt = destDb.prepare('INSERT OR IGNORE INTO cursorDiskKV (key, value) VALUES (?, ?)');
    const selectComposer = sourceDb.prepare('SELECT key, value FROM cursorDiskKV WHERE key = ?');
    const selectBubbles = sourceDb.prepare('SELECT key, value FROM cursorDiskKV WHERE key LIKE ?');

    destDb.runSQL('BEGIN');
    for (const id of sessionIds) {
      const composer = selectComposer.get(`composerData:${id}`) as { key: string; value: string } | undefined;
      if (composer) {
        insertStmt.run(composer.key, composer.value);
      }
      const bubbles = selectBubbles.all(`bubbleId:${id}:%`) as Array<{ key: string; value: string }>;
      for (const b of bubbles) {
        insertStmt.run(b.key, b.value);
      }
    }
    destDb.runSQL('COMMIT');
  } finally {
    destDb.close();
    sourceDb.close();
  }
}

// ============================================================================
// Merge Restore Helpers
// ============================================================================

/**
 * Build a map of normalizedWorkspacePath -> localHashFolder by reading
 * workspace.json from every local workspace storage folder.
 */
function buildLocalWorkspaceMap(localWorkspaceStorageDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(localWorkspaceStorageDir)) return map;

  try {
    const entries = readdirSync(localWorkspaceStorageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wsDir = join(localWorkspaceStorageDir, entry.name);
      const wsPath = readWorkspaceJson(wsDir);
      if (wsPath) {
        map.set(normalizePath(wsPath), entry.name);
      }
    }
  } catch {
    // Not readable
  }
  return map;
}

/**
 * Merge composer sessions from a backup workspace DB into a local workspace DB.
 * New sessions are added; existing sessions are replaced if the backup version
 * has a newer lastUpdatedAt (handles conversations extended on the source machine).
 */
function mergeWorkspaceDb(backupDbPath: string, localDbPath: string): { added: number; updated: number } {
  const localDb = registry.openSync(localDbPath, { readonly: false });
  let added = 0;
  let updated = 0;

  try {
    // --- Merge allComposers (legacy, still useful for pre-migration workspaces) ---
    try {
      const localRow = localDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
        .get() as { value: string } | undefined;

      const backupDb = registry.openSync(backupDbPath, { readonly: true });
      let backupRow: { value: string } | undefined;
      try {
        backupRow = backupDb
          .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
          .get() as { value: string } | undefined;
      } finally {
        backupDb.close();
      }

      if (backupRow) {
        const backupData = JSON.parse(backupRow.value) as { allComposers?: ComposerHead[] } | ComposerHead[];
        const backupComposers: ComposerHead[] = Array.isArray(backupData) ? backupData : (backupData.allComposers ?? []);

        if (backupComposers.length > 0) {
          const localData = localRow
            ? (JSON.parse(localRow.value) as { allComposers?: ComposerHead[] } | ComposerHead[])
            : { allComposers: [] };
          const isNewFormat = !Array.isArray(localData);
          const localComposers: ComposerHead[] = Array.isArray(localData) ? localData : (localData.allComposers ?? []);

          const localById = new Map<string, ComposerHead>();
          for (const c of localComposers) {
            if (c.composerId) localById.set(c.composerId, c);
          }

          const merged: ComposerHead[] = [...localComposers];

          for (const bc of backupComposers) {
            if (!bc.composerId) continue;
            const existing = localById.get(bc.composerId);
            if (!existing) {
              merged.push(bc);
              added++;
            } else {
              const backupTs = bc.lastUpdatedAt ?? bc.createdAt ?? 0;
              const localTs = existing.lastUpdatedAt ?? existing.createdAt ?? 0;
              if (backupTs > localTs) {
                const idx = merged.indexOf(existing);
                if (idx !== -1) merged[idx] = bc;
                updated++;
              }
            }
          }

          if (added > 0 || updated > 0) {
            let dataToWrite: unknown;
            if (isNewFormat) {
              dataToWrite = { ...(localData as object), allComposers: merged };
            } else {
              dataToWrite = merged;
            }

            const jsonValue = JSON.stringify(dataToWrite);
            if (localRow) {
              localDb.prepare("UPDATE ItemTable SET value = ? WHERE key = 'composer.composerData'").run(jsonValue);
            } else {
              localDb.prepare("INSERT INTO ItemTable (key, value) VALUES ('composer.composerData', ?)").run(jsonValue);
            }
          }
        }
      }
    } catch {
      // allComposers merge failed (e.g. migrated workspace) -- continue to pane merge
    }

    // --- Merge workspace pane keys (Cursor 3.0 sidebar references) ---
    added += mergeWorkspacePaneKeys(backupDbPath, localDb);
  } finally {
    localDb.close();
  }
  return { added, updated };
}

/**
 * Merge composerChatViewPane and aichat pane keys from a backup workspace DB
 * into an already-open local workspace DB. These keys are what Cursor 3.0 uses
 * to populate its sidebar session list.
 * Returns the number of pane entries added.
 */
function mergeWorkspacePaneKeys(
  backupDbPath: string,
  localDb: ReturnType<typeof registry.openSync>
): number {
  let paneKeysAdded = 0;

  try {
    const backupDb = registry.openSync(backupDbPath, { readonly: true });
    try {
      const paneRows = backupDb
        .prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'workbench.panel.composerChatViewPane.%'")
        .all() as { key: string; value: string }[];

      const aichatRows = backupDb
        .prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'workbench.panel.aichat.%'")
        .all() as { key: string; value: string }[];

      const upsert = localDb.prepare(
        'INSERT OR IGNORE INTO ItemTable (key, value) VALUES (?, ?)'
      );

      for (const row of paneRows) {
        const result = upsert.run(row.key, row.value);
        if (typeof result === 'object' && result !== null && 'changes' in result) {
          paneKeysAdded += (result as { changes: number }).changes;
        }
      }

      for (const row of aichatRows) {
        upsert.run(row.key, row.value);
      }
    } finally {
      backupDb.close();
    }
  } catch {
    // Pane key merge is best-effort
  }

  return paneKeysAdded;
}

/**
 * Merge global database entries from backup into local.
 *
 * - composerData:* entries use INSERT OR REPLACE so that updated session
 *   headers (e.g. extended conversations with new bubble IDs) overwrite stale ones.
 * - bubbleId:* entries use INSERT OR IGNORE since bubble content is immutable;
 *   new bubbles from extended conversations get added, existing ones are kept.
 *
 * Returns the net number of rows added.
 */
function mergeGlobalDb(backupGlobalDbPath: string, localGlobalDbPath: string): number {
  const db = registry.openSync(localGlobalDbPath, { readonly: false });
  try {
    const before = (db.prepare('SELECT COUNT(*) as c FROM cursorDiskKV').get() as { c: number }).c;

    db.runSQL(`ATTACH '${backupGlobalDbPath.replace(/'/g, "''")}' AS backup`);
    // Session headers: replace if backup is newer (updated bubble list, metadata)
    db.runSQL("INSERT OR REPLACE INTO cursorDiskKV SELECT * FROM backup.cursorDiskKV WHERE key LIKE 'composerData:%'");
    // Bubble data: only add new (immutable content, unique keys)
    db.runSQL("INSERT OR IGNORE INTO cursorDiskKV SELECT * FROM backup.cursorDiskKV WHERE key LIKE 'bubbleId:%'");
    // Any other keys: add if missing
    db.runSQL("INSERT OR IGNORE INTO cursorDiskKV SELECT * FROM backup.cursorDiskKV WHERE key NOT LIKE 'composerData:%' AND key NOT LIKE 'bubbleId:%'");
    db.runSQL('DETACH backup');

    const after = (db.prepare('SELECT COUNT(*) as c FROM cursorDiskKV').get() as { c: number }).c;
    return after - before;
  } finally {
    db.close();
  }
}

// ============================================================================
// Backup Operations (T011-T016)
// ============================================================================

/**
 * T012-T016: Create a backup of Cursor chat history
 */
export async function createBackup(config?: BackupConfig): Promise<BackupResult> {
  const startTime = Date.now();

  // Determine paths
  const sourcePath = config?.sourcePath ?? getDefaultCursorDataPath();
  const outputDir = config?.outputPath ? dirname(config.outputPath) : getDefaultBackupDir();
  const outputPath = config?.outputPath ?? join(outputDir, generateBackupFilename());
  const force = config?.force ?? false;
  const onProgress = config?.onProgress;

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // T016: Check if output file exists
  if (existsSync(outputPath) && !force) {
    return {
      success: false,
      backupPath: outputPath,
      manifest: createManifest([], { totalSize: 0, sessionCount: 0, workspaceCount: 0 }),
      durationMs: Date.now() - startTime,
      error: `File already exists: ${outputPath}. Use --force to overwrite.`,
    };
  }

  // Phase: Scanning
  onProgress?.({
    phase: 'scanning',
    filesCompleted: 0,
    totalFiles: 0,
    bytesCompleted: 0,
    totalBytes: 0,
  });

  // T008: Scan for database files
  const allDbFiles = scanDatabaseFiles(sourcePath);

  if (allDbFiles.length === 0) {
    return {
      success: false,
      backupPath: outputPath,
      manifest: createManifest([], { totalSize: 0, sessionCount: 0, workspaceCount: 0 }),
      durationMs: Date.now() - startTime,
      error: `No Cursor data found at: ${sourcePath}`,
    };
  }

  // Date-filtered backup: determine which session IDs and workspaces to include
  const since = config?.since;
  let filteredIds: Set<string> | undefined;
  const includedWorkspaceIds = new Set<string>();

  if (since) {
    await registry.ensureDriver();
    filteredIds = getFilteredSessionIds(sourcePath, since);
    if (filteredIds.size === 0) {
      return {
        success: false,
        backupPath: outputPath,
        manifest: createManifest([], { totalSize: 0, sessionCount: 0, workspaceCount: 0 }),
        durationMs: Date.now() - startTime,
        error: `No sessions found updated since ${since.toISOString()}`,
      };
    }
    // Determine which workspace DBs to include
    for (const file of allDbFiles) {
      if (file.type === 'workspace-db' && file.workspaceId) {
        if (shouldIncludeWorkspace(file.absolutePath, since, filteredIds)) {
          includedWorkspaceIds.add(file.workspaceId);
        }
      }
    }
  }

  // Filter files if date-filtered
  const dbFiles = since
    ? allDbFiles.filter((f) => {
        if (f.type === 'global-db') return true;
        if (f.type === 'transcript') return f.sessionId ? filteredIds!.has(f.sessionId) : false;
        if (f.workspaceId) return includedWorkspaceIds.has(f.workspaceId);
        return false;
      })
    : allDbFiles;

  const totalBytes = dbFiles.reduce((sum, f) => sum + f.size, 0);

  // T013: Check disk space
  const spaceCheck = checkDiskSpace(outputPath, totalBytes * 2); // 2x for temp + zip
  if (!spaceCheck.sufficient) {
    return {
      success: false,
      backupPath: outputPath,
      manifest: createManifest([], { totalSize: 0, sessionCount: 0, workspaceCount: 0 }),
      durationMs: Date.now() - startTime,
      error: `Insufficient disk space`,
    };
  }

  // Create temp directory for backed up databases
  const tempDir = join(outputDir, `.backup_temp_${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    // Phase: Backing up databases
    const fileEntries: BackupFileEntry[] = [];
    let bytesCompleted = 0;
    let sessionCount = 0;
    const workspaceIds = new Set<string>();

    for (let i = 0; i < dbFiles.length; i++) {
      const dbFile = dbFiles[i]!;

      onProgress?.({
        phase: 'backing-up',
        currentFile: dbFile.relativePath,
        filesCompleted: i,
        totalFiles: dbFiles.length,
        bytesCompleted,
        totalBytes,
      });

      // Create directory structure in temp
      const tempFilePath = join(tempDir, dbFile.relativePath);
      mkdirSync(dirname(tempFilePath), { recursive: true });

      // For SQLite databases, use backup API; for other files, just copy
      if (dbFile.type === 'global-db' && filteredIds) {
        // Date-filtered: create partial global DB with only matching sessions
        await createFilteredGlobalDb(dbFile.absolutePath, filteredIds, tempFilePath);
      } else if (dbFile.type === 'global-db' || dbFile.type === 'workspace-db') {
        // T011: Backup database using SQLite backup API
        await backupDatabase(dbFile.absolutePath, tempFilePath);
      } else {
        // For non-DB files (like workspace.json), just copy
        const content = readFileSync(dbFile.absolutePath);
        writeFileSync(tempFilePath, content);
      }

      // Read backed up file and compute checksum
      const buffer = readFileSync(tempFilePath);
      const checksum = computeChecksum(buffer);

      fileEntries.push({
        path: dbFile.relativePath,
        size: buffer.length,
        checksum,
        type: dbFile.type,
      });

      // Count sessions (only for DB files)
      if (dbFile.type === 'global-db' || dbFile.type === 'workspace-db') {
        sessionCount += countSessions(tempFilePath);
      }
      if (dbFile.workspaceId) {
        workspaceIds.add(dbFile.workspaceId);
      }

      bytesCompleted += dbFile.size;
    }

    // Phase: Compressing
    onProgress?.({
      phase: 'compressing',
      filesCompleted: dbFiles.length,
      totalFiles: dbFiles.length,
      bytesCompleted: totalBytes,
      totalBytes,
    });

    // T014: Create zip file
    const zip = new JSZip();

    // Add all backed up database files
    for (const entry of fileEntries) {
      const filePath = join(tempDir, entry.path);
      // Convert path to use forward slashes for cross-platform compatibility
      const zipPath = entry.path.split(sep).join('/');
      const fileContent = readFileSync(filePath);
      zip.file(zipPath, fileContent);
    }

    // T015: Create and add manifest
    const stats: BackupStats = {
      totalSize: fileEntries.reduce((sum, f) => sum + f.size, 0),
      sessionCount,
      workspaceCount: workspaceIds.size,
    };
    const manifest = createManifest(fileEntries, stats);
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    // Phase: Finalizing
    onProgress?.({
      phase: 'finalizing',
      filesCompleted: dbFiles.length,
      totalFiles: dbFiles.length,
      bytesCompleted: totalBytes,
      totalBytes,
    });

    // Write zip file
    if (existsSync(outputPath)) {
      unlinkSync(outputPath);
    }
    const zipContent = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(outputPath, zipContent);

    return {
      success: true,
      backupPath: outputPath,
      manifest,
      durationMs: Date.now() - startTime,
    };
  } finally {
    // Clean up temp directory
    try {
      const cleanupDir = (dir: string) => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            cleanupDir(fullPath);
          } else {
            unlinkSync(fullPath);
          }
        }
        // Remove the directory itself
        try {
          rmdirSync(dir);
        } catch {
          // Ignore
        }
      };
      if (existsSync(tempDir)) {
        cleanupDir(tempDir);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ============================================================================
// Backup Viewing (T025-T026)
// ============================================================================

/**
 * Wrapper that cleans up temp file when database is closed.
 */
class TempFileCleanupWrapper implements DatabaseInterface {
  constructor(
    private innerDb: DatabaseInterface,
    private tempFilePath: string
  ) {}

  prepare(sql: string): Statement {
    return this.innerDb.prepare(sql);
  }

  runSQL(sql: string): void {
    this.innerDb.runSQL(sql);
  }

  close(): void {
    this.innerDb.close();
    // Clean up temp file
    try {
      unlinkSync(this.tempFilePath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * T025: Open a database from a backup zip file
 * Uses the pluggable driver system to open the database.
 * Extracts to a temp file since SQLite needs file access.
 * Returns a Database interface compatible with the pluggable driver system.
 */
export async function openBackupDatabase(
  backupPath: string,
  dbPath: string
): Promise<DatabaseInterface> {
  const data = await readFile(backupPath);
  const zip = await JSZip.loadAsync(data);
  const dbFile = zip.file(dbPath);

  if (!dbFile) {
    throw new Error(`Database not found in backup: ${dbPath}`);
  }

  const buffer = await dbFile.async('nodebuffer');

  // Extract to temp file since SQLite needs file access
  const tempFile = join(
    tmpdir(),
    `cursor_history_backup_${Date.now()}_${Math.random().toString(36).slice(2)}.vscdb`
  );
  writeFileSync(tempFile, buffer);

  // Use pluggable driver system - registry.openSync requires driver to already be selected
  let db: DatabaseInterface | null = null;

  try {
    db = registry.openSync(tempFile, { readonly: true });
  } catch (err) {
    // Clean up temp file on error
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }

  // Return wrapped database that will clean up temp file on close
  return new TempFileCleanupWrapper(db, tempFile);
}

/**
 * Read manifest from a backup file
 */
export async function readBackupManifest(backupPath: string): Promise<BackupManifest | null> {
  try {
    const data = await readFile(backupPath);
    const zip = await JSZip.loadAsync(data);
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) {
      return null;
    }
    const manifestBuffer = await manifestFile.async('nodebuffer');
    return JSON.parse(manifestBuffer.toString('utf-8')) as BackupManifest;
  } catch {
    return null;
  }
}

/**
 * T026: Validate backup integrity
 */
export async function validateBackup(backupPath: string): Promise<BackupValidation> {
  const errors: string[] = [];
  const validFiles: string[] = [];
  const corruptedFiles: string[] = [];
  const missingFiles: string[] = [];

  // Check if file exists
  if (!existsSync(backupPath)) {
    return {
      status: 'invalid',
      validFiles: [],
      corruptedFiles: [],
      missingFiles: [],
      errors: [`Backup file not found: ${backupPath}`],
    };
  }

  // Try to open as zip
  let zip: JSZip;
  try {
    const data = await readFile(backupPath);
    zip = await JSZip.loadAsync(data);
  } catch (e) {
    return {
      status: 'invalid',
      validFiles: [],
      corruptedFiles: [],
      missingFiles: [],
      errors: [`Invalid zip file: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  // Read manifest
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    return {
      status: 'invalid',
      validFiles: [],
      corruptedFiles: [],
      missingFiles: [],
      errors: ['Manifest file not found in backup'],
    };
  }

  let manifest: BackupManifest;
  try {
    const manifestBuffer = await manifestFile.async('nodebuffer');
    manifest = JSON.parse(manifestBuffer.toString('utf-8')) as BackupManifest;
  } catch (e) {
    return {
      status: 'invalid',
      validFiles: [],
      corruptedFiles: [],
      missingFiles: [],
      errors: [`Invalid manifest JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  // Verify each file
  for (const fileEntry of manifest.files) {
    const file = zip.file(fileEntry.path);
    if (!file) {
      missingFiles.push(fileEntry.path);
      continue;
    }

    const buffer = await file.async('nodebuffer');
    const actualChecksum = computeChecksum(buffer);
    if (actualChecksum === fileEntry.checksum) {
      validFiles.push(fileEntry.path);
    } else {
      corruptedFiles.push(fileEntry.path);
    }
  }

  // Determine status
  let status: 'valid' | 'warnings' | 'invalid';
  if (missingFiles.length > 0 || (corruptedFiles.length > 0 && validFiles.length === 0)) {
    status = 'invalid';
  } else if (corruptedFiles.length > 0) {
    status = 'warnings';
  } else {
    status = 'valid';
  }

  if (missingFiles.length > 0) {
    errors.push(`Missing files: ${missingFiles.join(', ')}`);
  }
  if (corruptedFiles.length > 0) {
    errors.push(`Corrupted files: ${corruptedFiles.join(', ')}`);
  }

  return {
    status,
    manifest,
    validFiles,
    corruptedFiles,
    missingFiles,
    errors,
  };
}

// ============================================================================
// Restore Operations (T040-T045)
// ============================================================================

/**
 * T040-T045: Restore backup to Cursor data directory
 */
export async function restoreBackup(config: RestoreConfig): Promise<RestoreResult> {
  const startTime = Date.now();
  const backupPath = config.backupPath;
  const targetPath = config.targetPath ?? getDefaultCursorDataPath();
  const force = config.force ?? false;
  const merge = config.merge ?? false;
  const onProgress = config.onProgress;

  // Phase: Validating
  onProgress?.({
    phase: 'validating',
    filesCompleted: 0,
    totalFiles: 0,
    integrityStatus: 'pending',
  });

  // Validate backup
  const validation = await validateBackup(backupPath);

  if (validation.status === 'invalid') {
    return {
      success: false,
      targetPath,
      filesRestored: 0,
      warnings: [],
      durationMs: Date.now() - startTime,
      error: validation.errors.join('; '),
    };
  }

  const manifest = validation.manifest!;
  const userDir = dirname(targetPath);
  const localGlobalDbPath = join(userDir, 'globalStorage', 'state.vscdb');
  const localWorkspaceStorageDir = targetPath;

  // --merge mode: merge backup into existing data
  if (merge) {
    return restoreBackupMerge(
      backupPath, targetPath, userDir, localGlobalDbPath, localWorkspaceStorageDir,
      manifest, validation, startTime, onProgress
    );
  }

  // Non-merge: overwrite mode (original behavior)
  if (!force && existsSync(localGlobalDbPath)) {
    return {
      success: false,
      targetPath,
      filesRestored: 0,
      warnings: [],
      durationMs: Date.now() - startTime,
      error: `Target already has Cursor data: ${userDir}. Use --force to overwrite.`,
    };
  }

  onProgress?.({
    phase: 'validating',
    filesCompleted: 0,
    totalFiles: manifest.files.length,
    integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
    corruptedFiles: validation.corruptedFiles,
  });

  // Phase: Extracting
  const data = await readFile(backupPath);
  const zip = await JSZip.loadAsync(data);
  const restoredFiles: string[] = [];
  const warnings: string[] = validation.corruptedFiles.map((f) => `Checksum mismatch: ${f}`);

  try {
    for (let i = 0; i < manifest.files.length; i++) {
      const fileEntry = manifest.files[i]!;

      onProgress?.({
        phase: 'extracting',
        currentFile: fileEntry.path,
        filesCompleted: i,
        totalFiles: manifest.files.length,
        integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
        corruptedFiles: validation.corruptedFiles,
      });

      const file = zip.file(fileEntry.path);
      if (!file) {
        continue; // Skip missing files
      }

      const buffer = await file.async('nodebuffer');

      // Convert forward slashes to platform-specific separators
      const platformPath = fileEntry.path.split('/').join(sep);

      // Transcript files go to ~/.cursor/, not under userDir
      const destPath = fileEntry.path.startsWith('projects/')
        ? join(homedir(), '.cursor', platformPath)
        : join(userDir, platformPath);

      // Create directory structure
      mkdirSync(dirname(destPath), { recursive: true });

      // Write file
      writeFileSync(destPath, buffer);
      restoredFiles.push(fileEntry.path);
    }

    // Phase: Finalizing
    onProgress?.({
      phase: 'finalizing',
      filesCompleted: manifest.files.length,
      totalFiles: manifest.files.length,
      integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
    });

    return {
      success: true,
      targetPath,
      filesRestored: restoredFiles.length,
      warnings,
      durationMs: Date.now() - startTime,
    };
  } catch (e) {
    // T043: Rollback on failure - delete any files we created
    for (const filePath of restoredFiles) {
      try {
        const platformPath = filePath.split('/').join(sep);
        const destPath = join(userDir, platformPath);
        if (existsSync(destPath)) {
          unlinkSync(destPath);
        }
      } catch {
        // Ignore rollback errors
      }
    }

    return {
      success: false,
      targetPath,
      filesRestored: 0,
      warnings,
      durationMs: Date.now() - startTime,
      error: `Restore failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Merge restore: import sessions from backup into existing Cursor data.
 * Matches workspaces by path (not hash) to handle cross-machine differences.
 */
async function restoreBackupMerge(
  backupPath: string,
  targetPath: string,
  userDir: string,
  localGlobalDbPath: string,
  localWorkspaceStorageDir: string,
  manifest: BackupManifest,
  validation: BackupValidation,
  startTime: number,
  onProgress?: (progress: import('./types.js').RestoreProgress) => void,
): Promise<RestoreResult> {
  const warnings: string[] = validation.corruptedFiles.map((f) => `Checksum mismatch: ${f}`);
  const stats: MergeStats = {
    sessionsAdded: 0,
    sessionsUpdated: 0,
    workspacesNew: 0,
    workspacesMerged: 0,
    globalRowsAdded: 0,
  };

  // Extract backup to temp directory
  const tempDir = join(userDir, `.merge_temp_${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    await registry.ensureDriver();

    onProgress?.({
      phase: 'extracting',
      filesCompleted: 0,
      totalFiles: manifest.files.length,
      integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
      corruptedFiles: validation.corruptedFiles,
    });

    // Extract all files from backup to temp
    const zipData = await readFile(backupPath);
    const zip = await JSZip.loadAsync(zipData);

    for (let i = 0; i < manifest.files.length; i++) {
      const fileEntry = manifest.files[i]!;
      const file = zip.file(fileEntry.path);
      if (!file) continue;

      const buffer = await file.async('nodebuffer');
      const platformPath = fileEntry.path.split('/').join(sep);
      const destPath = join(tempDir, platformPath);
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, buffer);

      onProgress?.({
        phase: 'extracting',
        currentFile: fileEntry.path,
        filesCompleted: i + 1,
        totalFiles: manifest.files.length,
        integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
        corruptedFiles: validation.corruptedFiles,
      });
    }

    // Build local workspace path -> hash map
    const localPathMap = buildLocalWorkspaceMap(localWorkspaceStorageDir);

    // Process each backup workspace folder
    const backupWsDir = join(tempDir, 'workspaceStorage');
    if (existsSync(backupWsDir)) {
      const entries = readdirSync(backupWsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const backupWsFolder = join(backupWsDir, entry.name);
        const backupDbPath = join(backupWsFolder, 'state.vscdb');
        if (!existsSync(backupDbPath)) continue;

        const backupWsPath = readWorkspaceJson(backupWsFolder);
        const normalizedBackupPath = backupWsPath ? normalizePath(backupWsPath) : null;

        // Find matching local workspace by path
        const localHash = normalizedBackupPath ? localPathMap.get(normalizedBackupPath) : undefined;

        if (localHash) {
          // Path exists locally: merge into local workspace DB
          const localDbPath = join(localWorkspaceStorageDir, localHash, 'state.vscdb');
          if (existsSync(localDbPath)) {
            const result = mergeWorkspaceDb(backupDbPath, localDbPath);
            stats.sessionsAdded += result.added;
            stats.sessionsUpdated += result.updated;
            stats.workspacesMerged++;
          }
        } else {
          // Path not found locally: copy entire workspace folder
          const destFolder = join(localWorkspaceStorageDir, entry.name);
          if (!existsSync(destFolder)) {
            mkdirSync(destFolder, { recursive: true });
            // Copy all files from backup workspace folder
            const wsFiles = readdirSync(backupWsFolder);
            for (const wsFile of wsFiles) {
              const src = join(backupWsFolder, wsFile);
              const dst = join(destFolder, wsFile);
              writeFileSync(dst, readFileSync(src));
            }
            // Count sessions in the newly copied workspace
            if (existsSync(join(destFolder, 'state.vscdb'))) {
              stats.sessionsAdded += countSessions(join(destFolder, 'state.vscdb'));
            }
            stats.workspacesNew++;
          }
        }
      }
    }

    // Merge global database
    const backupGlobalDbPath = join(tempDir, 'globalStorage', 'state.vscdb');
    if (existsSync(backupGlobalDbPath) && existsSync(localGlobalDbPath)) {
      stats.globalRowsAdded = mergeGlobalDb(backupGlobalDbPath, localGlobalDbPath);
    } else if (existsSync(backupGlobalDbPath) && !existsSync(localGlobalDbPath)) {
      // No local global DB yet: just copy it
      mkdirSync(dirname(localGlobalDbPath), { recursive: true });
      writeFileSync(localGlobalDbPath, readFileSync(backupGlobalDbPath));
    }

    // Copy agent transcript JSONL files to ~/.cursor/projects/
    const backupProjectsDir = join(tempDir, 'projects');
    if (existsSync(backupProjectsDir)) {
      const localProjectsDir = getCursorProjectsPath();
      let transcriptsCopied = 0;
      let transcriptsSkipped = 0;
      try {
        const projEntries = readdirSync(backupProjectsDir, { withFileTypes: true });
        for (const projEntry of projEntries) {
          if (projEntry.isDirectory() === false) continue;
          const backupTranscriptsDir = join(backupProjectsDir, projEntry.name, 'agent-transcripts');
          if (existsSync(backupTranscriptsDir) === false) continue;

          const localTranscriptsDir = join(localProjectsDir, projEntry.name, 'agent-transcripts');
          const sessionDirs = readdirSync(backupTranscriptsDir, { withFileTypes: true });
          for (const sessionDir of sessionDirs) {
            if (sessionDir.isDirectory() === false) continue;
            const destSessionDir = join(localTranscriptsDir, sessionDir.name);
            if (existsSync(destSessionDir)) {
              transcriptsSkipped++;
              continue;
            }

            mkdirSync(destSessionDir, { recursive: true });
            const backupFiles = readdirSync(join(backupTranscriptsDir, sessionDir.name));
            for (const f of backupFiles) {
              writeFileSync(
                join(destSessionDir, f),
                readFileSync(join(backupTranscriptsDir, sessionDir.name, f))
              );
            }
            transcriptsCopied++;
          }
        }
      } catch (transcriptError) {
        if (transcriptError instanceof Error) {
          warnings.push(`Transcript restore: ${transcriptError.message}`);
        }
      }
      if (transcriptsCopied > 0 || transcriptsSkipped > 0) {
        stats.sessionsAdded += transcriptsCopied;
      }
    }

    onProgress?.({
      phase: 'finalizing',
      filesCompleted: manifest.files.length,
      totalFiles: manifest.files.length,
      integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
    });

    return {
      success: true,
      targetPath,
      filesRestored: stats.workspacesNew + stats.workspacesMerged + (existsSync(join(tempDir, 'globalStorage', 'state.vscdb')) ? 1 : 0),
      warnings,
      durationMs: Date.now() - startTime,
      mergeStats: stats,
    };
  } catch (e) {
    return {
      success: false,
      targetPath,
      filesRestored: 0,
      warnings,
      durationMs: Date.now() - startTime,
      error: `Merge restore failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    // Clean up temp directory
    try {
      const cleanupDir = (dir: string) => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            cleanupDir(fullPath);
          } else {
            unlinkSync(fullPath);
          }
        }
        try { rmdirSync(dir); } catch { /* ignore */ }
      };
      if (existsSync(tempDir)) {
        cleanupDir(tempDir);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ============================================================================
// Backup Listing (T055-T057)
// ============================================================================

/**
 * T055-T057: List all backup files in a directory
 */
export async function listBackups(directory?: string): Promise<BackupInfo[]> {
  const dir = directory ?? getDefaultBackupDir();

  if (!existsSync(dir)) {
    return [];
  }

  const backups: BackupInfo[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.zip')) {
        continue;
      }

      const filePath = join(dir, entry.name);
      const stat = statSync(filePath);

      const info: BackupInfo = {
        filePath,
        filename: entry.name,
        fileSize: stat.size,
        modifiedAt: stat.mtime,
      };

      // Try to read manifest
      try {
        const manifest = await readBackupManifest(filePath);
        if (manifest) {
          info.manifest = manifest;
        } else {
          info.error = 'No manifest found';
        }
      } catch (e) {
        info.error = e instanceof Error ? e.message : String(e);
      }

      backups.push(info);
    }
  } catch {
    // Directory might not be readable
  }

  // Sort by modification time, newest first
  backups.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

  return backups;
}

// ============================================================================
// Helper to get default Cursor data path (imported from platform)
// ============================================================================

function getDefaultCursorDataPath(): string {
  const home = homedir();
  switch (process.platform) {
    case 'win32':
      return join(
        process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'),
        'Cursor',
        'User',
        'workspaceStorage'
      );
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
    default:
      return join(home, '.config', 'Cursor', 'User', 'workspaceStorage');
  }
}
