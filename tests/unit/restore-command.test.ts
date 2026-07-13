import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const { mockRestoreBackup, mockValidateBackup } = vi.hoisted(() => ({
  mockRestoreBackup: vi.fn(),
  mockValidateBackup: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

vi.mock('../../src/core/backup.js', () => ({
  restoreBackup: (...args: unknown[]) => mockRestoreBackup(...args),
  validateBackup: (...args: unknown[]) => mockValidateBackup(...args),
}));

import { registerRestoreCommand } from '../../src/cli/commands/restore.js';

describe('restore command dry run', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mockValidateBackup.mockResolvedValue({
      status: 'valid',
      validFiles: ['globalStorage/state.vscdb'],
      corruptedFiles: [],
      missingFiles: [],
      errors: [],
      manifest: {
        version: '1.1.0',
        createdAt: new Date().toISOString(),
        sourcePlatform: 'darwin',
        cursorHistoryVersion: 'test',
        files: [],
        stats: { totalSize: 0, sessionCount: 1, workspaceCount: 0 },
        scope: { type: 'full' },
      },
    });
    mockRestoreBackup.mockResolvedValue({
      success: true,
      targetPath: '/target/workspaceStorage',
      filesRestored: 0,
      warnings: [],
      durationMs: 1,
      dryRun: true,
      plan: {
        mode: 'merge',
        conflictStrategy: 'abort',
        canApply: true,
        backupScope: 'full',
        backupSessionCount: 1,
        localSessionCount: 0,
        sessionsToAdd: 1,
        sessionsToUpdate: 0,
        sessionsToSkip: 0,
        conflictingSessionIds: [],
        unresolvedConflictIds: [],
        workspacesNew: 0,
        workspacesMerged: 0,
        transcriptFilesToCopy: 0,
        transcriptCandidatesToSynthesize: 1,
        filesToCreate: [],
        filesToModify: [],
        filesToOverwrite: [],
        filesToSkip: [],
        warnings: [],
        blockers: [],
      },
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('passes --dry-run and --merge to the core restore', async () => {
    const program = new Command();
    program.option('--json');
    registerRestoreCommand(program);

    await program.parseAsync(['node', 'test', 'restore', '/backup.zip', '--merge', '--dry-run']);

    expect(mockRestoreBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        backupPath: '/backup.zip',
        merge: true,
        dryRun: true,
        conflictStrategy: 'abort',
      })
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dry run complete — restore can proceed')
    );
  });

  it('maps --auto-resolve-conflicts to the newer strategy', async () => {
    const program = new Command();
    program.option('--json');
    registerRestoreCommand(program);

    await program.parseAsync([
      'node',
      'test',
      'restore',
      '/backup.zip',
      '--merge',
      '--dry-run',
      '--auto-resolve-conflicts',
    ]);

    expect(mockRestoreBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        merge: true,
        dryRun: true,
        conflictStrategy: 'newer',
      })
    );
  });

  it('passes an explicit conflict strategy', async () => {
    const program = new Command();
    program.option('--json');
    registerRestoreCommand(program);

    await program.parseAsync([
      'node',
      'test',
      'restore',
      '/backup.zip',
      '--merge',
      '--conflict-strategy',
      'local',
    ]);

    expect(mockRestoreBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        merge: true,
        conflictStrategy: 'local',
      })
    );
  });
});
