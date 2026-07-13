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
  copyFileSync,
  rmSync,
  rmdirSync,
  createWriteStream,
  createReadStream,
  constants as fsConstants,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import yazl from 'yazl';
import yauzl from 'yauzl';

/**
 * Promisified yauzl wrapper: read a zip file and extract entries by path.
 * Replaces JSZip for reading (supports ZIP64 and large files).
 */
export class ZipReader {
  private entries = new Map<string, yauzl.Entry>();
  private zipfile: yauzl.ZipFile;

  private constructor(zipfile: yauzl.ZipFile, entries: Map<string, yauzl.Entry>) {
    this.zipfile = zipfile;
    this.entries = entries;
  }

  static open(zipPath: string): Promise<ZipReader> {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: false, autoClose: false }, (err, zipfile) => {
        if (err || !zipfile) return reject(err ?? new Error('Failed to open zip'));
        const entries = new Map<string, yauzl.Entry>();
        zipfile.on('entry', (entry: yauzl.Entry) => {
          entries.set(entry.fileName, entry);
        });
        zipfile.on('end', () => resolve(new ZipReader(zipfile, entries)));
        zipfile.on('error', reject);
      });
    });
  }

  static async fromBuffer(data: Buffer, tempDir?: string): Promise<ZipReader> {
    // yauzl needs a file path; write buffer to temp file
    const tempPath = join(tempDir ?? tmpdir(), `.zip_read_${Date.now()}.zip`);
    writeFileSync(tempPath, data);
    try {
      return await ZipReader.open(tempPath);
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
    }
  }

  file(path: string): { async: (type: 'nodebuffer') => Promise<Buffer> } | null {
    const entry = this.entries.get(path);
    if (!entry) return null;
    const zf = this.zipfile;
    return {
      async: (_type: 'nodebuffer') =>
        new Promise<Buffer>((resolve, reject) => {
          zf.openReadStream(entry, (err, stream) => {
            if (err || !stream) return reject(err ?? new Error('No stream'));
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
          });
        }),
    };
  }

  /**
   * Stream a zip entry directly to a file on disk (no memory buffering).
   */
  extractToFile(entryPath: string, destPath: string): Promise<void> {
    const entry = this.entries.get(entryPath);
    if (!entry) return Promise.reject(new Error(`Entry not found: ${entryPath}`));
    return new Promise((resolve, reject) => {
      this.zipfile.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error('No stream'));
        const out = createWriteStream(destPath);
        stream.on('error', reject);
        out.on('error', reject);
        out.on('close', resolve);
        stream.pipe(out);
      });
    });
  }

  /**
   * Compute SHA-256 checksum of a zip entry via streaming.
   */
  checksumEntry(entryPath: string): Promise<string> {
    const entry = this.entries.get(entryPath);
    if (!entry) return Promise.reject(new Error(`Entry not found: ${entryPath}`));
    return new Promise((resolve, reject) => {
      this.zipfile.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error('No stream'));
        const hash = createHash('sha256');
        stream.on('data', (chunk: Buffer) => hash.update(chunk));
        stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
        stream.on('error', reject);
      });
    });
  }

  close(): void {
    try {
      this.zipfile.close();
    } catch {
      /* ignore */
    }
  }
}
import type { Database as DatabaseInterface, Statement } from './database/types.js';
import { registry } from './database/registry.js';
import { backupDatabase } from './database/index.js';
import type {
  BackupManifest,
  BackupScope,
  BackupFileEntry,
  BackupStats,
  BackupConfig,
  BackupResult,
  RestoreConfig,
  RestoreResult,
  RestorePlan,
  MergeStats,
  BackupValidation,
  BackupInfo,
} from './types.js';
import { readWorkspaceJson } from './storage.js';
import { normalizePath } from '../lib/platform.js';
import { synthesizeMissingTranscripts, workspacePathToProjectSlug } from './transcript.js';

// Package version for manifest
const CURSOR_HISTORY_VERSION = '0.9.2';
const MANIFEST_VERSION = '1.1.0';

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
 * Compute SHA-256 checksum of a file using streaming (handles files > 2GB).
 */
async function computeFileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
    stream.on('error', reject);
  });
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
 *
 * Mirrors Cursor's slug rule: every non-alphanumeric character becomes '-',
 * runs collapse, leading/trailing '-' trimmed (so "_" and spaces map to '-').
 */
export function workspaceUriToProjectSlug(uri: string): string {
  return workspacePathToProjectSlug(uri);
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
export function createManifest(
  files: BackupFileEntry[],
  stats: BackupStats,
  scope: BackupScope = { type: 'full' }
): BackupManifest {
  const platform = process.platform as 'darwin' | 'win32' | 'linux';

  return {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    sourcePlatform: platform,
    cursorHistoryVersion: CURSOR_HISTORY_VERSION,
    files,
    stats,
    scope,
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
          const data = JSON.parse(row.value) as
            | {
                allComposers?: unknown[];
                hasMigratedComposerData?: boolean;
              }
            | unknown[];
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

const LEGACY_CHAT_DATA_KEYS = [
  'workbench.panel.aichat.view.aichat.chatdata',
  'workbench.panel.chat.view.chat.chatdata',
] as const;

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

function parseTimestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function readLegacySessionHeads(dbPath: string): ComposerHead[] {
  try {
    const db = registry.openSync(dbPath, { readonly: true });
    try {
      const heads: ComposerHead[] = [];
      for (const key of LEGACY_CHAT_DATA_KEYS) {
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
          | { value: string }
          | undefined;
        if (!row) continue;
        const parsed = JSON.parse(row.value) as unknown;
        const sessions = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object'
            ? ((parsed as Record<string, unknown>)['chatSessions'] ??
              (parsed as Record<string, unknown>)['tabs'])
            : [];
        if (!Array.isArray(sessions)) continue;
        for (const session of sessions) {
          if (!session || typeof session !== 'object') continue;
          const record = session as Record<string, unknown>;
          const composerId = record['id'] ?? record['composerId'];
          if (typeof composerId !== 'string' || composerId.length === 0) continue;
          heads.push({
            composerId,
            createdAt: parseTimestampValue(record['createdAt']),
            lastUpdatedAt:
              parseTimestampValue(record['lastUpdatedAt']) ??
              parseTimestampValue(record['updatedAt']) ??
              parseTimestampValue(record['lastSendTime']),
          });
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
      for (const head of readLegacySessionHeads(dbPath)) {
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
function shouldIncludeWorkspace(dbPath: string, since: Date, filteredIds?: Set<string>): boolean {
  const cutoff = since.getTime();

  // Legacy path: check allComposers timestamps
  for (const head of readComposerHeads(dbPath)) {
    const ts = head.lastUpdatedAt ?? head.createdAt ?? 0;
    if (ts >= cutoff) return true;
  }
  for (const head of readLegacySessionHeads(dbPath)) {
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
        .prepare(
          "SELECT value FROM ItemTable WHERE key LIKE 'workbench.panel.composerChatViewPane.%'"
        )
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
    destDb.runSQL(
      'CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT NOT NULL, value TEXT NOT NULL)'
    );
    destDb.runSQL('CREATE UNIQUE INDEX IF NOT EXISTS cursorDiskKV_key ON cursorDiskKV(key)');

    const insertStmt = destDb.prepare(
      'INSERT OR IGNORE INTO cursorDiskKV (key, value) VALUES (?, ?)'
    );
    const selectComposer = sourceDb.prepare('SELECT key, value FROM cursorDiskKV WHERE key = ?');
    const selectRange = sourceDb.prepare(
      'SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?'
    );

    destDb.runSQL('BEGIN');
    for (const id of sessionIds) {
      const composer = selectComposer.get(`composerData:${id}`) as
        | { key: string; value: string }
        | undefined;
      if (composer) {
        insertStmt.run(composer.key, composer.value);
      }
      for (const prefix of [`bubbleId:${id}:`, `checkpointId:${id}:`]) {
        const rows = selectRange.all(prefix, `${prefix.slice(0, -1)};`) as Array<{
          key: string;
          value: string;
        }>;
        for (const row of rows) {
          insertStmt.run(row.key, row.value);
        }
      }
    }
    destDb.runSQL('COMMIT');

    // Copy composer.composerHeaders from ItemTable, filtered to matching sessions.
    // This is the Cursor 3.0 sidebar index -- without it, merged sessions won't
    // appear in the target machine's sidebar.
    try {
      const headersRow = sourceDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'")
        .get() as { value: string } | undefined;

      if (headersRow) {
        const parsed = JSON.parse(headersRow.value) as {
          allComposers?: Array<Record<string, unknown>>;
        };
        const allHeaders = parsed.allComposers ?? [];
        const filtered = allHeaders.filter(
          (h) => typeof h['composerId'] === 'string' && sessionIds.has(h['composerId'] as string)
        );

        if (filtered.length > 0) {
          destDb.runSQL(
            'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT NOT NULL, value TEXT NOT NULL)'
          );
          destDb.runSQL('CREATE UNIQUE INDEX IF NOT EXISTS ItemTable_key ON ItemTable(key)');
          destDb
            .prepare(
              "INSERT OR IGNORE INTO ItemTable (key, value) VALUES ('composer.composerHeaders', ?)"
            )
            .run(JSON.stringify({ allComposers: filtered }));
        }
      }
    } catch {
      // ItemTable may not exist in older Cursor versions
    }
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
 * Only sessions selected by the restore preflight are added. Existing sessions
 * are never updated: merge restore requires disjoint session IDs.
 */
function mergeWorkspaceDb(
  backupDbPath: string,
  localDbPath: string,
  allowedSessionIds: Set<string>
): { added: number; updated: number } {
  const localDb = registry.openSync(localDbPath, { readonly: false });
  let added = 0;
  let inTransaction = false;

  try {
    localDb.runSQL('BEGIN IMMEDIATE');
    inTransaction = true;
    const currentIds = readWorkspaceSessionIdsFromDatabase(localDb, true);
    for (const sessionId of allowedSessionIds) {
      if (currentIds.has(sessionId)) {
        throw new Error(`Session appeared in workspace after preflight: ${sessionId}`);
      }
    }

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
        const backupData = JSON.parse(backupRow.value) as
          | { allComposers?: ComposerHead[] }
          | ComposerHead[];
        const backupComposers: ComposerHead[] = Array.isArray(backupData)
          ? backupData
          : (backupData.allComposers ?? []);

        if (backupComposers.length > 0) {
          const localData = localRow
            ? (JSON.parse(localRow.value) as { allComposers?: ComposerHead[] } | ComposerHead[])
            : { allComposers: [] };
          const isNewFormat = !Array.isArray(localData);
          const localComposers: ComposerHead[] = Array.isArray(localData)
            ? localData
            : (localData.allComposers ?? []);

          const localById = new Map<string, ComposerHead>();
          for (const c of localComposers) {
            if (c.composerId) localById.set(c.composerId, c);
          }

          const merged: ComposerHead[] = [...localComposers];

          for (const bc of backupComposers) {
            if (!bc.composerId || !allowedSessionIds.has(bc.composerId)) continue;
            const existing = localById.get(bc.composerId);
            if (!existing) {
              merged.push(bc);
              localById.set(bc.composerId, bc);
              added++;
            }
          }

          if (added > 0) {
            let dataToWrite: unknown;
            if (isNewFormat) {
              dataToWrite = { ...(localData as object), allComposers: merged };
            } else {
              dataToWrite = merged;
            }

            const jsonValue = JSON.stringify(dataToWrite);
            if (localRow) {
              localDb
                .prepare("UPDATE ItemTable SET value = ? WHERE key = 'composer.composerData'")
                .run(jsonValue);
            } else {
              localDb
                .prepare("INSERT INTO ItemTable (key, value) VALUES ('composer.composerData', ?)")
                .run(jsonValue);
            }
          }
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to merge workspace composer metadata: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    added += mergeLegacyWorkspaceChats(backupDbPath, localDb, allowedSessionIds);

    // --- Merge workspace pane keys (Cursor 3.0 sidebar references) ---
    added += mergeWorkspacePaneKeys(backupDbPath, localDb, allowedSessionIds, true);
    localDb.runSQL('COMMIT');
    inTransaction = false;

    // Flush WAL to main DB file so Cursor sees changes on next startup
    try {
      localDb.runSQL('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* best-effort */
    }
  } catch (error) {
    if (inTransaction) {
      try {
        localDb.runSQL('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
    }
    throw error;
  } finally {
    localDb.close();
  }
  return { added, updated: 0 };
}

function filterWorkspacePaneValue(
  value: string,
  allowedSessionIds: Set<string>,
  strict = false
): string | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    let includesAllowedSession = false;

    for (const [key, entryValue] of Object.entries(parsed)) {
      const match = key.match(/^workbench\.panel\.aichat\.view\.(.+)$/);
      if (!match) {
        filtered[key] = entryValue;
      } else if (match[1] && allowedSessionIds.has(match[1])) {
        filtered[key] = entryValue;
        includesAllowedSession = true;
      }
    }

    return includesAllowedSession ? JSON.stringify(filtered) : null;
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

function legacySessionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = record['id'] ?? record['composerId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function addLegacySessionIds(value: string, ids: Set<string>): void {
  const parsed = JSON.parse(value) as unknown;
  const containers: unknown[][] = [];
  if (Array.isArray(parsed)) {
    containers.push(parsed);
  } else if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record['chatSessions'])) containers.push(record['chatSessions']);
    if (Array.isArray(record['tabs'])) containers.push(record['tabs']);
  }
  for (const sessions of containers) {
    for (const session of sessions) {
      const id = legacySessionId(session);
      if (id) ids.add(id);
    }
  }
}

function filterLegacyChatData(value: string, allowedSessionIds: Set<string>): string {
  const parsed = JSON.parse(value) as unknown;
  const filterSessions = (sessions: unknown[]) =>
    sessions.filter((session) => {
      const id = legacySessionId(session);
      return id !== null && allowedSessionIds.has(id);
    });

  if (Array.isArray(parsed)) return JSON.stringify(filterSessions(parsed));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Legacy chat data is not an object or array');
  }
  const next = { ...(parsed as Record<string, unknown>) };
  if (Array.isArray(next['chatSessions'])) {
    next['chatSessions'] = filterSessions(next['chatSessions']);
  }
  if (Array.isArray(next['tabs'])) {
    next['tabs'] = filterSessions(next['tabs']);
  }
  return JSON.stringify(next);
}

function mergeLegacyChatData(
  localValue: string | undefined,
  backupValue: string,
  allowedSessionIds: Set<string>
): string {
  const filteredBackup = JSON.parse(
    filterLegacyChatData(backupValue, allowedSessionIds)
  ) as unknown;
  if (!localValue) return JSON.stringify(filteredBackup);

  const local = JSON.parse(localValue) as unknown;
  const appendUnique = (current: unknown[], incoming: unknown[]) => {
    const ids = new Set(current.map(legacySessionId).filter((id): id is string => id !== null));
    return [
      ...current,
      ...incoming.filter((session) => {
        const id = legacySessionId(session);
        return id !== null && ids.has(id) === false;
      }),
    ];
  };

  if (Array.isArray(local) && Array.isArray(filteredBackup)) {
    return JSON.stringify(appendUnique(local, filteredBackup));
  }
  if (
    !local ||
    typeof local !== 'object' ||
    !filteredBackup ||
    typeof filteredBackup !== 'object' ||
    Array.isArray(local) ||
    Array.isArray(filteredBackup)
  ) {
    throw new Error('Legacy chat data formats do not match');
  }

  const next = { ...(local as Record<string, unknown>) };
  const backupRecord = filteredBackup as Record<string, unknown>;
  for (const key of ['chatSessions', 'tabs']) {
    const incoming = backupRecord[key];
    if (!Array.isArray(incoming)) continue;
    const current = next[key];
    next[key] = Array.isArray(current) ? appendUnique(current, incoming) : incoming;
  }
  return JSON.stringify(next);
}

function mergeLegacyWorkspaceChats(
  backupDbPath: string,
  localDb: DatabaseInterface,
  allowedSessionIds: Set<string>
): number {
  const backupDb = registry.openSync(backupDbPath, { readonly: true });
  let added = 0;
  try {
    for (const key of LEGACY_CHAT_DATA_KEYS) {
      const backupRow = backupDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      if (!backupRow) continue;
      const localRow = localDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      const backupIds = new Set<string>();
      addLegacySessionIds(backupRow.value, backupIds);
      let selected = 0;
      for (const id of backupIds) {
        if (allowedSessionIds.has(id)) selected++;
      }
      if (selected === 0) continue;
      added += selected;
      const merged = mergeLegacyChatData(localRow?.value, backupRow.value, allowedSessionIds);
      if (localRow) {
        localDb.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(merged, key);
      } else {
        localDb.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(key, merged);
      }
    }
  } finally {
    backupDb.close();
  }
  return added;
}

/**
 * Merge composerChatViewPane and aichat pane keys from a backup workspace DB
 * into an already-open local workspace DB. These keys are what Cursor 3.0 uses
 * to populate its sidebar session list.
 * Returns the number of pane entries added.
 */
function mergeWorkspacePaneKeys(
  backupDbPath: string,
  localDb: ReturnType<typeof registry.openSync>,
  allowedSessionIds: Set<string>,
  strict = false
): number {
  let paneKeysAdded = 0;

  try {
    const backupDb = registry.openSync(backupDbPath, { readonly: true });
    try {
      const paneRows = backupDb
        .prepare(
          "SELECT key, value FROM ItemTable WHERE key LIKE 'workbench.panel.composerChatViewPane.%'"
        )
        .all() as { key: string; value: string }[];

      const aichatRows = backupDb
        .prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'workbench.panel.aichat.%'")
        .all() as { key: string; value: string }[];

      const insert = localDb.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
      const insertIfMissing = localDb.prepare(
        'INSERT OR IGNORE INTO ItemTable (key, value) VALUES (?, ?)'
      );
      const selectExisting = localDb.prepare('SELECT value FROM ItemTable WHERE key = ?');
      const updateExisting = localDb.prepare('UPDATE ItemTable SET value = ? WHERE key = ?');

      // Collect ALL pane IDs from the backup (not just newly inserted ones)
      // so viewContainersWorkspaceState can be checked even on repeat restores.
      const backupPaneIds: string[] = [];

      for (const row of paneRows) {
        const filteredValue = filterWorkspacePaneValue(row.value, allowedSessionIds, strict);
        if (!filteredValue) continue;
        const paneId = row.key.replace('workbench.panel.composerChatViewPane.', '');
        backupPaneIds.push(paneId);
        const existing = selectExisting.get(row.key) as { value: string } | undefined;
        if (!existing) {
          insert.run(row.key, filteredValue);
          paneKeysAdded++;
          continue;
        }

        try {
          const localValue = JSON.parse(existing.value) as Record<string, unknown>;
          const backupValue = JSON.parse(filteredValue) as Record<string, unknown>;
          let changed = false;
          for (const [key, value] of Object.entries(backupValue)) {
            if (
              key.startsWith('workbench.panel.aichat.view.') &&
              Object.hasOwn(localValue, key) === false
            ) {
              localValue[key] = value;
              changed = true;
            }
          }
          if (changed) {
            updateExisting.run(JSON.stringify(localValue), row.key);
            paneKeysAdded++;
          }
        } catch {
          // Never replace malformed local pane state.
        }
      }

      for (const row of aichatRows) {
        if (backupPaneIds.some((paneId) => row.key.includes(paneId))) {
          insertIfMissing.run(row.key, row.value);
        }
      }

      // Register new pane containers in viewContainersWorkspaceState so Cursor's sidebar sees them
      if (backupPaneIds.length > 0) {
        try {
          const vcsRow = localDb
            .prepare(
              "SELECT value FROM ItemTable WHERE key = 'workbench.auxiliarybar.viewContainersWorkspaceState'"
            )
            .get() as { value: string } | undefined;

          const containers: Array<{ id: string; visible: boolean }> = vcsRow
            ? (JSON.parse(vcsRow.value) as Array<{ id: string; visible: boolean }>)
            : [];

          const existingIds = new Set(containers.map((c) => c.id));
          let added = false;
          for (const paneId of backupPaneIds) {
            const containerId = `workbench.panel.aichat.${paneId}`;
            if (existingIds.has(containerId) === false) {
              containers.push({ id: containerId, visible: false });
              added = true;
            }
          }

          if (added) {
            const json = JSON.stringify(containers);
            if (vcsRow) {
              localDb
                .prepare(
                  "UPDATE ItemTable SET value = ? WHERE key = 'workbench.auxiliarybar.viewContainersWorkspaceState'"
                )
                .run(json);
            } else {
              localDb
                .prepare(
                  "INSERT INTO ItemTable (key, value) VALUES ('workbench.auxiliarybar.viewContainersWorkspaceState', ?)"
                )
                .run(json);
            }
          }
        } catch (error) {
          if (strict) throw error;
        }
      }
    } finally {
      backupDb.close();
    }
  } catch (error) {
    if (strict) throw error;
  }

  return paneKeysAdded;
}

/**
 * Filter a newly copied workspace database to the sessions selected by a
 * filtered backup. Workspace DB files are copied whole during backup creation,
 * so this prevents out-of-window metadata from leaking into the restore.
 */
function filterWorkspaceDbToSessionIds(
  workspaceDbPath: string,
  allowedSessionIds: Set<string>
): void {
  const db = registry.openSync(workspaceDbPath, { readonly: false });
  try {
    try {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
        .get() as { value: string } | undefined;
      if (row) {
        const parsed = JSON.parse(row.value) as ComposerHead[] | { allComposers?: ComposerHead[] };
        const composers = Array.isArray(parsed) ? parsed : (parsed.allComposers ?? []);
        const filtered = composers.filter(
          (composer) =>
            typeof composer.composerId === 'string' && allowedSessionIds.has(composer.composerId)
        );
        let nextValue: unknown;
        if (Array.isArray(parsed)) {
          nextValue = filtered;
        } else {
          const nextObject: Record<string, unknown> = {
            ...(parsed as Record<string, unknown>),
            allComposers: filtered,
          };
          for (const [key, value] of Object.entries(nextObject)) {
            if (key.endsWith('ComposerIds') && Array.isArray(value)) {
              nextObject[key] = value.filter(
                (id): id is string => typeof id === 'string' && allowedSessionIds.has(id)
              );
            } else if (
              key.endsWith('ComposerId') &&
              typeof value === 'string' &&
              !allowedSessionIds.has(value)
            ) {
              delete nextObject[key];
            }
          }
          nextValue = nextObject;
        }
        db.prepare("UPDATE ItemTable SET value = ? WHERE key = 'composer.composerData'").run(
          JSON.stringify(nextValue)
        );
      }
    } catch (error) {
      throw new Error(
        `Failed to filter workspace composer metadata: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    try {
      for (const key of LEGACY_CHAT_DATA_KEYS) {
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
          | { value: string }
          | undefined;
        if (!row) continue;
        db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(
          filterLegacyChatData(row.value, allowedSessionIds),
          key
        );
      }
    } catch (error) {
      throw new Error(
        `Failed to filter legacy workspace chat data: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    try {
      const paneRows = db
        .prepare(
          "SELECT key, value FROM ItemTable WHERE key LIKE 'workbench.panel.composerChatViewPane.%'"
        )
        .all() as Array<{ key: string; value: string }>;
      for (const row of paneRows) {
        const filteredValue = filterWorkspacePaneValue(row.value, allowedSessionIds, true);
        if (filteredValue) {
          db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(filteredValue, row.key);
        } else {
          db.prepare('DELETE FROM ItemTable WHERE key = ?').run(row.key);
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to filter workspace pane state: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    try {
      db.runSQL('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Best-effort.
    }
  } finally {
    db.close();
  }
}

/**
 * Read all session IDs (composerData:* keys) from an open global DB.
 */
function readGlobalSessionIdsFromDatabase(db: DatabaseInterface, strict = false): Set<string> {
  const ids = new Set<string>();
  try {
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
      .get();
    if (!tableCheck) return ids;
    const rows = db
      .prepare(
        "SELECT key FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'"
      )
      .all() as Array<{ key: string }>;
    for (const row of rows) {
      ids.add(row.key.replace('composerData:', ''));
    }
  } catch (error) {
    if (strict) throw error;
  }
  return ids;
}

function readGlobalReferencedSessionIdsFromDatabase(
  db: DatabaseInterface,
  strict = false
): Set<string> {
  const ids = readGlobalSessionIdsFromDatabase(db, strict);
  try {
    for (const prefix of ['bubbleId:', 'checkpointId:']) {
      const rows = db
        .prepare('SELECT key FROM cursorDiskKV WHERE key >= ? AND key < ?')
        .all(prefix, `${prefix.slice(0, -1)};`) as Array<{ key: string }>;
      for (const row of rows) {
        const remainder = row.key.slice(prefix.length);
        const separator = remainder.indexOf(':');
        if (separator > 0) ids.add(remainder.slice(0, separator));
      }
    }

    const headersRow = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'")
      .get() as { value: string } | undefined;
    if (headersRow) {
      const parsed = JSON.parse(headersRow.value) as {
        allComposers?: Array<{ composerId?: string }>;
      };
      for (const header of parsed.allComposers ?? []) {
        if (typeof header.composerId === 'string' && header.composerId.length > 0) {
          ids.add(header.composerId);
        }
      }
    }
  } catch (error) {
    if (strict) throw error;
  }
  return ids;
}

/**
 * Read all legacy session IDs from an open workspace DB.
 */
function readWorkspaceSessionIdsFromDatabase(db: DatabaseInterface, strict = false): Set<string> {
  const ids = new Set<string>();
  try {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
      .get() as { value: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as
        | Array<{ composerId?: string }>
        | Record<string, unknown>;
      const composers = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed['allComposers'])
          ? (parsed['allComposers'] as Array<{ composerId?: string }>)
          : [];
      for (const composer of composers) {
        if (typeof composer.composerId === 'string' && composer.composerId.length > 0) {
          ids.add(composer.composerId);
        }
      }

      if (!Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (key.endsWith('ComposerIds') && Array.isArray(value)) {
            for (const id of value) {
              if (typeof id === 'string' && id.length > 0) ids.add(id);
            }
          } else if (key.endsWith('ComposerId') && typeof value === 'string' && value.length > 0) {
            ids.add(value);
          }
        }
      }
    }

    const paneRows = db
      .prepare(
        "SELECT value FROM ItemTable WHERE key LIKE 'workbench.panel.composerChatViewPane.%'"
      )
      .all() as Array<{ value: string }>;
    for (const paneRow of paneRows) {
      const parsed = JSON.parse(paneRow.value) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        const match = key.match(/^workbench\.panel\.aichat\.view\.(.+)$/);
        if (match?.[1]) ids.add(match[1]);
      }
    }

    for (const key of LEGACY_CHAT_DATA_KEYS) {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      if (row) addLegacySessionIds(row.value, ids);
    }
  } catch (error) {
    if (strict) throw error;
  }
  return ids;
}

/**
 * Merge global database entries from backup into local.
 *
 * Preflight rejects overlapping session IDs. This function rechecks that
 * invariant under BEGIN IMMEDIATE, then inserts only selected composer and
 * bubble rows.
 *
 * Returns the net number of rows added.
 */
function mergeGlobalDb(
  backupGlobalDbPath: string,
  localGlobalDbPath: string,
  allowedSessionIds: Set<string>
): number {
  const db = registry.openSync(localGlobalDbPath, { readonly: false });
  let attached = false;
  let inTransaction = false;
  try {
    const before = (db.prepare('SELECT COUNT(*) as c FROM cursorDiskKV').get() as { c: number }).c;

    db.runSQL(`ATTACH '${backupGlobalDbPath.replace(/'/g, "''")}' AS backup`);
    attached = true;
    db.runSQL('BEGIN IMMEDIATE');
    inTransaction = true;

    const localComposer = db.prepare('SELECT 1 FROM cursorDiskKV WHERE key = ?');
    const localBubble = db.prepare('SELECT 1 FROM cursorDiskKV WHERE key >= ? AND key < ? LIMIT 1');
    const insertComposer = db.prepare(
      'INSERT OR IGNORE INTO cursorDiskKV SELECT * FROM backup.cursorDiskKV WHERE key = ?'
    );
    const insertRange = db.prepare(
      'INSERT OR IGNORE INTO cursorDiskKV SELECT * FROM backup.cursorDiskKV WHERE key >= ? AND key < ?'
    );

    for (const sessionId of allowedSessionIds) {
      const composerKey = `composerData:${sessionId}`;
      const bubbleStart = `bubbleId:${sessionId}:`;
      const bubbleEnd = `bubbleId:${sessionId};`;
      if (localComposer.get(composerKey) || localBubble.get(bubbleStart, bubbleEnd)) {
        throw new Error(`Session appeared after preflight: ${sessionId}`);
      }
      insertComposer.run(composerKey);
      insertRange.run(bubbleStart, bubbleEnd);
      const checkpointStart = `checkpointId:${sessionId}:`;
      const checkpointEnd = `checkpointId:${sessionId};`;
      insertRange.run(checkpointStart, checkpointEnd);
    }

    db.runSQL('COMMIT');
    inTransaction = false;
    db.runSQL('DETACH backup');
    attached = false;

    const after = (db.prepare('SELECT COUNT(*) as c FROM cursorDiskKV').get() as { c: number }).c;

    // Flush WAL to main DB file so Cursor sees changes on next startup
    try {
      db.runSQL('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* best-effort */
    }

    return after - before;
  } catch (error) {
    if (inTransaction) {
      try {
        db.runSQL('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
    }
    if (attached) {
      try {
        db.runSQL('DETACH backup');
      } catch {
        // Preserve the original error.
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

function initializeEmptyRestoreGlobalDb(globalDbPath: string): void {
  const db = registry.openSync(globalDbPath, { readonly: false });
  try {
    db.runSQL('CREATE TABLE cursorDiskKV (key TEXT NOT NULL, value TEXT NOT NULL)');
    db.runSQL('CREATE UNIQUE INDEX cursorDiskKV_key ON cursorDiskKV(key)');
    db.runSQL('CREATE TABLE ItemTable (key TEXT NOT NULL, value TEXT NOT NULL)');
    db.runSQL('CREATE UNIQUE INDEX ItemTable_key ON ItemTable(key)');
  } finally {
    db.close();
  }
}

/**
 * Merge composer.composerHeaders from backup global DB into local global DB.
 * This is the Cursor 3.0 sidebar session index stored in the global ItemTable.
 * Returns the number of header entries added.
 */
function mergeComposerHeaders(
  backupGlobalDbPath: string,
  localGlobalDbPath: string,
  allowedSessionIds: Set<string>
): number {
  const localDb = registry.openSync(localGlobalDbPath, { readonly: false });
  try {
    const localRow = localDb
      .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'")
      .get() as { value: string } | undefined;

    const localData = localRow
      ? (JSON.parse(localRow.value) as { allComposers?: Array<Record<string, unknown>> })
      : { allComposers: [] };
    const localHeaders = localData.allComposers ?? [];
    const localIds = new Set(localHeaders.map((h) => h['composerId'] as string).filter(Boolean));

    const backupDb = registry.openSync(backupGlobalDbPath, { readonly: true });
    let backupHeaders: Array<Record<string, unknown>> = [];
    try {
      const backupRow = backupDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'")
        .get() as { value: string } | undefined;

      if (backupRow) {
        const backupData = JSON.parse(backupRow.value) as {
          allComposers?: Array<Record<string, unknown>>;
        };
        backupHeaders = backupData.allComposers ?? [];
      }
    } finally {
      backupDb.close();
    }

    let added = 0;
    for (const header of backupHeaders) {
      const id = header['composerId'] as string;
      if (id && allowedSessionIds.has(id) && localIds.has(id) === false) {
        localHeaders.push(header);
        localIds.add(id);
        added++;
      }
    }

    if (added === 0) return 0;

    const merged = JSON.stringify({ allComposers: localHeaders });
    if (localRow) {
      localDb
        .prepare("UPDATE ItemTable SET value = ? WHERE key = 'composer.composerHeaders'")
        .run(merged);
    } else {
      localDb
        .prepare("INSERT INTO ItemTable (key, value) VALUES ('composer.composerHeaders', ?)")
        .run(merged);
    }

    try {
      localDb.runSQL('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* best-effort */
    }
    return added;
  } finally {
    localDb.close();
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
  const since = config?.since;
  let backupScope: BackupScope = since
    ? { type: 'filtered', since: since.toISOString() }
    : { type: 'full' };

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // T016: Check if output file exists
  if (existsSync(outputPath) && !force) {
    return {
      success: false,
      backupPath: outputPath,
      manifest: createManifest(
        [],
        { totalSize: 0, sessionCount: 0, workspaceCount: 0 },
        backupScope
      ),
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
      manifest: createManifest(
        [],
        { totalSize: 0, sessionCount: 0, workspaceCount: 0 },
        backupScope
      ),
      durationMs: Date.now() - startTime,
      error: `No Cursor data found at: ${sourcePath}`,
    };
  }

  // Date-filtered backup: determine which session IDs and workspaces to include
  let filteredIds: Set<string> | undefined;
  const includedWorkspaceIds = new Set<string>();

  if (since) {
    await registry.ensureDriver();
    filteredIds = getFilteredSessionIds(sourcePath, since);
    if (filteredIds.size === 0) {
      return {
        success: false,
        backupPath: outputPath,
        manifest: createManifest(
          [],
          { totalSize: 0, sessionCount: 0, workspaceCount: 0 },
          backupScope
        ),
        durationMs: Date.now() - startTime,
        error: `No sessions found updated since ${since.toISOString()}`,
      };
    }
    backupScope = {
      type: 'filtered',
      since: since.toISOString(),
      sessionIds: [...filteredIds].sort(),
    };
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
      manifest: createManifest(
        [],
        { totalSize: 0, sessionCount: 0, workspaceCount: 0 },
        backupScope
      ),
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

      // Compute checksum and file size using streaming (handles > 2GB)
      const fileSize = statSync(tempFilePath).size;
      const checksum = await computeFileChecksum(tempFilePath);

      fileEntries.push({
        path: dbFile.relativePath,
        size: fileSize,
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

    // T014: Create zip file using streaming (supports files > 2GB via ZIP64)
    const manifest = createManifest(
      fileEntries,
      {
        totalSize: fileEntries.reduce((sum, f) => sum + f.size, 0),
        sessionCount,
        workspaceCount: workspaceIds.size,
      },
      backupScope
    );

    const zipFile = new yazl.ZipFile();

    for (const entry of fileEntries) {
      const filePath = join(tempDir, entry.path);
      const zipPath = entry.path.split(sep).join('/');
      zipFile.addFile(filePath, zipPath, { compress: false });
    }

    // Add manifest
    zipFile.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');

    // Phase: Finalizing
    onProgress?.({
      phase: 'finalizing',
      filesCompleted: dbFiles.length,
      totalFiles: dbFiles.length,
      bytesCompleted: totalBytes,
      totalBytes,
    });

    // Stream zip to output file
    if (existsSync(outputPath)) {
      unlinkSync(outputPath);
    }

    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(outputPath);
      output.on('close', resolve);
      output.on('error', reject);
      zipFile.outputStream.on('error', reject);
      zipFile.outputStream.pipe(output);
      zipFile.end();
    });

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
  const zip = await ZipReader.open(backupPath);

  if (!zip.file(dbPath)) {
    zip.close();
    throw new Error(`Database not found in backup: ${dbPath}`);
  }

  // Stream directly to temp file (handles entries > 2GB)
  const tempFile = join(
    tmpdir(),
    `cursor_history_backup_${Date.now()}_${Math.random().toString(36).slice(2)}.vscdb`
  );
  await zip.extractToFile(dbPath, tempFile);
  zip.close();

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
    const zip = await ZipReader.open(backupPath);
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) {
      zip.close();
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
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(backupPath);
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

    // Stream checksum to avoid buffering large files (>2GB)
    const actualChecksum = await zip.checksumEntry(fileEntry.path);
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

interface RestorePlanContext {
  plan: RestorePlan;
  backupSessionIds: Set<string>;
}

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  ino: number;
}

type BackupFingerprint = FileFingerprint;

function getFileFingerprint(filePath: string): FileFingerprint {
  const stat = statSync(filePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
}

function fingerprintsEqual(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino;
}

function getBackupFingerprint(backupPath: string): BackupFingerprint {
  return getFileFingerprint(backupPath);
}

function assertBackupUnchanged(backupPath: string, expected: BackupFingerprint): void {
  const current = getBackupFingerprint(backupPath);
  if (!fingerprintsEqual(current, expected)) {
    throw new Error('Backup archive changed after validation; refusing to restore');
  }
}

function workspaceUriToFsPath(uri: string): string {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, ''));
  } catch {
    return uri.replace(/^file:\/\//, '');
  }
}

async function readBackupWorkspacePath(
  zip: ZipReader,
  workspaceId: string
): Promise<string | null> {
  const file = zip.file(`workspaceStorage/${workspaceId}/workspace.json`);
  if (!file) return null;
  try {
    const buffer = await file.async('nodebuffer');
    const parsed = JSON.parse(buffer.toString('utf-8')) as {
      workspace?: string;
      folder?: string;
    };
    const uri = parsed.workspace ?? parsed.folder;
    return uri ? workspaceUriToFsPath(uri) : null;
  } catch {
    return null;
  }
}

async function readBackupSessionIds(
  backupPath: string,
  manifest: BackupManifest
): Promise<{ ids: Set<string>; warnings: string[] }> {
  await registry.ensureDriver();
  const warnings: string[] = [];
  const globalEntry = manifest.files.find((entry) => entry.type === 'global-db');
  const globalIds = new Set<string>();

  if (globalEntry) {
    const db = await openBackupDatabase(backupPath, globalEntry.path);
    try {
      for (const id of readGlobalSessionIdsFromDatabase(db, true)) {
        globalIds.add(id);
      }
    } finally {
      db.close();
    }
  }

  // Filtered backups intentionally contain full workspace metadata but only a
  // selected global session set. Manifest v1.1 records the exact set so
  // workspace-only legacy sessions are not lost.
  if (manifest.scope?.type === 'filtered') {
    for (const id of manifest.scope.sessionIds ?? []) {
      if (typeof id === 'string' && id.length > 0) globalIds.add(id);
    }
    if (!manifest.scope.sessionIds) {
      warnings.push(
        'Filtered backup does not declare its exact session set; workspace-only sessions may be unavailable'
      );
    }
    return { ids: globalIds, warnings };
  }

  // Archives created before manifest v1.1 do not declare whether they are
  // filtered. Prefer the global set to avoid importing out-of-scope workspace
  // metadata from an old filtered archive.
  if (!manifest.scope && globalIds.size > 0) {
    warnings.push(
      'Backup scope is unknown (pre-v1.1 manifest); using global session IDs as the import set'
    );
    return { ids: globalIds, warnings };
  }

  const ids = new Set(globalIds);
  for (const entry of manifest.files) {
    if (entry.type !== 'workspace-db') continue;
    const db = await openBackupDatabase(backupPath, entry.path);
    try {
      for (const id of readWorkspaceSessionIdsFromDatabase(db, true)) {
        ids.add(id);
      }
    } finally {
      db.close();
    }
  }
  return { ids, warnings };
}

function readLocalSessionIds(
  localGlobalDbPath: string,
  workspaceStorageDir: string
): { ids: Set<string>; errors: string[] } {
  const ids = new Set<string>();
  const errors: string[] = [];
  if (existsSync(localGlobalDbPath)) {
    try {
      const db = registry.openSync(localGlobalDbPath, { readonly: true });
      try {
        for (const id of readGlobalReferencedSessionIdsFromDatabase(db, true)) {
          ids.add(id);
        }
      } finally {
        db.close();
      }
    } catch (error) {
      errors.push(
        `${localGlobalDbPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!existsSync(workspaceStorageDir)) return { ids, errors };
  try {
    const entries = readdirSync(workspaceStorageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dbPath = join(workspaceStorageDir, entry.name, 'state.vscdb');
      if (!existsSync(dbPath)) continue;
      try {
        const db = registry.openSync(dbPath, { readonly: true });
        try {
          for (const id of readWorkspaceSessionIdsFromDatabase(db, true)) {
            ids.add(id);
          }
        } finally {
          db.close();
        }
      } catch (error) {
        errors.push(`${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch {
    // Best-effort; the target may not have workspace storage yet.
  }
  return { ids, errors };
}

function readLocalTranscriptSessionIds(candidateIds: Set<string>): {
  ids: Set<string>;
  errors: string[];
} {
  const ids = new Set<string>();
  const errors: string[] = [];
  const projectsDir = getCursorProjectsPath();
  if (!existsSync(projectsDir) || candidateIds.size === 0) return { ids, errors };

  try {
    const projects = readdirSync(projectsDir, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const transcriptDir = join(projectsDir, project.name, 'agent-transcripts');
      if (!existsSync(transcriptDir)) continue;
      try {
        const sessions = readdirSync(transcriptDir, { withFileTypes: true });
        for (const session of sessions) {
          if (session.isDirectory() && candidateIds.has(session.name)) {
            ids.add(session.name);
          }
        }
      } catch (error) {
        errors.push(`${transcriptDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    errors.push(`${projectsDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ids, errors };
}

function getRestoreDestination(userDir: string, archivePath: string): string {
  const platformPath = archivePath.split('/').join(sep);
  return archivePath.startsWith('projects/')
    ? join(homedir(), '.cursor', platformPath)
    : join(userDir, platformPath);
}

async function buildRestorePlan(
  config: RestoreConfig,
  manifest: BackupManifest,
  validation: BackupValidation,
  userDir: string,
  localGlobalDbPath: string,
  localWorkspaceStorageDir: string
): Promise<RestorePlanContext> {
  const mode: RestorePlan['mode'] = config.merge ? 'merge' : 'overwrite';
  const backupSelection = await readBackupSessionIds(config.backupPath, manifest);
  const backupSessionIds = backupSelection.ids;
  const localSelection = readLocalSessionIds(localGlobalDbPath, localWorkspaceStorageDir);
  const localSessionIds = localSelection.ids;
  const localTranscriptSelection = readLocalTranscriptSessionIds(backupSessionIds);
  for (const id of localTranscriptSelection.ids) localSessionIds.add(id);
  const conflictingSessionIds = [...backupSessionIds]
    .filter((id) => localSessionIds.has(id))
    .sort();
  const filesToCreate = new Set<string>();
  const filesToModify = new Set<string>();
  const filesToOverwrite = new Set<string>();
  const filesToSkip = new Set<string>();
  const warnings = [...backupSelection.warnings];
  const blockers: string[] = [];
  const archivedTranscriptSessions = new Set<string>();
  let workspacesNew = 0;
  let workspacesMerged = 0;
  let transcriptFilesToCopy = 0;

  if (config.merge && config.force) {
    blockers.push('Cannot use both merge and force restore modes');
  }
  if (validation.status === 'warnings') {
    blockers.push(
      `Backup has ${validation.corruptedFiles.length} checksum-mismatched file(s); restore will not proceed`
    );
  }
  const localScanErrors = [...localSelection.errors, ...localTranscriptSelection.errors];
  if (localScanErrors.length > 0) {
    blockers.push(
      `Could not verify that target sessions are disjoint: ${localScanErrors.join('; ')}`
    );
  }

  if (mode === 'overwrite') {
    for (const entry of manifest.files) {
      const destination = getRestoreDestination(userDir, entry.path);
      if (entry.type === 'transcript') {
        const match = entry.path.match(/^projects\/[^/]+\/agent-transcripts\/([^/]+)\//);
        if (match?.[1]) archivedTranscriptSessions.add(match[1]);
        transcriptFilesToCopy++;
      }
      if (existsSync(destination)) {
        filesToOverwrite.add(destination);
      } else {
        filesToCreate.add(destination);
      }
    }

    if (!config.force && filesToOverwrite.size > 0) {
      blockers.push(
        existsSync(localGlobalDbPath)
          ? `Target already has Cursor data: ${userDir}. Use --force to overwrite.`
          : `Target contains ${filesToOverwrite.size} file(s) that restore would overwrite. Use --force to overwrite.`
      );
    }
    if (manifest.scope?.type === 'filtered') {
      blockers.push(
        'A filtered backup cannot use overwrite restore because it contains a partial global database; use --merge'
      );
    } else if (config.force && !manifest.scope) {
      blockers.push(
        'A backup with unknown scope cannot be restored with --force; create a new full backup with manifest v1.1 or use --merge'
      );
    }
  } else {
    if (backupSessionIds.size === 0) {
      blockers.push('No importable session IDs were found in the backup');
    }
    if (conflictingSessionIds.length > 0) {
      blockers.push(
        `Merge requires disjoint sessions, but ${conflictingSessionIds.length} session ID(s) already exist in the target`
      );
    }

    const localPathMap = buildLocalWorkspaceMap(localWorkspaceStorageDir);
    const zip = await ZipReader.open(config.backupPath);
    try {
      const workspaceDbEntries = manifest.files.filter((entry) => entry.type === 'workspace-db');
      for (const entry of workspaceDbEntries) {
        const match = entry.path.match(/^workspaceStorage\/([^/]+)\/state\.vscdb$/);
        if (!match?.[1]) continue;
        const workspaceId = match[1];
        const backupWorkspacePath = await readBackupWorkspacePath(zip, workspaceId);
        const localHash = backupWorkspacePath
          ? localPathMap.get(normalizePath(backupWorkspacePath))
          : undefined;

        if (localHash) {
          const localDbPath = join(localWorkspaceStorageDir, localHash, 'state.vscdb');
          if (existsSync(localDbPath)) {
            filesToModify.add(localDbPath);
            workspacesMerged++;
          } else {
            blockers.push(
              `Workspace ${backupWorkspacePath ?? workspaceId} matched ${localHash}, but its local database is missing`
            );
          }
          const workspaceJson = join(localWorkspaceStorageDir, localHash, 'workspace.json');
          if (existsSync(workspaceJson)) filesToSkip.add(workspaceJson);
          continue;
        }

        const destinationFolder = join(localWorkspaceStorageDir, workspaceId);
        if (existsSync(destinationFolder)) {
          blockers.push(
            `Workspace folder collision: ${destinationFolder} exists but does not match the backup workspace path`
          );
          for (const file of manifest.files.filter((item) =>
            item.path.startsWith(`workspaceStorage/${workspaceId}/`)
          )) {
            filesToSkip.add(getRestoreDestination(userDir, file.path));
          }
          continue;
        }

        workspacesNew++;
        for (const file of manifest.files.filter((item) =>
          item.path.startsWith(`workspaceStorage/${workspaceId}/`)
        )) {
          filesToCreate.add(getRestoreDestination(userDir, file.path));
        }
      }
    } finally {
      zip.close();
    }

    const globalEntry = manifest.files.find((entry) => entry.type === 'global-db');
    if (globalEntry) {
      if (existsSync(localGlobalDbPath)) {
        filesToModify.add(localGlobalDbPath);
      } else {
        filesToCreate.add(localGlobalDbPath);
      }
    }

    for (const entry of manifest.files) {
      if (entry.type !== 'transcript') continue;
      const match = entry.path.match(/^projects\/[^/]+\/agent-transcripts\/([^/]+)\//);
      const sessionId = match?.[1];
      if (!sessionId || !backupSessionIds.has(sessionId)) {
        filesToSkip.add(getRestoreDestination(userDir, entry.path));
        continue;
      }
      const destination = getRestoreDestination(userDir, entry.path);
      const destinationSessionDir = dirname(destination);
      if (existsSync(destinationSessionDir)) {
        filesToSkip.add(destination);
      } else {
        filesToCreate.add(destination);
        if (!archivedTranscriptSessions.has(sessionId)) {
          archivedTranscriptSessions.add(sessionId);
          transcriptFilesToCopy++;
        }
      }
    }
  }

  const sqliteTargets =
    mode === 'overwrite'
      ? [...filesToOverwrite].filter((path) => path.endsWith('state.vscdb'))
      : [...filesToModify].filter((path) => path.endsWith('state.vscdb'));
  const sidecars = sqliteTargets.flatMap((path) =>
    [`${path}-wal`, `${path}-shm`, `${path}-journal`].filter((candidate) => existsSync(candidate))
  );
  if (sidecars.length > 0) {
    warnings.push(
      `Found ${sidecars.length} SQLite WAL/SHM/journal sidecar file(s); fully quit Cursor before restore`
    );
    blockers.push(
      'Restore is blocked while SQLite sidecar files exist because concurrent or stale pages could invalidate conflict checks and rollback'
    );
  }

  if (manifest.files.some((entry) => entry.type === 'transcript')) {
    warnings.push(
      `Transcript files target ${join(homedir(), '.cursor', 'projects')} independently of --target`
    );
  }

  const backupScope = manifest.scope?.type ?? 'unknown';
  const sessionsWithTranscript = new Set([
    ...archivedTranscriptSessions,
    ...localTranscriptSelection.ids,
  ]);
  const transcriptCandidatesToSynthesize =
    config.synthesizeTranscripts === false
      ? 0
      : [...backupSessionIds].filter((id) => !sessionsWithTranscript.has(id)).length;
  const plan: RestorePlan = {
    mode,
    canApply: blockers.length === 0,
    backupScope,
    backupSessionCount: backupSessionIds.size,
    localSessionCount: localSessionIds.size,
    sessionsToAdd:
      mode === 'merge'
        ? Math.max(0, backupSessionIds.size - conflictingSessionIds.length)
        : backupSessionIds.size,
    conflictingSessionIds,
    workspacesNew,
    workspacesMerged,
    transcriptFilesToCopy,
    transcriptCandidatesToSynthesize,
    filesToCreate: [...filesToCreate].sort(),
    filesToModify: [...filesToModify].sort(),
    filesToOverwrite: [...filesToOverwrite].sort(),
    filesToSkip: [...filesToSkip].sort(),
    warnings,
    blockers,
  };

  return { plan, backupSessionIds };
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
  const dryRun = config.dryRun ?? false;
  const synthesizeTranscriptsEnabled = config.synthesizeTranscripts ?? true;
  const onProgress = config.onProgress;
  const initialFingerprint = existsSync(backupPath) ? getBackupFingerprint(backupPath) : null;

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

  let backupFingerprint: BackupFingerprint;
  try {
    backupFingerprint = getBackupFingerprint(backupPath);
    if (initialFingerprint) {
      assertBackupUnchanged(backupPath, initialFingerprint);
    }
  } catch (error) {
    return {
      success: false,
      targetPath,
      filesRestored: 0,
      warnings: [],
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const manifest = validation.manifest!;
  const userDir = dirname(targetPath);
  const localGlobalDbPath = join(userDir, 'globalStorage', 'state.vscdb');
  const localWorkspaceStorageDir = targetPath;

  let planContext: RestorePlanContext;
  try {
    planContext = await buildRestorePlan(
      { ...config, force, merge },
      manifest,
      validation,
      userDir,
      localGlobalDbPath,
      localWorkspaceStorageDir
    );
  } catch (e) {
    return {
      success: false,
      targetPath,
      filesRestored: 0,
      warnings: [],
      durationMs: Date.now() - startTime,
      error: `Restore preflight failed: ${e instanceof Error ? e.message : String(e)}`,
      ...(dryRun && { dryRun: true }),
    };
  }

  try {
    assertBackupUnchanged(backupPath, backupFingerprint);
  } catch (error) {
    return {
      success: false,
      targetPath,
      filesRestored: 0,
      warnings: planContext.plan.warnings,
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
      ...(dryRun && { dryRun: true }),
      plan: planContext.plan,
    };
  }

  if (dryRun) {
    return {
      success: planContext.plan.canApply,
      targetPath,
      filesRestored: 0,
      warnings: planContext.plan.warnings,
      durationMs: Date.now() - startTime,
      dryRun: true,
      plan: planContext.plan,
      ...(!planContext.plan.canApply && {
        error: planContext.plan.blockers.join('; '),
      }),
    };
  }

  if (!planContext.plan.canApply) {
    return {
      success: false,
      targetPath,
      filesRestored: 0,
      warnings: planContext.plan.warnings,
      durationMs: Date.now() - startTime,
      error: planContext.plan.blockers.join('; '),
      plan: planContext.plan,
    };
  }

  // --merge mode: merge backup into existing data
  if (merge) {
    return restoreBackupMerge(
      backupPath,
      targetPath,
      userDir,
      localGlobalDbPath,
      localWorkspaceStorageDir,
      manifest,
      validation,
      startTime,
      synthesizeTranscriptsEnabled,
      planContext.backupSessionIds,
      planContext.plan,
      backupFingerprint,
      onProgress
    );
  }

  onProgress?.({
    phase: 'validating',
    filesCompleted: 0,
    totalFiles: manifest.files.length,
    integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
    corruptedFiles: validation.corruptedFiles,
  });

  // Stage every archive entry before touching target data.
  mkdirSync(userDir, { recursive: true });
  const stageDir = join(userDir, `.restore_stage_${Date.now()}`);
  const rollbackDir = join(userDir, `.restore_rollback_${Date.now()}`);
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(rollbackDir, { recursive: true });
  const restoredFiles: string[] = [];
  const warnings: string[] = [...planContext.plan.warnings];
  const committed: Array<{
    destination: string;
    backup?: string;
    applied?: FileFingerprint;
  }> = [];
  let preserveRollback = false;

  try {
    assertBackupUnchanged(backupPath, backupFingerprint);
    const zip = await ZipReader.open(backupPath);
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

        if (!zip.file(fileEntry.path)) {
          throw new Error(`Archive entry disappeared after validation: ${fileEntry.path}`);
        }
        const stagedPath = join(stageDir, fileEntry.path.split('/').join(sep));
        mkdirSync(dirname(stagedPath), { recursive: true });
        await zip.extractToFile(fileEntry.path, stagedPath);
      }
    } finally {
      zip.close();
    }
    assertBackupUnchanged(backupPath, backupFingerprint);

    // Give progress callbacks their last chance to fail while targets are intact.
    onProgress?.({
      phase: 'finalizing',
      filesCompleted: manifest.files.length,
      totalFiles: manifest.files.length,
      integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
    });

    for (let i = 0; i < manifest.files.length; i++) {
      const fileEntry = manifest.files[i]!;
      const stagedPath = join(stageDir, fileEntry.path.split('/').join(sep));
      const destination = getRestoreDestination(userDir, fileEntry.path);
      const journalEntry: {
        destination: string;
        backup?: string;
        applied?: FileFingerprint;
      } = { destination };
      mkdirSync(dirname(destination), { recursive: true });

      if (existsSync(destination)) {
        if (!force && !planContext.plan.filesToOverwrite.includes(destination)) {
          throw new Error(
            `Target appeared after preflight and --force was not provided: ${destination}`
          );
        }
        const beforeSnapshot = getFileFingerprint(destination);
        const backup = join(rollbackDir, String(i));
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(destination, backup);
        if (!fingerprintsEqual(beforeSnapshot, getFileFingerprint(destination))) {
          throw new Error(`Target changed while preparing restore: ${destination}`);
        }
        journalEntry.backup = backup;
        committed.push(journalEntry);
        copyFileSync(stagedPath, destination);
        journalEntry.applied = getFileFingerprint(destination);
      } else {
        try {
          copyFileSync(stagedPath, destination, fsConstants.COPYFILE_EXCL);
          committed.push(journalEntry);
          journalEntry.applied = getFileFingerprint(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && existsSync(destination)) {
            rmSync(destination, { force: true });
          }
          throw error;
        }
      }
      restoredFiles.push(fileEntry.path);
    }

    // Synthesize agent transcripts for restored sessions that lack them, so
    // they are taggable/continuable in Cursor on this machine.
    let transcriptsSynthesized = 0;
    if (synthesizeTranscriptsEnabled && existsSync(localGlobalDbPath)) {
      try {
        const synthStats = await synthesizeMissingTranscripts({
          globalDbPath: localGlobalDbPath,
          workspaceStorageDir: localWorkspaceStorageDir,
        });
        transcriptsSynthesized = synthStats.created;
        for (const err of synthStats.errors.slice(0, 5)) {
          warnings.push(`Transcript synthesis: ${err}`);
        }
      } catch (e) {
        warnings.push(`Transcript synthesis failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return {
      success: true,
      targetPath,
      filesRestored: restoredFiles.length,
      warnings,
      durationMs: Date.now() - startTime,
      ...(transcriptsSynthesized > 0 && { transcriptsSynthesized }),
    };
  } catch (e) {
    for (const entry of committed.reverse()) {
      try {
        if (
          entry.applied &&
          existsSync(entry.destination) &&
          !fingerprintsEqual(entry.applied, getFileFingerprint(entry.destination))
        ) {
          preserveRollback = true;
          warnings.push(
            `Rollback did not overwrite a concurrently changed target: ${entry.destination}`
          );
          continue;
        }
        if (entry.backup) {
          copyFileSync(entry.backup, entry.destination);
        } else if (existsSync(entry.destination)) {
          unlinkSync(entry.destination);
        }
      } catch {
        preserveRollback = true;
        warnings.push(`Rollback failed for ${entry.destination}`);
      }
    }
    if (preserveRollback) {
      warnings.push(`Rollback recovery files were preserved at ${rollbackDir}`);
    }

    return {
      success: false,
      targetPath,
      filesRestored: 0,
      warnings,
      durationMs: Date.now() - startTime,
      error: `Restore failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
    if (!preserveRollback) {
      rmSync(rollbackDir, { recursive: true, force: true });
    }
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
  synthesizeTranscriptsEnabled: boolean,
  allowedSessionIds: Set<string>,
  plan: RestorePlan,
  backupFingerprint: BackupFingerprint,
  onProgress?: (progress: import('./types.js').RestoreProgress) => void
): Promise<RestoreResult> {
  const warnings: string[] = [...plan.warnings];
  const stats: MergeStats = {
    sessionsAdded: 0,
    sessionsUpdated: 0,
    workspacesNew: 0,
    workspacesMerged: 0,
    globalRowsAdded: 0,
    sidebarHeadersAdded: 0,
    transcriptsSynthesized: 0,
  };

  // Extract backup to temp directory
  const tempDir = join(userDir, `.merge_temp_${Date.now()}`);
  const rollbackDir = join(tempDir, '__rollback__');
  const snapshots: Array<{
    target: string;
    backup: string;
    original: FileFingerprint;
  }> = [];
  const createdTargets = new Set<string>();
  const createdDirectories = new Set<string>();
  const appliedFingerprints = new Map<string, FileFingerprint>();
  const mutationAttemptedTargets = new Set<string>();
  let mutationStarted = false;
  let preserveRollback = false;
  mkdirSync(tempDir, { recursive: true });

  try {
    await registry.ensureDriver();
    assertBackupUnchanged(backupPath, backupFingerprint);

    onProgress?.({
      phase: 'extracting',
      filesCompleted: 0,
      totalFiles: manifest.files.length,
      integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
      corruptedFiles: validation.corruptedFiles,
    });

    // Extract all files from backup to temp
    const zip = await ZipReader.open(backupPath);
    try {
      for (let i = 0; i < manifest.files.length; i++) {
        const fileEntry = manifest.files[i]!;
        if (!zip.file(fileEntry.path)) {
          throw new Error(`Archive entry disappeared after validation: ${fileEntry.path}`);
        }

        const platformPath = fileEntry.path.split('/').join(sep);
        const destPath = join(tempDir, platformPath);
        mkdirSync(dirname(destPath), { recursive: true });
        await zip.extractToFile(fileEntry.path, destPath);

        onProgress?.({
          phase: 'extracting',
          currentFile: fileEntry.path,
          filesCompleted: i + 1,
          totalFiles: manifest.files.length,
          integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
          corruptedFiles: validation.corruptedFiles,
        });
      }
    } finally {
      zip.close();
    }
    assertBackupUnchanged(backupPath, backupFingerprint);

    for (const target of plan.filesToCreate) {
      if (existsSync(target)) {
        throw new Error(`Target appeared after preflight: ${target}`);
      }
    }
    mkdirSync(rollbackDir, { recursive: true });
    for (let i = 0; i < plan.filesToModify.length; i++) {
      const target = plan.filesToModify[i]!;
      if (!existsSync(target)) {
        throw new Error(`Target disappeared after preflight: ${target}`);
      }
      const backup = join(rollbackDir, String(i));
      mkdirSync(dirname(backup), { recursive: true });
      const beforeSnapshot = getFileFingerprint(target);
      if (target.endsWith('state.vscdb')) {
        await backupDatabase(target, backup);
      } else {
        copyFileSync(target, backup);
      }
      if (!fingerprintsEqual(beforeSnapshot, getFileFingerprint(target))) {
        throw new Error(`Target changed while preparing merge: ${target}`);
      }
      snapshots.push({ target, backup, original: beforeSnapshot });
    }
    mutationStarted = true;

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
            mutationAttemptedTargets.add(localDbPath);
            const result = mergeWorkspaceDb(backupDbPath, localDbPath, allowedSessionIds);
            stats.sessionsAdded += result.added;
            stats.sessionsUpdated += result.updated;
            stats.workspacesMerged++;
            appliedFingerprints.set(localDbPath, getFileFingerprint(localDbPath));
          } else {
            throw new Error(`Matched workspace database disappeared: ${localDbPath}`);
          }
        } else {
          // Path not found locally: copy entire workspace folder
          const destFolder = join(localWorkspaceStorageDir, entry.name);
          if (!existsSync(destFolder)) {
            mkdirSync(dirname(destFolder), { recursive: true });
            mkdirSync(destFolder);
            createdDirectories.add(destFolder);
            // Copy all files from backup workspace folder
            const wsFiles = readdirSync(backupWsFolder);
            for (const wsFile of wsFiles) {
              const src = join(backupWsFolder, wsFile);
              const dst = join(destFolder, wsFile);
              copyFileSync(src, dst, fsConstants.COPYFILE_EXCL);
              createdTargets.add(dst);
              appliedFingerprints.set(dst, getFileFingerprint(dst));
            }
            if (manifest.scope?.type !== 'full' && existsSync(join(destFolder, 'state.vscdb'))) {
              filterWorkspaceDbToSessionIds(join(destFolder, 'state.vscdb'), allowedSessionIds);
              appliedFingerprints.set(
                join(destFolder, 'state.vscdb'),
                getFileFingerprint(join(destFolder, 'state.vscdb'))
              );
            }
            // Count sessions in the newly copied workspace
            if (existsSync(join(destFolder, 'state.vscdb'))) {
              stats.sessionsAdded += countSessions(join(destFolder, 'state.vscdb'));
            }
            stats.workspacesNew++;
          } else {
            throw new Error(
              `Workspace folder appeared after preflight and cannot be merged safely: ${destFolder}`
            );
          }
        }
      }
    }

    // Merge global database
    const backupGlobalDbPath = join(tempDir, 'globalStorage', 'state.vscdb');
    if (existsSync(backupGlobalDbPath) && existsSync(localGlobalDbPath)) {
      mutationAttemptedTargets.add(localGlobalDbPath);
      stats.globalRowsAdded = mergeGlobalDb(
        backupGlobalDbPath,
        localGlobalDbPath,
        allowedSessionIds
      );
      appliedFingerprints.set(localGlobalDbPath, getFileFingerprint(localGlobalDbPath));
    } else if (existsSync(backupGlobalDbPath) && !existsSync(localGlobalDbPath)) {
      // Create a chat-only target DB rather than copying machine-specific state.
      mkdirSync(dirname(localGlobalDbPath), { recursive: true });
      writeFileSync(localGlobalDbPath, '', { flag: 'wx' });
      createdTargets.add(localGlobalDbPath);
      initializeEmptyRestoreGlobalDb(localGlobalDbPath);
      stats.globalRowsAdded = mergeGlobalDb(
        backupGlobalDbPath,
        localGlobalDbPath,
        allowedSessionIds
      );
      appliedFingerprints.set(localGlobalDbPath, getFileFingerprint(localGlobalDbPath));
    }

    // Merge composer.composerHeaders in global ItemTable (Cursor 3.0 sidebar index)
    if (existsSync(localGlobalDbPath) && existsSync(backupGlobalDbPath)) {
      mutationAttemptedTargets.add(localGlobalDbPath);
      stats.sidebarHeadersAdded = mergeComposerHeaders(
        backupGlobalDbPath,
        localGlobalDbPath,
        allowedSessionIds
      );
      appliedFingerprints.set(localGlobalDbPath, getFileFingerprint(localGlobalDbPath));
    }

    // Copy agent transcript JSONL files to ~/.cursor/projects/
    const backupProjectsDir = join(tempDir, 'projects');
    if (existsSync(backupProjectsDir)) {
      const localProjectsDir = getCursorProjectsPath();
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
            if (!allowedSessionIds.has(sessionDir.name)) continue;
            const destSessionDir = join(localTranscriptsDir, sessionDir.name);
            if (existsSync(destSessionDir)) {
              throw new Error(
                `Transcript session appeared after preflight and cannot be merged safely: ${destSessionDir}`
              );
            }

            mkdirSync(localTranscriptsDir, { recursive: true });
            mkdirSync(destSessionDir);
            createdDirectories.add(destSessionDir);
            const backupFiles = readdirSync(join(backupTranscriptsDir, sessionDir.name));
            for (const f of backupFiles) {
              const destination = join(destSessionDir, f);
              copyFileSync(
                join(backupTranscriptsDir, sessionDir.name, f),
                destination,
                fsConstants.COPYFILE_EXCL
              );
              createdTargets.add(destination);
              appliedFingerprints.set(destination, getFileFingerprint(destination));
            }
          }
        }
      } catch (transcriptError) {
        throw new Error(
          `Transcript restore failed: ${
            transcriptError instanceof Error ? transcriptError.message : String(transcriptError)
          }`
        );
      }
    }

    onProgress?.({
      phase: 'finalizing',
      filesCompleted: manifest.files.length,
      totalFiles: manifest.files.length,
      integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
    });

    // Synthesize agent transcripts for merged sessions that still lack one.
    // Without the JSONL file Cursor can neither tag the chat as past-chat
    // context nor resume it with the unified agent backend.
    if (
      synthesizeTranscriptsEnabled &&
      existsSync(backupGlobalDbPath) &&
      existsSync(localGlobalDbPath)
    ) {
      try {
        if (allowedSessionIds.size > 0) {
          const synthStats = await synthesizeMissingTranscripts({
            globalDbPath: localGlobalDbPath,
            workspaceStorageDir: localWorkspaceStorageDir,
            sessionIds: allowedSessionIds,
          });
          stats.transcriptsSynthesized = synthStats.created;
          for (const err of synthStats.errors.slice(0, 5)) {
            warnings.push(`Transcript synthesis: ${err}`);
          }
        }
      } catch (e) {
        warnings.push(`Transcript synthesis failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Preflight guarantees the selected IDs are disjoint. Report imported
    // sessions once rather than double-counting workspace and transcript work.
    stats.sessionsAdded = allowedSessionIds.size;
    stats.sessionsUpdated = 0;

    return {
      success: true,
      targetPath,
      filesRestored:
        stats.workspacesNew +
        stats.workspacesMerged +
        (existsSync(join(tempDir, 'globalStorage', 'state.vscdb')) ? 1 : 0),
      warnings,
      durationMs: Date.now() - startTime,
      mergeStats: stats,
    };
  } catch (e) {
    if (mutationStarted) {
      for (const target of [...createdTargets].reverse()) {
        try {
          const applied = appliedFingerprints.get(target);
          if (
            applied &&
            existsSync(target) &&
            !fingerprintsEqual(applied, getFileFingerprint(target))
          ) {
            preserveRollback = true;
            warnings.push(`Rollback did not delete a concurrently changed target: ${target}`);
            continue;
          }
          rmSync(target, { force: true });
          rmSync(`${target}-wal`, { force: true });
          rmSync(`${target}-shm`, { force: true });
          rmSync(`${target}-journal`, { force: true });
        } catch {
          preserveRollback = true;
          warnings.push(`Rollback failed to remove ${target}`);
        }
      }
      for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
        try {
          if (existsSync(directory)) rmdirSync(directory);
        } catch {
          preserveRollback = true;
          warnings.push(`Rollback preserved non-empty or changed directory ${directory}`);
        }
      }
      for (const snapshot of [...snapshots].reverse()) {
        if (!mutationAttemptedTargets.has(snapshot.target)) continue;
        const applied = appliedFingerprints.get(snapshot.target);
        try {
          if (existsSync(snapshot.target)) {
            const current = getFileFingerprint(snapshot.target);
            if (applied && !fingerprintsEqual(applied, current)) {
              preserveRollback = true;
              warnings.push(
                `Rollback did not overwrite a concurrently changed target: ${snapshot.target}`
              );
              continue;
            }
            if (!applied && fingerprintsEqual(snapshot.original, current)) {
              continue;
            }
          }
          rmSync(`${snapshot.target}-wal`, { force: true });
          rmSync(`${snapshot.target}-shm`, { force: true });
          rmSync(`${snapshot.target}-journal`, { force: true });
          copyFileSync(snapshot.backup, snapshot.target);
        } catch {
          preserveRollback = true;
          warnings.push(`Rollback failed to restore ${snapshot.target}`);
        }
      }
    }
    if (preserveRollback) {
      warnings.push(`Rollback recovery files were preserved at ${rollbackDir}`);
    }
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
        try {
          rmdirSync(dir);
        } catch {
          /* ignore */
        }
      };
      if (existsSync(tempDir) && !preserveRollback) {
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
