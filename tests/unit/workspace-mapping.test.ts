import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspacePathMapper,
  parseWorkspaceMappingArgument,
  proposeWorkspaceMappings,
  readWorkspaceMappingFile,
  rewriteMappedPaths,
  writeWorkspaceMappingFile,
} from '../../src/core/workspace-mapping.js';

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cursor-history-mapping-'));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('workspace mapping configuration', () => {
  it('parses CLI SOURCE=TARGET mappings', () => {
    expect(
      parseWorkspaceMappingArgument('/Users/source/git/project=/Users/target/git/project')
    ).toEqual({
      source: '/Users/source/git/project',
      target: '/Users/target/git/project',
    });
  });

  it('writes and reads a TOML proposal', () => {
    const path = join(testRoot, 'mapping.toml');
    writeWorkspaceMappingFile(path, '/tmp/backup.zip', [
      {
        source: '/Users/source/git/project',
        target: '/Users/target/git/project',
        confidence: 'high',
        reason: 'same home-relative path',
        sessionIds: ['session-1'],
      },
    ]);

    expect(readWorkspaceMappingFile(path)).toEqual({
      pathPrefixes: [],
      workspaces: [
        {
          source: '/Users/source/git/project',
          target: '/Users/target/git/project',
        },
      ],
    });
  });

  it('applies exact and prefix mappings recursively', () => {
    const mapper = new WorkspacePathMapper({
      pathPrefixes: [{ source: '/Users/source', target: '/Users/target' }],
      workspaces: [
        {
          source: '/special/source',
          target: '/special/target',
        },
      ],
    });
    const rewritten = rewriteMappedPaths(
      {
        uri: 'file:///Users/source/git/project',
        params: '{"targetFile":"/Users/source/git/project/file.ts"}',
        exact: '/special/source/file.ts',
      },
      mapper
    );

    expect(rewritten).toEqual({
      changed: true,
      value: {
        uri: 'file:///Users/target/git/project',
        params: '{"targetFile":"/Users/target/git/project/file.ts"}',
        exact: '/special/target/file.ts',
      },
    });
  });

  it('proposes a unique home-relative workspace mapping', () => {
    const sourceSessions = new Map([['/Users/source/git/project', new Set(['session-1'])]]);
    const result = proposeWorkspaceMappings(
      sourceSessions,
      ['/Users/target/git/project'],
      { pathPrefixes: [], workspaces: [] },
      true
    );

    expect(result.unmapped).toEqual([]);
    expect(result.proposals).toEqual([
      expect.objectContaining({
        source: '/Users/source/git/project',
        target: '/Users/target/git/project',
        confidence: 'high',
      }),
    ]);
  });
});
