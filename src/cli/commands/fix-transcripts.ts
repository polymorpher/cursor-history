/**
 * Fix-transcripts command - synthesize missing agent transcript JSONL files
 *
 * Cursor only lists a chat in the @-mention "past chats" menu (and can only
 * resume it with the unified agent backend) if a transcript file exists at
 * ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl. Sessions
 * restored from another machine usually have their data in the database but
 * no transcript file. This command reconstructs the missing transcripts from
 * bubble data.
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { join } from 'node:path';
import { synthesizeMissingTranscripts } from '../../core/transcript.js';
import { handleError } from '../errors.js';
import { expandPath } from '../../lib/platform.js';

interface FixTranscriptsCommandOptions {
  dryRun?: boolean;
  json?: boolean;
  dataPath?: string;
}

/**
 * Register the fix-transcripts command
 */
export function registerFixTranscriptsCommand(program: Command): void {
  program
    .command('fix-transcripts')
    .description(
      'Create missing agent transcript files from chat data so sessions are taggable/continuable in Cursor'
    )
    .option('--dry-run', 'Report what would be created without writing files')
    .action(async (options: FixTranscriptsCommandOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as { json?: boolean; dataPath?: string };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;
      const dryRun = options.dryRun ?? false;

      try {
        // --data-path points at workspaceStorage; global DB lives beside it
        let globalDbPath: string | undefined;
        let workspaceStorageDir: string | undefined;
        if (customPath) {
          workspaceStorageDir = expandPath(customPath);
          globalDbPath = join(workspaceStorageDir, '..', 'globalStorage', 'state.vscdb');
        }

        if (!useJson) {
          console.log(
            dryRun
              ? 'Scanning for sessions missing agent transcripts (dry run)...'
              : 'Synthesizing missing agent transcripts...'
          );
        }

        const onProgress = useJson
          ? undefined
          : (processed: number, total: number) => {
              if (processed % 25 === 0 || processed === total) {
                process.stdout.write(`\r  Scanning sessions [${processed}/${total}]`.padEnd(60));
              }
            };

        const stats = await synthesizeMissingTranscripts({
          ...(globalDbPath && { globalDbPath }),
          ...(workspaceStorageDir && { workspaceStorageDir }),
          dryRun,
          onProgress,
        });

        if (!useJson) {
          process.stdout.write('\r'.padEnd(60) + '\r');
        }

        if (useJson) {
          console.log(JSON.stringify({ dryRun, ...stats }, null, 2));
          return;
        }

        const verb = dryRun ? 'Would create' : 'Created';
        console.log('');
        console.log(pc.green(`✓ ${verb} ${stats.created} transcript file(s)`));
        console.log(`  ${pc.bold('Already had transcripts:')} ${stats.skippedExisting}`);
        console.log(`  ${pc.bold('No workspace resolvable:')} ${stats.skippedNoWorkspace}`);
        console.log(`  ${pc.bold('Empty sessions skipped:')} ${stats.skippedEmpty}`);
        if (stats.errors.length > 0) {
          console.log('');
          console.log(pc.yellow(`  Errors (${stats.errors.length}):`));
          for (const err of stats.errors.slice(0, 10)) {
            console.log(`    ${pc.dim('•')} ${err}`);
          }
        }
        if (!dryRun && stats.created > 0) {
          console.log('');
          console.log(pc.dim('Restart Cursor to pick up the new transcripts.'));
        }
      } catch (error) {
        handleError(error);
      }
    });
}
