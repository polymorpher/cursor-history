/**
 * Tests for agent transcript synthesis (src/core/transcript.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  workspacePathToProjectSlug,
  workspaceIdentifierToPath,
  bubbleToTranscriptLine,
  synthesizeTranscript,
} from '../../src/core/transcript.js';

describe('workspacePathToProjectSlug', () => {
  it('converts a plain folder path', () => {
    expect(workspacePathToProjectSlug('/Users/polymorpher/git/cursor-history')).toBe(
      'Users-polymorpher-git-cursor-history'
    );
  });

  it('strips file:// prefix', () => {
    expect(workspacePathToProjectSlug('file:///Users/me/git/proj')).toBe('Users-me-git-proj');
  });

  it('converts .code-workspace file paths', () => {
    expect(workspacePathToProjectSlug('/Users/polymorpher/lp-code/lp-projects.code-workspace')).toBe(
      'Users-polymorpher-lp-code-lp-projects-code-workspace'
    );
  });

  it('replaces underscores and other non-alphanumerics like Cursor does', () => {
    expect(workspacePathToProjectSlug('/var/folders/79/9_6l19w13wx_d5/T')).toBe(
      'var-folders-79-9-6l19w13wx-d5-T'
    );
    expect(workspacePathToProjectSlug('/Users/me/my project (v2)')).toBe('Users-me-my-project-v2');
  });

  it('collapses consecutive separators and trims edges', () => {
    expect(workspacePathToProjectSlug('//Users//me..proj//')).toBe('Users-me-proj');
  });

  it('decodes percent-encoded URIs', () => {
    expect(workspacePathToProjectSlug('file:///Users/me/my%20project')).toBe('Users-me-my-project');
  });
});

describe('workspaceIdentifierToPath', () => {
  it('reads string uri', () => {
    expect(workspaceIdentifierToPath({ uri: 'file:///Users/me/proj' })).toBe(
      'file:///Users/me/proj'
    );
  });

  it('reads object uri fsPath first', () => {
    expect(
      workspaceIdentifierToPath({
        uri: { fsPath: '/Users/me/proj', path: '/Users/me/proj', external: 'file:///Users/me/proj' },
      })
    ).toBe('/Users/me/proj');
  });

  it('falls back to configPath', () => {
    expect(workspaceIdentifierToPath({ configPath: { path: '/Users/me/ws.code-workspace' } })).toBe(
      '/Users/me/ws.code-workspace'
    );
  });

  it('returns null for missing identifier', () => {
    expect(workspaceIdentifierToPath(undefined)).toBeNull();
    expect(workspaceIdentifierToPath({})).toBeNull();
  });
});

describe('bubbleToTranscriptLine', () => {
  it('wraps user text in user_query tags', () => {
    const line = bubbleToTranscriptLine({ type: 1, text: 'hello world' });
    expect(line).not.toBeNull();
    const parsed = JSON.parse(line!) as {
      role: string;
      message: { content: Array<{ type: string; text?: string }> };
    };
    expect(parsed.role).toBe('user');
    expect(parsed.message.content[0]!.type).toBe('text');
    expect(parsed.message.content[0]!.text).toContain('<user_query>');
    expect(parsed.message.content[0]!.text).toContain('hello world');
  });

  it('emits assistant text without wrapping', () => {
    const line = bubbleToTranscriptLine({ type: 2, text: 'The answer is 42.' });
    const parsed = JSON.parse(line!) as {
      role: string;
      message: { content: Array<{ type: string; text?: string }> };
    };
    expect(parsed.role).toBe('assistant');
    expect(parsed.message.content[0]!.text).toBe('The answer is 42.');
  });

  it('emits tool_use blocks with parsed params', () => {
    const line = bubbleToTranscriptLine({
      type: 2,
      toolFormerData: { name: 'read_file', params: '{"targetFile":"/a/b.ts"}' },
    });
    const parsed = JSON.parse(line!) as {
      role: string;
      message: { content: Array<{ type: string; name?: string; input?: Record<string, string> }> };
    };
    expect(parsed.role).toBe('assistant');
    expect(parsed.message.content[0]!.type).toBe('tool_use');
    expect(parsed.message.content[0]!.name).toBe('read_file');
    expect(parsed.message.content[0]!.input).toEqual({ targetFile: '/a/b.ts' });
  });

  it('combines text and tool_use in one line', () => {
    const line = bubbleToTranscriptLine({
      type: 2,
      text: 'Reading the file.',
      toolFormerData: { name: 'read_file', params: '{"path":"/x"}' },
    });
    const parsed = JSON.parse(line!) as {
      message: { content: Array<{ type: string }> };
    };
    expect(parsed.message.content).toHaveLength(2);
    expect(parsed.message.content[0]!.type).toBe('text');
    expect(parsed.message.content[1]!.type).toBe('tool_use');
  });

  it('preserves unparseable params as _raw', () => {
    const line = bubbleToTranscriptLine({
      type: 2,
      toolFormerData: { name: 'run', rawArgs: 'not-json' },
    });
    const parsed = JSON.parse(line!) as {
      message: { content: Array<{ input?: { _raw?: string } }> };
    };
    expect(parsed.message.content[0]!.input).toEqual({ _raw: 'not-json' });
  });

  it('returns null for empty bubbles', () => {
    expect(bubbleToTranscriptLine({ type: 2, text: '' })).toBeNull();
    expect(bubbleToTranscriptLine({ type: 2 })).toBeNull();
    expect(bubbleToTranscriptLine({ type: 1, text: '   ' })).toBeNull();
  });
});

describe('synthesizeTranscript', () => {
  const bubbles = [
    { bubbleId: 'b3', data: { type: 2, text: 'Done.' } },
    { bubbleId: 'b1', data: { type: 1, text: 'Do a thing' } },
    { bubbleId: 'b2', data: { type: 2, toolFormerData: { name: 'shell', params: '{"cmd":"ls"}' } } },
  ];

  it('orders bubbles by fullConversationHeadersOnly', () => {
    const jsonl = synthesizeTranscript(
      {
        fullConversationHeadersOnly: [
          { bubbleId: 'b1', type: 1 },
          { bubbleId: 'b2', type: 2 },
          { bubbleId: 'b3', type: 2 },
        ],
      },
      bubbles
    );
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]!) as { role: string };
    const last = JSON.parse(lines[2]!) as {
      role: string;
      message: { content: Array<{ text?: string }> };
    };
    expect(first.role).toBe('user');
    expect(last.message.content[0]!.text).toBe('Done.');
  });

  it('appends bubbles missing from headers in original order', () => {
    const jsonl = synthesizeTranscript(
      { fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }] },
      bubbles
    );
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(3);
    // b1 first (from headers), then b3 and b2 in given order
    const second = JSON.parse(lines[1]!) as { message: { content: Array<{ text?: string }> } };
    expect(second.message.content[0]!.text).toBe('Done.');
  });

  it('falls back to given order without headers', () => {
    const jsonl = synthesizeTranscript(null, bubbles);
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]!) as { message: { content: Array<{ text?: string }> } };
    expect(first.message.content[0]!.text).toBe('Done.');
  });

  it('returns empty string when nothing is representable', () => {
    expect(synthesizeTranscript(null, [{ bubbleId: 'x', data: { type: 2, text: '' } }])).toBe('');
  });

  it('produces valid JSONL for every line', () => {
    const jsonl = synthesizeTranscript(null, bubbles);
    for (const line of jsonl.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
