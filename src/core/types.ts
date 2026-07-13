/**
 * Type definitions for Cursor Chat History CLI
 * Maps Cursor's SQLite storage format to TypeScript types
 */

export type Platform = 'windows' | 'macos' | 'linux';
export type MessageRole = 'user' | 'assistant';

/**
 * Valid message type filter values for filtering displayed messages
 */
export type MessageType = 'user' | 'assistant' | 'tool' | 'thinking' | 'error';

/**
 * Array of all valid message types (for validation)
 */
export const MESSAGE_TYPES: readonly MessageType[] = [
  'user',
  'assistant',
  'tool',
  'thinking',
  'error',
] as const;

/**
 * Root storage location containing all workspace data
 */
export interface CursorDataStore {
  basePath: string;
  platform: Platform;
}

/**
 * A directory/project that was open in Cursor
 * Maps to a state.vscdb file
 */
export interface Workspace {
  id: string;
  path: string;
  dbPath: string;
  sessionCount: number;
  /** True when workspace composer data has been migrated to global storage */
  migrated?: boolean;
}

/**
 * A single conversation with the AI assistant within a workspace
 */
export interface ChatSession {
  id: string;
  index: number;
  title: string | null;
  createdAt: Date;
  lastUpdatedAt: Date;
  messageCount: number;
  messages: Message[];
  workspaceId: string;
  workspacePath?: string;
  /** Source data completeness: full global bubbles or degraded workspace fallback */
  source?: 'global' | 'workspace-fallback';
  /** Session-level token usage summary (optional, when available) */
  usage?: SessionUsage;
  /** Ordered bubble IDs of the current active conversation branch */
  activeBranchBubbleIds?: string[];
}

/**
 * A single exchange within a chat session
 */
export interface Message {
  id: string | null;
  role: MessageRole;
  content: string;
  timestamp: Date;
  codeBlocks: CodeBlock[];
  /** Tool calls executed by assistant (optional, assistant-only) */
  toolCalls?: ToolCall[];
  /** AI reasoning/thinking text (optional, assistant-only) */
  thinking?: string;
  /** Token usage for this message (optional, when available from bubble data) */
  tokenUsage?: TokenUsage;
  /** AI model name used for this message (optional, assistant-only) */
  model?: string;
  /** Response duration in milliseconds (optional, assistant-only) */
  durationMs?: number;
  /** Metadata about message processing (optional) */
  metadata?: {
    /** Whether message data was partially corrupted */
    corrupted?: boolean;
    /** Original bubble type from database (for debugging) */
    bubbleType?: number;
  };
}

/**
 * Embedded code within a message, extracted from markdown fenced code blocks
 */
export interface CodeBlock {
  language: string | null;
  content: string;
  startLine: number;
}

/**
 * A tool/function call executed by the assistant
 */
export interface ToolCall {
  /** Tool/function name (e.g., 'read_file', 'write', 'grep') */
  name: string;
  /** Tool execution status */
  status: 'completed' | 'cancelled' | 'error';
  /** Tool parameters as JSON object (optional) */
  params?: Record<string, unknown>;
  /** Tool execution result (optional, present if status === 'completed') */
  result?: string;
  /** Error message (optional, present if status === 'error') */
  error?: string;
  /** File paths involved in this tool call (optional) */
  files?: string[];
}

/**
 * Lightweight session summary for list operations (without full messages)
 */
export interface ChatSessionSummary {
  id: string;
  index: number;
  title: string | null;
  createdAt: Date;
  lastUpdatedAt: Date;
  messageCount: number;
  workspaceId: string;
  workspacePath: string;
  preview: string;
}

/**
 * Search result with match snippets
 */
export interface SearchResult {
  sessionId: string;
  index: number;
  workspacePath: string;
  createdAt: Date;
  matchCount: number;
  snippets: SearchSnippet[];
}

/**
 * A snippet from a search result with context
 */
export interface SearchSnippet {
  messageRole: MessageRole;
  text: string;
  matchPositions: [number, number][];
}

/**
 * Options for list operations
 */
export interface ListOptions {
  limit: number;
  all: boolean;
  workspacePath?: string;
}

/**
 * Options for search operations
 */
export interface SearchOptions {
  limit: number;
  contextChars: number;
  workspacePath?: string;
}

/**
 * Options for export operations
 */
export interface ExportOptions {
  format: 'md' | 'json';
  outputPath?: string;
  force: boolean;
}

// ============================================================================
// Migration Types
// ============================================================================

/**
 * Migration mode: move removes from source, copy keeps source intact
 */
export type MigrationMode = 'move' | 'copy';

/**
 * Options for migrating one or more sessions
 */
export interface MigrateSessionOptions {
  /** Session ID(s) to migrate (resolved from index or UUID) */
  sessionIds: string[];
  /** Destination workspace path */
  destination: string;
  /** Migration mode: 'move' (default) or 'copy' */
  mode: MigrationMode;
  /** If true, preview without making changes */
  dryRun: boolean;
  /** If true, proceed even if destination has existing history */
  force: boolean;
  /** Custom Cursor data path (optional) */
  dataPath?: string;
  /** If true, log detailed path transformation info to stderr */
  debug?: boolean;
}

/**
 * Options for migrating all sessions from a workspace
 */
export interface MigrateWorkspaceOptions {
  /** Source workspace path */
  source: string;
  /** Destination workspace path */
  destination: string;
  /** Migration mode: 'move' (default) or 'copy' */
  mode: MigrationMode;
  /** If true, preview without making changes */
  dryRun: boolean;
  /** If true, proceed even if destination has existing history */
  force: boolean;
  /** Custom Cursor data path (optional) */
  dataPath?: string;
  /** If true, log detailed path transformation info to stderr */
  debug?: boolean;
}

/**
 * Result of migrating a single session
 */
export interface SessionMigrationResult {
  /** Whether migration succeeded */
  success: boolean;
  /** Original session ID */
  sessionId: string;
  /** Source workspace path */
  sourceWorkspace: string;
  /** Destination workspace path */
  destinationWorkspace: string;
  /** Mode used for migration */
  mode: MigrationMode;
  /** For copy mode: the new session ID created */
  newSessionId?: string;
  /** Error message if success is false */
  error?: string;
  /** Whether this was a dry run */
  dryRun: boolean;
  /** Indicates file paths in session data will be updated (dry run preview) */
  pathsWillBeUpdated?: boolean;
}

/**
 * Aggregate result of workspace migration
 */
export interface WorkspaceMigrationResult {
  /** True if all sessions migrated successfully */
  success: boolean;
  /** Normalized source path */
  source: string;
  /** Normalized destination path */
  destination: string;
  /** Mode used for migration */
  mode: MigrationMode;
  /** Total number of sessions attempted */
  totalSessions: number;
  /** Number of successful migrations */
  successCount: number;
  /** Number of failed migrations */
  failureCount: number;
  /** Per-session results */
  results: SessionMigrationResult[];
  /** Whether this was a dry run */
  dryRun: boolean;
}

// ============================================================================
// Backup Types
// ============================================================================

/**
 * Metadata stored in the manifest.json file within the backup zip
 */
export interface BackupManifest {
  /** Manifest schema version for backward compatibility */
  version: string;
  /** ISO 8601 timestamp when backup was created */
  createdAt: string;
  /** Platform where backup was created */
  sourcePlatform: 'darwin' | 'win32' | 'linux';
  /** cursor-history version that created the backup */
  cursorHistoryVersion: string;
  /** List of files in the backup with metadata */
  files: BackupFileEntry[];
  /** Aggregate statistics for quick display */
  stats: BackupStats;
  /** Backup scope (absent on archives created before manifest v1.1) */
  scope?: BackupScope;
}

/**
 * Whether an archive contains the full data set or a date-filtered subset.
 */
export interface BackupScope {
  type: 'full' | 'filtered';
  /** Inclusive cutoff used for a filtered backup */
  since?: string;
  /** Exact session import set for filtered backups */
  sessionIds?: string[];
}

/**
 * A single file entry in the backup manifest
 */
export interface BackupFileEntry {
  /** Path within zip (forward slashes, relative to zip root) */
  path: string;
  /** Original file size in bytes */
  size: number;
  /** SHA-256 checksum for integrity verification */
  checksum: string;
  /** File type for categorization */
  type: 'global-db' | 'workspace-db' | 'workspace-json' | 'manifest' | 'transcript';
}

/**
 * Aggregate statistics for a backup
 */
export interface BackupStats {
  /** Total uncompressed size of all files */
  totalSize: number;
  /** Number of chat sessions across all workspaces */
  sessionCount: number;
  /** Number of workspaces included */
  workspaceCount: number;
}

/**
 * Configuration for backup creation operation
 */
export interface BackupConfig {
  /** Source Cursor data path (default: platform-specific) */
  sourcePath?: string;
  /** Output file path (default: ~/cursor-history-backups/<timestamp>.zip) */
  outputPath?: string;
  /** Overwrite existing file without prompting */
  force?: boolean;
  /** Only include sessions updated on or after this date */
  since?: Date;
  /** Progress callback for UI updates */
  onProgress?: (progress: BackupProgress) => void;
}

/**
 * Progress information during backup operation
 */
export interface BackupProgress {
  /** Current operation phase */
  phase: 'scanning' | 'backing-up' | 'compressing' | 'finalizing';
  /** Current file being processed */
  currentFile?: string;
  /** Files completed / total files */
  filesCompleted: number;
  totalFiles: number;
  /** Bytes completed / total bytes */
  bytesCompleted: number;
  totalBytes: number;
}

/**
 * Result of a backup operation
 */
export interface BackupResult {
  /** Whether backup succeeded */
  success: boolean;
  /** Path to created backup file */
  backupPath: string;
  /** Generated manifest */
  manifest: BackupManifest;
  /** Duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Configuration for restore operation
 */
export interface RestoreConfig {
  /** Path to backup zip file */
  backupPath: string;
  /** Target Cursor data path (default: platform-specific) */
  targetPath?: string;
  /** Overwrite existing data without prompting */
  force?: boolean;
  /** Merge backup into existing data instead of overwriting */
  merge?: boolean;
  /** Preview the restore without modifying target data */
  dryRun?: boolean;
  /**
   * Synthesize missing agent transcript JSONL files from bubble data after
   * restore, so restored sessions are taggable/continuable (default: true)
   */
  synthesizeTranscripts?: boolean;
  /** Progress callback for UI updates */
  onProgress?: (progress: RestoreProgress) => void;
}

/**
 * Progress information during restore operation
 */
export interface RestoreProgress {
  /** Current operation phase */
  phase: 'validating' | 'extracting' | 'finalizing';
  /** Current file being processed */
  currentFile?: string;
  /** Files completed / total files */
  filesCompleted: number;
  totalFiles: number;
  /** Integrity status */
  integrityStatus: 'pending' | 'passed' | 'warnings' | 'failed';
  /** Files with checksum warnings (if any) */
  corruptedFiles?: string[];
}

/**
 * Result of a restore operation
 */
export interface MergeStats {
  /** Sessions added from backup */
  sessionsAdded: number;
  /** Existing sessions updated (always 0 for additive merge) */
  sessionsUpdated: number;
  /** New workspace folders copied */
  workspacesNew: number;
  /** Existing workspace DBs merged */
  workspacesMerged: number;
  /** Rows added to global cursorDiskKV */
  globalRowsAdded: number;
  /** Sidebar index entries added (composer.composerHeaders) */
  sidebarHeadersAdded: number;
  /** Agent transcript files synthesized from bubble data */
  transcriptsSynthesized: number;
}

/**
 * Read-only preflight describing exactly what a restore would attempt.
 */
export interface RestorePlan {
  /** Restore behavior being previewed */
  mode: 'overwrite' | 'merge';
  /** Whether the restore can proceed under the requested options */
  canApply: boolean;
  /** Scope declared by the archive manifest */
  backupScope: 'full' | 'filtered' | 'unknown';
  /** Sessions selected for import from the backup */
  backupSessionCount: number;
  /** Sessions currently present in the target */
  localSessionCount: number;
  /** Sessions that would be added */
  sessionsToAdd: number;
  /** Session IDs present in both backup and target */
  conflictingSessionIds: string[];
  /** New workspace folders that would be created */
  workspacesNew: number;
  /** Existing workspace databases that would be modified */
  workspacesMerged: number;
  /** Archived transcript files that would be copied */
  transcriptFilesToCopy: number;
  /** Missing transcript candidates that synthesis would examine */
  transcriptCandidatesToSynthesize: number;
  /** Destination files that would be created */
  filesToCreate: string[];
  /** Existing destination files that would be modified through a merge */
  filesToModify: string[];
  /** Existing destination files that would be replaced in overwrite mode */
  filesToOverwrite: string[];
  /** Archive files that would be skipped */
  filesToSkip: string[];
  /** Non-fatal preflight observations */
  warnings: string[];
  /** Conditions that prevent the requested restore */
  blockers: string[];
}

export interface RestoreResult {
  /** Whether restore succeeded */
  success: boolean;
  /** Path where data was restored */
  targetPath: string;
  /** Number of files restored */
  filesRestored: number;
  /** Files with integrity warnings (still restored) */
  warnings: string[];
  /** Duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Stats when merge mode is used */
  mergeStats?: MergeStats;
  /** Agent transcript files synthesized from bubble data (overwrite mode) */
  transcriptsSynthesized?: number;
  /** Whether this result came from a read-only dry run */
  dryRun?: boolean;
  /** Restore preflight (returned for dry runs and blocked restores) */
  plan?: RestorePlan;
}

/**
 * Result of backup integrity validation
 */
export interface BackupValidation {
  /** Overall validation status */
  status: 'valid' | 'warnings' | 'invalid';
  /** Manifest if parseable */
  manifest?: BackupManifest;
  /** Files that passed checksum verification */
  validFiles: string[];
  /** Files that failed checksum verification */
  corruptedFiles: string[];
  /** Files missing from manifest */
  missingFiles: string[];
  /** Detailed error messages */
  errors: string[];
}

/**
 * Metadata about a backup file for listing purposes
 */
export interface BackupInfo {
  /** Full path to the backup file */
  filePath: string;
  /** Backup filename */
  filename: string;
  /** File size in bytes */
  fileSize: number;
  /** File modification time (from filesystem) */
  modifiedAt: Date;
  /** Parsed manifest (if valid backup) */
  manifest?: BackupManifest;
  /** Error if backup is invalid or corrupted */
  error?: string;
}

// ============================================================================
// Token Usage Types
// ============================================================================

/**
 * Token usage for a single message (input/output tokens consumed)
 */
export interface TokenUsage {
  /** Number of input tokens (prompt tokens) */
  inputTokens: number;
  /** Number of output tokens (completion tokens) */
  outputTokens: number;
}

/**
 * Session-level usage summary (aggregated from messages and composer data)
 */
export interface SessionUsage {
  /** Context tokens used (from composer data) */
  contextTokensUsed?: number;
  /** Context token limit (from composer data) */
  contextTokenLimit?: number;
  /** Context usage percentage (may be int or float, normalize to float) */
  contextUsagePercent?: number;
  /** Total input tokens across all messages */
  totalInputTokens?: number;
  /** Total output tokens across all messages */
  totalOutputTokens?: number;
}

/**
 * Context window status at message creation time
 */
export interface ContextWindowStatus {
  /** Number of tokens used in context window */
  tokensUsed: number;
  /** Maximum token limit for context window */
  tokenLimit: number;
  /** Percentage of context window remaining (0-100) */
  percentageRemaining: number;
}
