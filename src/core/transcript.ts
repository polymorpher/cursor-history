/**
 * Agent transcript synthesis
 *
 * Cursor 3.x stores each agent conversation as a JSONL transcript at
 * ~/.cursor/projects/<project-slug>/agent-transcripts/<composerId>/<composerId>.jsonl
 *
 * These files are what make a chat:
 * - taggable as "past chat" context in a new agent chat (the @-mention menu
 *   only lists files whose path contains /agent-transcripts/ and ends with
 *   .jsonl or .txt)
 * - resumable by the unified agent backend (the transcript is the agent's
 *   conversation log)
 *
 * Sessions restored from a backup often have composerData + bubbles in the
 * global DB but no transcript file (the source machine never wrote one, or the
 * filtered backup didn't include it). This module reconstructs a best-effort
 * transcript from bubble data so restored sessions become taggable/continuable.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Import database/index.js for its side effect: it registers the SQLite
// drivers with the registry. Importing registry.js alone leaves it empty.
import './database/index.js';
import { registry } from './database/registry.js';
import { debugLogStorage } from './database/debug.js';

/**
 * Convert a workspace fsPath or file URI to the ~/.cursor/projects/ slug.
 * Mirrors Cursor's own slug function: every non-alphanumeric character becomes
 * '-', runs collapse to a single '-', and leading/trailing '-' are trimmed.
 * e.g. "/var/folders/79/9_6l19w13wx" -> "var-folders-79-9-6l19w13wx"
 */
export function workspacePathToProjectSlug(pathOrUri: string): string {
  let fsPath = pathOrUri.replace(/^file:\/\//, '');
  try {
    fsPath = decodeURIComponent(fsPath);
  } catch {
    // Keep raw path if it contains stray % characters
  }
  return fsPath
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface WorkspaceIdentifierLike {
  id?: string;
  uri?: string | { fsPath?: string; path?: string; external?: string };
  configPath?: string | { fsPath?: string; path?: string; external?: string };
}

/**
 * Extract a filesystem path from a workspaceIdentifier found in
 * composer.composerHeaders entries or composerData records.
 */
export function workspaceIdentifierToPath(ws: WorkspaceIdentifierLike | undefined): string | null {
  if (!ws) return null;
  const candidates = [ws.uri, ws.configPath];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
    if (c && typeof c === 'object') {
      const p = c.fsPath ?? c.path ?? c.external;
      if (typeof p === 'string' && p.length > 0) return p;
    }
  }
  return null;
}

interface RawBubble {
  type?: number;
  text?: string;
  toolFormerData?: {
    name?: string;
    params?: string;
    rawArgs?: string;
  };
  thinking?: { text?: string };
}

interface TranscriptContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  name?: string;
  input?: unknown;
}

/**
 * Convert one bubble into a transcript JSONL line (or null if the bubble has
 * no representable content). Mirrors the format Cursor's agent harness writes:
 * {"role":"user"|"assistant","message":{"content":[{type:"text"|"tool_use",...}]}}
 */
export function bubbleToTranscriptLine(bubble: RawBubble): string | null {
  const isUser = bubble.type === 1;
  const content: TranscriptContentBlock[] = [];

  const text = typeof bubble.text === 'string' ? bubble.text.trim() : '';
  if (text.length > 0) {
    content.push({
      type: 'text',
      text: isUser ? `<user_query>\n${bubble.text}\n</user_query>` : (bubble.text as string),
    });
  }

  const tool = bubble.toolFormerData;
  if (!isUser && tool && typeof tool.name === 'string' && tool.name.length > 0) {
    let input: unknown = {};
    const rawParams = tool.params ?? tool.rawArgs;
    if (typeof rawParams === 'string' && rawParams.length > 0) {
      try {
        input = JSON.parse(rawParams);
      } catch {
        input = { _raw: rawParams };
      }
    } else if (rawParams && typeof rawParams === 'object') {
      input = rawParams;
    }
    content.push({ type: 'tool_use', name: tool.name, input });
  }

  if (content.length === 0) return null;

  return JSON.stringify({
    role: isUser ? 'user' : 'assistant',
    message: { content },
  });
}

interface ComposerDataLike {
  fullConversationHeadersOnly?: Array<{ bubbleId?: string; type?: number }>;
  workspaceIdentifier?: WorkspaceIdentifierLike;
}

/**
 * Build a transcript JSONL string from a session's bubbles.
 * Bubble order follows fullConversationHeadersOnly when available; bubbles not
 * referenced by headers are appended in database (rowid) order.
 */
export function synthesizeTranscript(
  composerData: ComposerDataLike | null,
  bubbles: Array<{ bubbleId: string; data: RawBubble }>
): string {
  const byId = new Map<string, RawBubble>();
  for (const b of bubbles) {
    byId.set(b.bubbleId, b.data);
  }

  const ordered: RawBubble[] = [];
  const seen = new Set<string>();

  const headers = composerData?.fullConversationHeadersOnly;
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (!h.bubbleId) continue;
      const bubble = byId.get(h.bubbleId);
      if (bubble) {
        ordered.push(bubble);
        seen.add(h.bubbleId);
      }
    }
  }
  for (const b of bubbles) {
    if (seen.has(b.bubbleId) === false) {
      ordered.push(b.data);
    }
  }

  const lines: string[] = [];
  for (const bubble of ordered) {
    const line = bubbleToTranscriptLine(bubble);
    if (line !== null) {
      lines.push(line);
    }
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/** Stats returned by synthesizeMissingTranscripts */
export interface TranscriptSynthesisStats {
  /** Transcript files created */
  created: number;
  /** Sessions that already had a transcript */
  skippedExisting: number;
  /** Sessions with no resolvable workspace (can't place the file) */
  skippedNoWorkspace: number;
  /** Sessions with no bubbles or no representable content */
  skippedEmpty: number;
  /** Per-session errors (session id -> message) */
  errors: string[];
}

export interface SynthesizeTranscriptsOptions {
  /** Path to the global state.vscdb (default: platform Cursor global storage) */
  globalDbPath?: string;
  /** Workspace storage dir, used to resolve workspaces via pane keys (default: platform path) */
  workspaceStorageDir?: string;
  /** ~/.cursor/projects directory (default: real one) */
  projectsDir?: string;
  /**
   * Limit synthesis to these session IDs. Default: every session listed in
   * composer.composerHeaders (Cursor's sidebar index), so hidden/pruned
   * sessions don't get transcript files.
   */
  sessionIds?: Set<string>;
  /** Report what would be created without writing files */
  dryRun?: boolean;
  /** Progress callback (candidates examined, total candidates) */
  onProgress?: (processed: number, total: number) => void;
}

function getDefaultGlobalDbPath(): string {
  const home = homedir();
  switch (process.platform) {
    case 'win32':
      return join(
        process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'),
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb'
      );
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default:
      return join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

/**
 * Build sessionId -> workspace path map from workspace pane keys.
 * Used as a fallback for sessions whose composerData/header lacks a
 * workspaceIdentifier (common for pre-3.0 sessions).
 */
function buildPaneSessionWorkspaceMap(workspaceStorageDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(workspaceStorageDir)) return map;

  let entries: string[] = [];
  try {
    entries = readdirSync(workspaceStorageDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return map;
  }

  for (const entry of entries) {
    const wsDir = join(workspaceStorageDir, entry);
    const dbPath = join(wsDir, 'state.vscdb');
    const jsonPath = join(wsDir, 'workspace.json');
    if (existsSync(dbPath) === false || existsSync(jsonPath) === false) continue;

    let wsPath: string | null = null;
    try {
      const raw = JSON.parse(readFileSync(jsonPath, 'utf-8')) as {
        workspace?: string;
        folder?: string;
      };
      wsPath = raw.workspace ?? raw.folder ?? null;
    } catch {
      continue;
    }
    if (!wsPath) continue;

    try {
      const db = registry.openSync(dbPath, { readonly: true });
      try {
        const rows = db
          .prepare("SELECT value FROM ItemTable WHERE key LIKE 'workbench.panel.composerChatViewPane.%'")
          .all() as Array<{ value: string }>;
        for (const row of rows) {
          try {
            const paneData = JSON.parse(row.value) as Record<string, unknown>;
            for (const key of Object.keys(paneData)) {
              const match = key.match(/^workbench\.panel\.aichat\.view\.(.+)$/);
              if (match?.[1] && map.has(match[1]) === false) {
                map.set(match[1], wsPath);
              }
            }
          } catch {
            continue;
          }
        }
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
  }

  return map;
}

/**
 * Create missing agent transcript JSONL files from bubble data.
 *
 * For every session in the global DB (or the provided subset), determine the
 * owning workspace, and if ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl
 * does not exist, synthesize it from the session's bubbles.
 */
export async function synthesizeMissingTranscripts(
  options?: SynthesizeTranscriptsOptions
): Promise<TranscriptSynthesisStats> {
  const globalDbPath = options?.globalDbPath ?? getDefaultGlobalDbPath();
  const projectsDir = options?.projectsDir ?? join(homedir(), '.cursor', 'projects');
  const workspaceStorageDir =
    options?.workspaceStorageDir ?? join(globalDbPath, '..', '..', 'workspaceStorage');
  const dryRun = options?.dryRun ?? false;

  const stats: TranscriptSynthesisStats = {
    created: 0,
    skippedExisting: 0,
    skippedNoWorkspace: 0,
    skippedEmpty: 0,
    errors: [],
  };

  if (existsSync(globalDbPath) === false) {
    stats.errors.push(`Global DB not found: ${globalDbPath}`);
    return stats;
  }

  await registry.ensureDriver();

  // Workspace resolution sources, in priority order:
  // 1. composer.composerHeaders entries (Cursor 3.0 sidebar index)
  // 2. composerData.workspaceIdentifier
  // 3. workspace pane keys (pre-3.0 sessions)
  const headerWorkspace = new Map<string, string>();
  const headerIds = new Set<string>();
  const db = registry.openSync(globalDbPath, { readonly: true });
  try {
    try {
      const headersRow = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'")
        .get() as { value: string } | undefined;
      if (headersRow) {
        const parsed = JSON.parse(headersRow.value) as {
          allComposers?: Array<{ composerId?: string; workspaceIdentifier?: WorkspaceIdentifierLike }>;
        };
        for (const h of parsed.allComposers ?? []) {
          if (!h.composerId) continue;
          headerIds.add(h.composerId);
          const wsPath = workspaceIdentifierToPath(h.workspaceIdentifier);
          if (wsPath) headerWorkspace.set(h.composerId, wsPath);
        }
      }
    } catch {
      // ItemTable may not exist
    }

    // Default scope: sessions Cursor lists in its sidebar index. Synthesizing
    // for unlisted sessions would surface long-deleted chats in the tag menu.
    const scopeIds = options?.sessionIds ?? (headerIds.size > 0 ? headerIds : undefined);

    // Range query instead of LIKE: LIKE is case-insensitive by default so
    // SQLite skips the key index and full-scans a potentially multi-GB table.
    const composerRows = db
      .prepare(
        "SELECT key, value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'"
      )
      .all() as Array<{ key: string; value: string | null }>;

    let paneMap: Map<string, string> | null = null;
    const selectBubbles = db.prepare(
      'SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY rowid ASC'
    );

    const candidates = composerRows.filter((row) => {
      const sessionId = row.key.replace('composerData:', '');
      return !scopeIds || scopeIds.has(sessionId);
    });
    const total = candidates.length;
    let processed = 0;

    for (const row of candidates) {
      const sessionId = row.key.replace('composerData:', '');
      processed++;
      options?.onProgress?.(processed, total);

      let composerData: ComposerDataLike | null = null;
      if (typeof row.value === 'string') {
        try {
          composerData = JSON.parse(row.value) as ComposerDataLike;
        } catch {
          composerData = null;
        }
      }

      // Resolve workspace path
      let wsPath =
        headerWorkspace.get(sessionId) ??
        workspaceIdentifierToPath(composerData?.workspaceIdentifier);
      if (!wsPath) {
        if (paneMap === null) {
          paneMap = buildPaneSessionWorkspaceMap(workspaceStorageDir);
        }
        wsPath = paneMap.get(sessionId) ?? null;
      }
      if (!wsPath) {
        stats.skippedNoWorkspace++;
        debugLogStorage(`transcript synthesis: no workspace for session ${sessionId}`);
        continue;
      }

      const slug = workspacePathToProjectSlug(wsPath);
      if (slug.length === 0) {
        stats.skippedNoWorkspace++;
        continue;
      }

      const transcriptPath = join(projectsDir, slug, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
      if (existsSync(transcriptPath)) {
        stats.skippedExisting++;
        continue;
      }

      try {
        // ';' is ':' + 1 in ASCII, so this covers exactly "bubbleId:<id>:*"
        const bubbleRows = selectBubbles.all(
          `bubbleId:${sessionId}:`,
          `bubbleId:${sessionId};`
        ) as Array<{
          key: string;
          value: string | null;
        }>;

        const bubbles: Array<{ bubbleId: string; data: RawBubble }> = [];
        for (const b of bubbleRows) {
          if (typeof b.value !== 'string') continue;
          const bubbleId = b.key.split(':')[2] ?? '';
          try {
            bubbles.push({ bubbleId, data: JSON.parse(b.value) as RawBubble });
          } catch {
            continue;
          }
        }

        const transcript = synthesizeTranscript(composerData, bubbles);
        if (transcript.length === 0) {
          stats.skippedEmpty++;
          continue;
        }

        if (dryRun === false) {
          mkdirSync(join(projectsDir, slug, 'agent-transcripts', sessionId), { recursive: true });
          writeFileSync(transcriptPath, transcript, 'utf-8');
        }
        stats.created++;
      } catch (e) {
        stats.errors.push(`${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    db.close();
  }

  return stats;
}
