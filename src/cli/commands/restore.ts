/**
 * Restore command - restore chat history from a backup file
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { existsSync } from 'node:fs';
import { restoreBackup, validateBackup } from '../../core/backup.js';
import type { RestoreConflictStrategy, RestoreProgress, RestoreResult } from '../../core/types.js';
import { handleError, ExitCode } from '../errors.js';
import { expandPath, contractPath } from '../../lib/platform.js';

interface RestoreCommandOptions {
  target?: string;
  projectsPath?: string;
  force?: boolean;
  merge?: boolean;
  dryRun?: boolean;
  autoResolveConflict?: boolean;
  autoResolveConflicts?: boolean;
  conflictStrategy?: string;
  synth?: boolean;
  json?: boolean;
  dataPath?: string;
}

/**
 * Format duration for display
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * T050: Progress display for restore command
 */
function displayProgress(progress: RestoreProgress): void {
  const phases: Record<RestoreProgress['phase'], string> = {
    validating: '🔍 Validating backup integrity...',
    extracting: '📦 Extracting files...',
    finalizing: '✨ Finalizing restore...',
  };

  const phaseText = phases[progress.phase];
  const fileProgress =
    progress.totalFiles > 0 ? ` [${progress.filesCompleted}/${progress.totalFiles}]` : '';
  const currentFile = progress.currentFile ? ` ${pc.dim(progress.currentFile)}` : '';

  // Show integrity status during validation
  const integrityText =
    progress.phase === 'validating' && progress.integrityStatus === 'warnings'
      ? pc.yellow(' (some files have warnings)')
      : '';

  // Clear line and print progress
  process.stdout.write(`\r${phaseText}${fileProgress}${currentFile}${integrityText}`.padEnd(80));
}

/**
 * Format restore result for JSON output
 */
function formatRestoreResultJson(result: RestoreResult): string {
  return JSON.stringify(
    {
      success: result.success,
      targetPath: result.targetPath,
      filesRestored: result.filesRestored,
      durationMs: result.durationMs,
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
      ...(result.error && { error: result.error }),
      ...(result.mergeStats && { mergeStats: result.mergeStats }),
      ...(result.dryRun !== undefined && { dryRun: result.dryRun }),
      ...(result.plan && { plan: result.plan }),
      ...(result.transcriptsSynthesized !== undefined && {
        transcriptsSynthesized: result.transcriptsSynthesized,
      }),
    },
    null,
    2
  );
}

/**
 * Format restore result for human-readable output
 */
function formatRestoreResult(result: RestoreResult): string {
  const lines: string[] = [];

  if (result.dryRun && result.plan) {
    const plan = result.plan;
    lines.push(
      plan.canApply
        ? pc.green('✓ Dry run complete — restore can proceed')
        : pc.yellow('⚠ Dry run complete — restore is blocked')
    );
    lines.push('');
    lines.push(`  ${pc.bold('Mode:')} ${plan.mode}`);
    lines.push(`  ${pc.bold('Conflict strategy:')} ${plan.conflictStrategy}`);
    lines.push(`  ${pc.bold('Backup scope:')} ${plan.backupScope}`);
    lines.push(`  ${pc.bold('Backup sessions:')} ${plan.backupSessionCount}`);
    lines.push(`  ${pc.bold('Local sessions:')} ${plan.localSessionCount}`);
    lines.push(`  ${pc.bold('Sessions to add:')} ${plan.sessionsToAdd}`);
    lines.push(`  ${pc.bold('Sessions to update:')} ${plan.sessionsToUpdate}`);
    lines.push(`  ${pc.bold('Sessions to skip:')} ${plan.sessionsToSkip}`);
    lines.push(`  ${pc.bold('Conflicting sessions:')} ${plan.conflictingSessionIds.length}`);
    lines.push(`  ${pc.bold('Unresolved conflicts:')} ${plan.unresolvedConflictIds.length}`);
    lines.push(`  ${pc.bold('New workspaces:')} ${plan.workspacesNew}`);
    lines.push(`  ${pc.bold('Merged workspaces:')} ${plan.workspacesMerged}`);
    lines.push(`  ${pc.bold('Files to create:')} ${plan.filesToCreate.length}`);
    lines.push(`  ${pc.bold('Files to modify:')} ${plan.filesToModify.length}`);
    lines.push(`  ${pc.bold('Files to overwrite:')} ${plan.filesToOverwrite.length}`);
    lines.push(`  ${pc.bold('Files to skip:')} ${plan.filesToSkip.length}`);
    lines.push(`  ${pc.bold('Archived transcripts to copy:')} ${plan.transcriptFilesToCopy}`);
    lines.push(
      `  ${pc.bold('Transcript synthesis candidates:')} ${plan.transcriptCandidatesToSynthesize}`
    );

    if (plan.conflictingSessionIds.length > 0) {
      lines.push('');
      lines.push(pc.yellow('  Conflicting session IDs:'));
      for (const id of plan.conflictingSessionIds.slice(0, 10)) {
        lines.push(`    ${pc.dim('•')} ${id}`);
      }
      if (plan.conflictingSessionIds.length > 10) {
        lines.push(`    ${pc.dim(`… and ${plan.conflictingSessionIds.length - 10} more`)}`);
      }
    }

    if (plan.blockers.length > 0) {
      lines.push('');
      lines.push(pc.red('  Blockers:'));
      for (const blocker of plan.blockers) {
        lines.push(`    ${pc.dim('•')} ${blocker}`);
      }
    }

    if (plan.warnings.length > 0) {
      lines.push('');
      lines.push(pc.yellow('  Warnings:'));
      for (const warning of plan.warnings) {
        lines.push(`    ${pc.dim('•')} ${warning}`);
      }
    }

    lines.push('');
    lines.push(pc.bold('  No target files were modified.'));
    return lines.join('\n');
  }

  if (result.success) {
    if (result.mergeStats) {
      lines.push(pc.green('✓ Backup merged successfully!'));
      lines.push('');
      lines.push(`  ${pc.bold('Target:')} ${contractPath(result.targetPath)}`);
      lines.push(`  ${pc.bold('Sessions added:')} ${result.mergeStats.sessionsAdded}`);
      lines.push(`  ${pc.bold('Sessions updated:')} ${result.mergeStats.sessionsUpdated}`);
      lines.push(`  ${pc.bold('New workspaces:')} ${result.mergeStats.workspacesNew}`);
      lines.push(`  ${pc.bold('Merged workspaces:')} ${result.mergeStats.workspacesMerged}`);
      lines.push(`  ${pc.bold('Global rows added:')} ${result.mergeStats.globalRowsAdded}`);
      lines.push(`  ${pc.bold('Sidebar headers added:')} ${result.mergeStats.sidebarHeadersAdded}`);
      lines.push(
        `  ${pc.bold('Transcripts synthesized:')} ${result.mergeStats.transcriptsSynthesized}`
      );
      lines.push(`  ${pc.bold('Duration:')} ${formatDuration(result.durationMs)}`);
    } else {
      lines.push(pc.green('✓ Backup restored successfully!'));
      lines.push('');
      lines.push(`  ${pc.bold('Target:')} ${contractPath(result.targetPath)}`);
      lines.push(`  ${pc.bold('Files restored:')} ${result.filesRestored}`);
      if (result.transcriptsSynthesized !== undefined) {
        lines.push(`  ${pc.bold('Transcripts synthesized:')} ${result.transcriptsSynthesized}`);
      }
      lines.push(`  ${pc.bold('Duration:')} ${formatDuration(result.durationMs)}`);
    }

    if (result.warnings.length > 0) {
      lines.push('');
      lines.push(pc.yellow('  Warnings:'));
      for (const warning of result.warnings) {
        lines.push(`    ${pc.dim('•')} ${warning}`);
      }
    }
  } else {
    lines.push(pc.red('✗ Restore failed'));
    lines.push('');
    if (result.error) {
      lines.push(`  ${pc.bold('Error:')} ${result.error}`);
    }
  }

  return lines.join('\n');
}

/**
 * Register the restore command
 */
export function registerRestoreCommand(program: Command): void {
  program
    .command('restore <backup>')
    .description('Restore chat history from a backup file')
    .option(
      '-t, --target <path>',
      'Target Cursor data path (default: platform-specific Cursor data directory)'
    )
    .option(
      '--projects-path <path>',
      'Agent transcript projects directory (default: ~/.cursor/projects)'
    )
    .option('-f, --force', 'Overwrite existing data without prompting')
    .option('-m, --merge', 'Merge backup into existing data instead of overwriting')
    .option('--dry-run', 'Preview restore without modifying target data')
    .option('--auto-resolve-conflicts', 'Resolve overlaps automatically using the newer session')
    .option('--auto-resolve-conflict', 'Alias for --auto-resolve-conflicts')
    .option('--conflict-strategy <strategy>', 'Overlap strategy: newer, local, backup, or abort')
    .option('--no-synth', 'Skip synthesizing missing agent transcripts after restore')
    .action(async (backupArg: string, options: RestoreCommandOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as { json?: boolean; dataPath?: string };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;

      // Resolve backup path
      const backupPath = expandPath(backupArg);

      try {
        if (options.merge && options.force) {
          console.error(pc.red('Cannot use both --merge and --force.'));
          console.error(pc.dim('--merge imports missing sessions; --force overwrites everything.'));
          process.exit(ExitCode.USAGE_ERROR);
        }
        const autoResolveConflicts = options.autoResolveConflicts || options.autoResolveConflict;
        if (autoResolveConflicts && options.conflictStrategy) {
          console.error(
            pc.red('Cannot combine --auto-resolve-conflicts with --conflict-strategy.')
          );
          process.exit(ExitCode.USAGE_ERROR);
          return;
        }
        const validStrategies: RestoreConflictStrategy[] = ['newer', 'local', 'backup', 'abort'];
        const conflictStrategy = autoResolveConflicts
          ? 'newer'
          : ((options.conflictStrategy ?? 'abort') as RestoreConflictStrategy);
        if (!validStrategies.includes(conflictStrategy)) {
          console.error(
            pc.red(
              `Invalid conflict strategy: ${options.conflictStrategy}. Expected newer, local, backup, or abort.`
            )
          );
          process.exit(ExitCode.USAGE_ERROR);
          return;
        }
        if (!options.merge && (autoResolveConflicts || conflictStrategy !== 'abort')) {
          console.error(pc.red('Conflict resolution options require --merge.'));
          process.exit(ExitCode.USAGE_ERROR);
          return;
        }
        // T051: Check if backup file exists
        if (!existsSync(backupPath)) {
          if (useJson) {
            console.log(JSON.stringify({ error: 'Backup file not found', path: backupPath }));
          } else {
            console.error(pc.red('Backup file not found:'));
            console.error(pc.dim(`  ${backupPath}`));
          }
          process.exit(ExitCode.USAGE_ERROR);
        }

        // T052: Validate backup before attempting restore
        const validation = await validateBackup(backupPath);
        if (validation.status === 'invalid') {
          if (useJson) {
            console.log(
              JSON.stringify({
                error: 'Invalid or corrupted backup',
                errors: validation.errors,
              })
            );
          } else {
            console.error(pc.red('Invalid or corrupted backup file:'));
            for (const err of validation.errors) {
              console.error(pc.dim(`  ${err}`));
            }
          }
          process.exit(ExitCode.NOT_FOUND);
        }

        // Show warning for backups with integrity issues
        if (validation.status === 'warnings' && !useJson) {
          console.log(
            pc.yellow(
              `Warning: Backup has ${validation.corruptedFiles.length} file(s) with checksum mismatches.`
            )
          );
          console.log(pc.dim('Restore preflight will block checksum-mismatched files.\n'));
        }

        // Resolve target path if provided
        const targetPath = options.target
          ? expandPath(options.target)
          : customPath
            ? expandPath(customPath)
            : undefined;
        const projectsPath = options.projectsPath ? expandPath(options.projectsPath) : undefined;

        // Show progress if not JSON mode
        const onProgress = useJson ? undefined : displayProgress;

        // Perform restore
        const result = await restoreBackup({
          backupPath,
          targetPath,
          projectsPath,
          force: options.force ?? false,
          merge: options.merge ?? false,
          dryRun: options.dryRun ?? false,
          conflictStrategy,
          synthesizeTranscripts: options.synth ?? true,
          onProgress,
        });

        // Clear progress line
        if (!useJson) {
          process.stdout.write('\r'.padEnd(80) + '\r');
        }

        // Handle different error cases with appropriate exit codes
        if (!result.success) {
          if (result.dryRun) {
            if (useJson) {
              console.log(formatRestoreResultJson(result));
            } else {
              console.error(formatRestoreResult(result));
            }
            process.exit(ExitCode.IO_ERROR);
            return;
          }

          // T053: Target exists without --force
          if (result.error?.includes('already has Cursor data')) {
            if (useJson) {
              console.log(formatRestoreResultJson(result));
            } else {
              console.error(pc.red('Target directory already has Cursor data.'));
              console.error(pc.dim('Use --merge to import sessions, or --force to overwrite.'));
            }
            process.exit(ExitCode.IO_ERROR);
          }

          // T054: Integrity check failures
          if (result.error?.includes('integrity') || result.error?.includes('checksum')) {
            if (useJson) {
              console.log(formatRestoreResultJson(result));
            } else {
              console.error(pc.red('Backup integrity check failed.'));
              console.error(pc.dim(result.error));
            }
            process.exit(5); // Special exit code for integrity failures
          }

          // Generic error
          if (useJson) {
            console.log(formatRestoreResultJson(result));
          } else {
            console.error(formatRestoreResult(result));
          }
          process.exit(ExitCode.GENERAL_ERROR);
        }

        // Success
        if (useJson) {
          console.log(formatRestoreResultJson(result));
        } else {
          console.log(formatRestoreResult(result));
        }
      } catch (error) {
        handleError(error);
      }
    });
}
