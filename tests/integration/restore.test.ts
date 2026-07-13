import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import yazl from 'yazl';
import {
  computeChecksum,
  createBackup,
  readBackupManifest,
  restoreBackup,
} from '../../src/core/backup.js';
import type { BackupManifest, BackupScope } from '../../src/core/types.js';

interface TestSession {
  id: string;
  name: string;
  lastUpdatedAt?: number;
}

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cursor-history-restore-'));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function createGlobalDatabase(path: string, sessions: TestSession[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE cursorDiskKV (key TEXT NOT NULL, value TEXT NOT NULL);
      CREATE UNIQUE INDEX cursorDiskKV_key ON cursorDiskKV(key);
      CREATE TABLE ItemTable (key TEXT NOT NULL, value TEXT NOT NULL);
      CREATE UNIQUE INDEX ItemTable_key ON ItemTable(key);
    `);

    const insertKv = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    for (const session of sessions) {
      const bubbleId = `${session.id}-bubble`;
      insertKv.run(
        `composerData:${session.id}`,
        JSON.stringify({
          composerId: session.id,
          name: session.name,
          createdAt: 1,
          lastUpdatedAt: session.lastUpdatedAt ?? 2,
          fullConversationHeadersOnly: [{ bubbleId, type: 1 }],
        })
      );
      insertKv.run(
        `bubbleId:${session.id}:${bubbleId}`,
        JSON.stringify({ type: 1, text: session.name })
      );
    }

    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'composer.composerHeaders',
      JSON.stringify({
        allComposers: sessions.map((session) => ({
          composerId: session.id,
          name: session.name,
          lastUpdatedAt: session.lastUpdatedAt ?? 2,
        })),
      })
    );
  } finally {
    db.close();
  }
}

function createWorkspaceDatabase(path: string, sessions: TestSession[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE ItemTable (key TEXT NOT NULL, value TEXT NOT NULL);
      CREATE UNIQUE INDEX ItemTable_key ON ItemTable(key);
    `);
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'composer.composerData',
      JSON.stringify({
        allComposers: sessions.map((session) => ({
          composerId: session.id,
          name: session.name,
          lastUpdatedAt: session.lastUpdatedAt ?? 2,
        })),
      })
    );
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'workbench.panel.composerChatViewPane.test-pane',
      JSON.stringify(
        Object.fromEntries(
          sessions.map((session) => [
            `workbench.panel.aichat.view.${session.id}`,
            { title: session.name },
          ])
        )
      )
    );
  } finally {
    db.close();
  }
}

function createLegacyWorkspaceDatabase(path: string, sessions: TestSession[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE ItemTable (key TEXT NOT NULL, value TEXT NOT NULL);
      CREATE UNIQUE INDEX ItemTable_key ON ItemTable(key);
    `);
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'workbench.panel.aichat.view.aichat.chatdata',
      JSON.stringify({
        chatSessions: sessions.map((session) => ({
          id: session.id,
          title: session.name,
          createdAt: 1,
          lastSendTime: Date.now(),
          messages: [{ role: 'user', content: session.name }],
        })),
      })
    );
  } finally {
    db.close();
  }
}

function readWorkspaceSessionIds(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
      .get() as { value: string };
    const parsed = JSON.parse(row.value) as {
      allComposers: Array<{ composerId: string }>;
    };
    return parsed.allComposers.map((composer) => composer.composerId);
  } finally {
    db.close();
  }
}

function readWorkspaceSessionName(path: string, sessionId: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
      .get() as { value: string };
    const parsed = JSON.parse(row.value) as {
      allComposers: Array<{ composerId: string; name?: string }>;
    };
    return parsed.allComposers.find((composer) => composer.composerId === sessionId)?.name ?? null;
  } finally {
    db.close();
  }
}

function readLegacyWorkspaceSessionIds(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT value FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'"
      )
      .get() as { value: string };
    const parsed = JSON.parse(row.value) as {
      chatSessions: Array<{ id: string }>;
    };
    return parsed.chatSessions.map((session) => session.id);
  } finally {
    db.close();
  }
}

async function createBackupArchive(
  databasePath: string,
  archivePath: string,
  scope: BackupScope,
  extraFiles: Array<{
    path: string;
    content: Buffer;
    type: 'workspace-db' | 'workspace-json' | 'transcript';
  }> = []
): Promise<void> {
  const databaseBuffer = readFileSync(databasePath);
  const manifest: BackupManifest = {
    version: '1.1.0',
    createdAt: new Date().toISOString(),
    sourcePlatform: process.platform as 'darwin' | 'win32' | 'linux',
    cursorHistoryVersion: 'test',
    files: [
      {
        path: 'globalStorage/state.vscdb',
        size: databaseBuffer.length,
        checksum: computeChecksum(databaseBuffer),
        type: 'global-db',
      },
      ...extraFiles.map((file) => ({
        path: file.path,
        size: file.content.length,
        checksum: computeChecksum(file.content),
        type: file.type,
      })),
    ],
    stats: {
      totalSize: databaseBuffer.length,
      sessionCount: 1,
      workspaceCount: 0,
    },
    scope,
  };

  const zip = new yazl.ZipFile();
  zip.addFile(databasePath, 'globalStorage/state.vscdb', { compress: false });
  for (const file of extraFiles) {
    zip.addBuffer(file.content, file.path);
  }
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
  mkdirSync(dirname(archivePath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath);
    output.on('close', resolve);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

function readSessionName(databasePath: string, sessionId: string): string | null {
  const db = new Database(databasePath, { readonly: true });
  try {
    const row = db
      .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${sessionId}`) as { value: string } | undefined;
    if (!row) return null;
    return (JSON.parse(row.value) as { name?: string }).name ?? null;
  } finally {
    db.close();
  }
}

function updateSessionMetadata(
  databasePath: string,
  sessionId: string,
  name: string,
  lastUpdatedAt: number
): void {
  const db = new Database(databasePath);
  try {
    const row = db
      .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${sessionId}`) as { value: string };
    const value = JSON.parse(row.value) as Record<string, unknown>;
    value['name'] = name;
    value['lastUpdatedAt'] = lastUpdatedAt;
    db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
      JSON.stringify(value),
      `composerData:${sessionId}`
    );
  } finally {
    db.close();
  }
}

function testPaths() {
  const targetPath = join(testRoot, 'target', 'User', 'workspaceStorage');
  const localGlobalDbPath = join(testRoot, 'target', 'User', 'globalStorage', 'state.vscdb');
  const backupDbPath = join(testRoot, 'backup-source', 'globalStorage', 'state.vscdb');
  const backupPath = join(testRoot, 'backup.zip');
  return { targetPath, localGlobalDbPath, backupDbPath, backupPath };
}

describe('filtered backup scope', () => {
  it('records legacy workspace-only sessions in the manifest import set', async () => {
    const sourcePath = join(testRoot, 'source', 'User', 'workspaceStorage');
    const workspaceDir = join(sourcePath, 'legacy-hash');
    createLegacyWorkspaceDatabase(join(workspaceDir, 'state.vscdb'), [
      { id: 'legacy-recent', name: 'Legacy Recent' },
    ]);
    writeFileSync(join(workspaceDir, 'workspace.json'), '{"folder":"file:///legacy/project"}');
    const backupPath = join(testRoot, 'legacy-filtered.zip');
    const previousHome = process.env['HOME'];
    process.env['HOME'] = testRoot;

    try {
      const result = await createBackup({
        sourcePath,
        outputPath: backupPath,
        since: new Date(Date.now() - 60_000),
      });
      const manifest = await readBackupManifest(backupPath);

      expect(result.success).toBe(true);
      expect(manifest?.scope).toMatchObject({
        type: 'filtered',
        sessionIds: ['legacy-recent'],
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = previousHome;
      }
    }
  });
});

describe('restore preflight and additive merge', () => {
  it('dry-runs a disjoint merge without changing the target', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [{ id: 'local-session', name: 'Local' }]);
    createGlobalDatabase(paths.backupDbPath, [{ id: 'remote-session', name: 'Remote' }]);
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' });

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      dryRun: true,
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.plan).toMatchObject({
      canApply: true,
      mode: 'merge',
      backupSessionCount: 1,
      localSessionCount: 1,
      sessionsToAdd: 1,
      conflictingSessionIds: [],
    });
    expect(readSessionName(paths.localGlobalDbPath, 'local-session')).toBe('Local');
    expect(readSessionName(paths.localGlobalDbPath, 'remote-session')).toBeNull();
  });

  it('imports disjoint sessions additively', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [{ id: 'local-session', name: 'Local' }]);
    createGlobalDatabase(paths.backupDbPath, [{ id: 'remote-session', name: 'Remote' }]);
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' });

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(true);
    expect(result.mergeStats?.sessionsAdded).toBe(1);
    expect(result.mergeStats?.sessionsUpdated).toBe(0);
    expect(readSessionName(paths.localGlobalDbPath, 'local-session')).toBe('Local');
    expect(readSessionName(paths.localGlobalDbPath, 'remote-session')).toBe('Remote');
  });

  it('blocks overlapping sessions without replacing local metadata', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [{ id: 'shared-session', name: 'Local Newer' }]);
    createGlobalDatabase(paths.backupDbPath, [{ id: 'shared-session', name: 'Backup Older' }]);
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' });

    const dryRun = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      dryRun: true,
      synthesizeTranscripts: false,
    });
    const restore = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      synthesizeTranscripts: false,
    });

    expect(dryRun.success).toBe(false);
    expect(dryRun.plan?.conflictingSessionIds).toEqual(['shared-session']);
    expect(dryRun.plan?.unresolvedConflictIds).toEqual(['shared-session']);
    expect(restore.success).toBe(false);
    expect(restore.error).toContain('unresolved overlapping');
    expect(readSessionName(paths.localGlobalDbPath, 'shared-session')).toBe('Local Newer');
  });

  it('updates an overlapping session when the backup is newer', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [
      { id: 'shared-session', name: 'Local Older', lastUpdatedAt: 10 },
    ]);
    createGlobalDatabase(paths.backupDbPath, [
      { id: 'shared-session', name: 'Backup Newer', lastUpdatedAt: 20 },
    ]);
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' });

    const dryRun = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      dryRun: true,
      conflictStrategy: 'newer',
      synthesizeTranscripts: false,
    });
    const restore = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      conflictStrategy: 'newer',
      synthesizeTranscripts: false,
    });

    expect(dryRun.success).toBe(true);
    expect(dryRun.plan).toMatchObject({
      sessionsToAdd: 0,
      sessionsToUpdate: 1,
      sessionsToSkip: 0,
      unresolvedConflictIds: [],
    });
    expect(restore.success).toBe(true);
    expect(restore.mergeStats?.sessionsUpdated).toBe(1);
    expect(readSessionName(paths.localGlobalDbPath, 'shared-session')).toBe('Backup Newer');
  });

  it('leaves equal-timestamp divergent sessions unresolved under newer', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [
      { id: 'shared-session', name: 'Local Branch', lastUpdatedAt: 20 },
    ]);
    createGlobalDatabase(paths.backupDbPath, [
      { id: 'shared-session', name: 'Backup Branch', lastUpdatedAt: 20 },
    ]);
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' });

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      dryRun: true,
      conflictStrategy: 'newer',
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(false);
    expect(result.plan?.unresolvedConflictIds).toEqual(['shared-session']);
  });

  it('refuses a newer update when the local session advances after preflight', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [
      { id: 'shared-session', name: 'Local Older', lastUpdatedAt: 10 },
    ]);
    createGlobalDatabase(paths.backupDbPath, [
      { id: 'shared-session', name: 'Backup Newer', lastUpdatedAt: 20 },
    ]);
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' });
    let advanced = false;

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      conflictStrategy: 'newer',
      synthesizeTranscripts: false,
      onProgress: (progress) => {
        if (progress.phase === 'extracting' && !advanced) {
          advanced = true;
          updateSessionMetadata(paths.localGlobalDbPath, 'shared-session', 'Concurrent Newest', 30);
        }
      },
    });

    expect(result.success).toBe(false);
    expect(readSessionName(paths.localGlobalDbPath, 'shared-session')).toBe('Concurrent Newest');
  });

  it('rejects invalid conflict strategies from JavaScript callers', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [{ id: 'shared-session', name: 'Local' }]);
    createGlobalDatabase(paths.backupDbPath, [{ id: 'shared-session', name: 'Backup' }]);
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' });

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      dryRun: true,
      conflictStrategy: 'invalid' as never,
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid conflict strategy');
  });

  it('updates matching workspace metadata for a newer backup session', async () => {
    const paths = testPaths();
    const localSession = {
      id: 'shared-session',
      name: 'Local Older',
      lastUpdatedAt: 10,
    };
    const backupSession = {
      id: 'shared-session',
      name: 'Backup Newer',
      lastUpdatedAt: 20,
    };
    createGlobalDatabase(paths.localGlobalDbPath, [localSession]);
    createGlobalDatabase(paths.backupDbPath, [backupSession]);
    const localWorkspaceDb = join(paths.targetPath, 'local-hash', 'state.vscdb');
    const backupWorkspaceDb = join(testRoot, 'backup-source', 'workspace', 'state.vscdb');
    createWorkspaceDatabase(localWorkspaceDb, [localSession]);
    createWorkspaceDatabase(backupWorkspaceDb, [backupSession]);
    const workspaceJson = Buffer.from('{"folder":"file:///shared/project"}');
    writeFileSync(join(paths.targetPath, 'local-hash', 'workspace.json'), workspaceJson);
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' }, [
      {
        path: 'workspaceStorage/backup-hash/state.vscdb',
        content: readFileSync(backupWorkspaceDb),
        type: 'workspace-db',
      },
      {
        path: 'workspaceStorage/backup-hash/workspace.json',
        content: workspaceJson,
        type: 'workspace-json',
      },
    ]);

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      conflictStrategy: 'newer',
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(true);
    expect(readWorkspaceSessionName(localWorkspaceDb, 'shared-session')).toBe('Backup Newer');
  });

  it('updates an archived transcript for a newer backup session', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [
      { id: 'shared-session', name: 'Local Older', lastUpdatedAt: 10 },
    ]);
    createGlobalDatabase(paths.backupDbPath, [
      { id: 'shared-session', name: 'Backup Newer', lastUpdatedAt: 20 },
    ]);
    const projectsPath = join(testRoot, 'projects');
    const transcriptPath = join(
      projectsPath,
      'project',
      'agent-transcripts',
      'shared-session',
      'shared-session.jsonl'
    );
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, '{"source":"local"}\n');
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' }, [
      {
        path: 'projects/project/agent-transcripts/shared-session/shared-session.jsonl',
        content: Buffer.from('{"source":"backup"}\n'),
        type: 'transcript',
      },
    ]);

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      projectsPath,
      merge: true,
      conflictStrategy: 'newer',
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(true);
    expect(readFileSync(transcriptPath, 'utf-8')).toBe('{"source":"backup"}\n');
  });

  it('keeps an overlapping session when the local copy is newer', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [
      { id: 'shared-session', name: 'Local Newer', lastUpdatedAt: 20 },
    ]);
    createGlobalDatabase(paths.backupDbPath, [
      { id: 'shared-session', name: 'Backup Older', lastUpdatedAt: 10 },
    ]);
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' });

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      conflictStrategy: 'newer',
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(true);
    expect(result.mergeStats?.sessionsAdded).toBe(0);
    expect(result.mergeStats?.sessionsUpdated).toBe(0);
    expect(readSessionName(paths.localGlobalDbPath, 'shared-session')).toBe('Local Newer');
  });

  it('supports explicit local and backup conflict strategies', async () => {
    const localPaths = testPaths();
    createGlobalDatabase(localPaths.localGlobalDbPath, [{ id: 'shared-session', name: 'Local' }]);
    createGlobalDatabase(localPaths.backupDbPath, [{ id: 'shared-session', name: 'Backup' }]);
    const sourceDb = new Database(localPaths.backupDbPath);
    sourceDb
      .prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
      .run('bubbleId:shared-session:backup-only', '{"type":2,"text":"backup-only-row"}');
    sourceDb.close();
    await createBackupArchive(localPaths.backupDbPath, localPaths.backupPath, {
      type: 'full',
    });

    const localResult = await restoreBackup({
      backupPath: localPaths.backupPath,
      targetPath: localPaths.targetPath,
      merge: true,
      conflictStrategy: 'local',
      synthesizeTranscripts: false,
    });
    expect(localResult.success).toBe(true);
    expect(readSessionName(localPaths.localGlobalDbPath, 'shared-session')).toBe('Local');
    const localDb = new Database(localPaths.localGlobalDbPath, { readonly: true });
    const additiveBubble = localDb
      .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get('bubbleId:shared-session:backup-only');
    localDb.close();
    expect(additiveBubble).toBeDefined();

    rmSync(join(testRoot, 'target'), { recursive: true, force: true });
    createGlobalDatabase(localPaths.localGlobalDbPath, [{ id: 'shared-session', name: 'Local' }]);
    const backupResult = await restoreBackup({
      backupPath: localPaths.backupPath,
      targetPath: localPaths.targetPath,
      merge: true,
      conflictStrategy: 'backup',
      synthesizeTranscripts: false,
    });
    expect(backupResult.success).toBe(true);
    expect(readSessionName(localPaths.localGlobalDbPath, 'shared-session')).toBe('Backup');
  });

  it('blocks force restore of a filtered backup', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [{ id: 'local-session', name: 'Local' }]);
    createGlobalDatabase(paths.backupDbPath, [{ id: 'remote-session', name: 'Remote' }]);
    await createBackupArchive(paths.backupDbPath, paths.backupPath, {
      type: 'filtered',
      since: new Date(0).toISOString(),
    });

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      force: true,
      dryRun: true,
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(false);
    expect(result.plan?.backupScope).toBe('filtered');
    expect(result.error).toContain('filtered backup');
    expect(readSessionName(paths.localGlobalDbPath, 'local-session')).toBe('Local');
  });

  it('imports workspace-only sessions declared by a filtered manifest', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [{ id: 'local-session', name: 'Local' }]);
    createGlobalDatabase(paths.backupDbPath, []);
    const legacyWorkspaceDb = join(testRoot, 'backup-source', 'legacy', 'state.vscdb');
    createLegacyWorkspaceDatabase(legacyWorkspaceDb, [
      { id: 'legacy-remote', name: 'Legacy Remote' },
    ]);

    await createBackupArchive(
      paths.backupDbPath,
      paths.backupPath,
      {
        type: 'filtered',
        since: new Date(0).toISOString(),
        sessionIds: ['legacy-remote'],
      },
      [
        {
          path: 'workspaceStorage/legacy-hash/state.vscdb',
          content: readFileSync(legacyWorkspaceDb),
          type: 'workspace-db',
        },
        {
          path: 'workspaceStorage/legacy-hash/workspace.json',
          content: Buffer.from('{"folder":"file:///legacy/project"}'),
          type: 'workspace-json',
        },
      ]
    );

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(true);
    expect(result.mergeStats?.sessionsAdded).toBe(1);
    expect(
      readLegacyWorkspaceSessionIds(join(paths.targetPath, 'legacy-hash', 'state.vscdb'))
    ).toEqual(['legacy-remote']);
  });

  it('imports checkpoint-only payloads selected by a filtered manifest', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [{ id: 'local-session', name: 'Local' }]);
    createGlobalDatabase(paths.backupDbPath, []);
    const backupDb = new Database(paths.backupDbPath);
    backupDb
      .prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
      .run('checkpointId:checkpoint-session:checkpoint-1', '{"files":[]}');
    backupDb.close();
    await createBackupArchive(paths.backupDbPath, paths.backupPath, {
      type: 'filtered',
      since: new Date(0).toISOString(),
      sessionIds: ['checkpoint-session'],
    });

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      synthesizeTranscripts: false,
    });
    const localDb = new Database(paths.localGlobalDbPath, { readonly: true });
    const checkpoint = localDb
      .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get('checkpointId:checkpoint-session:checkpoint-1');
    localDb.close();

    expect(result.success).toBe(true);
    expect(checkpoint).toBeDefined();
  });

  it('dry-runs overwrite mode without replacing an existing database', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [{ id: 'local-session', name: 'Local' }]);
    createGlobalDatabase(paths.backupDbPath, [{ id: 'remote-session', name: 'Remote' }]);
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' });

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      force: true,
      dryRun: true,
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(true);
    expect(result.plan?.mode).toBe('overwrite');
    expect(result.plan?.filesToOverwrite).toContain(paths.localGlobalDbPath);
    expect(readSessionName(paths.localGlobalDbPath, 'local-session')).toBe('Local');
    expect(readSessionName(paths.localGlobalDbPath, 'remote-session')).toBeNull();
  });

  it('does not overwrite a target that appears after preflight without force', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.backupDbPath, [{ id: 'remote-session', name: 'Remote' }]);
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' });

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      synthesizeTranscripts: false,
      onProgress: (progress) => {
        if (progress.phase === 'finalizing' && !existsSync(paths.localGlobalDbPath)) {
          createGlobalDatabase(paths.localGlobalDbPath, [
            { id: 'concurrent-session', name: 'Concurrent' },
          ]);
        }
      },
    });

    expect(result.success).toBe(false);
    expect(readSessionName(paths.localGlobalDbPath, 'concurrent-session')).toBe('Concurrent');
    expect(readSessionName(paths.localGlobalDbPath, 'remote-session')).toBeNull();
  });

  it('restores overwritten files when a later commit step fails', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [{ id: 'local-session', name: 'Local' }]);
    createGlobalDatabase(paths.backupDbPath, [{ id: 'remote-session', name: 'Remote' }]);
    const conflictingDestination = join(paths.targetPath, 'collision', 'workspace.json');
    mkdirSync(conflictingDestination, { recursive: true });
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' }, [
      {
        path: 'workspaceStorage/collision/workspace.json',
        content: Buffer.from('{"folder":"file:///remote"}'),
        type: 'workspace-json',
      },
    ]);

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      force: true,
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(false);
    expect(readSessionName(paths.localGlobalDbPath, 'local-session')).toBe('Local');
    expect(readSessionName(paths.localGlobalDbPath, 'remote-session')).toBeNull();
  });

  it('rolls back workspace changes when a later global merge fails', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [{ id: 'local-session', name: 'Local' }]);
    const localGlobal = new Database(paths.localGlobalDbPath);
    localGlobal.exec("ALTER TABLE cursorDiskKV ADD COLUMN extra TEXT NOT NULL DEFAULT 'local'");
    localGlobal.close();

    createGlobalDatabase(paths.backupDbPath, [{ id: 'remote-session', name: 'Remote' }]);
    const localWorkspaceDb = join(paths.targetPath, 'local-hash', 'state.vscdb');
    const backupWorkspaceDb = join(testRoot, 'backup-source', 'workspace', 'state.vscdb');
    createWorkspaceDatabase(localWorkspaceDb, [{ id: 'local-session', name: 'Local' }]);
    createWorkspaceDatabase(backupWorkspaceDb, [{ id: 'remote-session', name: 'Remote' }]);
    const workspaceJson = Buffer.from('{"folder":"file:///shared/project"}');
    const localWorkspaceJson = join(paths.targetPath, 'local-hash', 'workspace.json');
    mkdirSync(dirname(localWorkspaceJson), { recursive: true });
    writeFileSync(localWorkspaceJson, workspaceJson);

    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' }, [
      {
        path: 'workspaceStorage/backup-hash/state.vscdb',
        content: readFileSync(backupWorkspaceDb),
        type: 'workspace-db',
      },
      {
        path: 'workspaceStorage/backup-hash/workspace.json',
        content: workspaceJson,
        type: 'workspace-json',
      },
    ]);

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(false);
    expect(readWorkspaceSessionIds(localWorkspaceDb)).toEqual(['local-session']);
    expect(readSessionName(paths.localGlobalDbPath, 'local-session')).toBe('Local');
    expect(readSessionName(paths.localGlobalDbPath, 'remote-session')).toBeNull();
  });

  it('rolls back imported rows when sidebar header merge fails', async () => {
    const paths = testPaths();
    createGlobalDatabase(paths.localGlobalDbPath, [{ id: 'local-session', name: 'Local' }]);
    createGlobalDatabase(paths.backupDbPath, [{ id: 'remote-session', name: 'Remote' }]);
    const backupDb = new Database(paths.backupDbPath);
    backupDb
      .prepare("UPDATE ItemTable SET value = 'not-json' WHERE key = 'composer.composerHeaders'")
      .run();
    backupDb.close();
    await createBackupArchive(paths.backupDbPath, paths.backupPath, { type: 'full' });

    const result = await restoreBackup({
      backupPath: paths.backupPath,
      targetPath: paths.targetPath,
      merge: true,
      synthesizeTranscripts: false,
    });

    expect(result.success).toBe(false);
    expect(readSessionName(paths.localGlobalDbPath, 'local-session')).toBe('Local');
    expect(readSessionName(paths.localGlobalDbPath, 'remote-session')).toBeNull();
  });
});
