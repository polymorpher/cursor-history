import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { parse } from 'smol-toml';
import { expandPath, normalizePath, pathsEqual } from '../lib/platform.js';
import type { WorkspaceMappingProposal, WorkspacePathMapping } from './types.js';

export interface WorkspaceMappingConfigData {
  pathPrefixes: WorkspacePathMapping[];
  workspaces: WorkspacePathMapping[];
}

function normalizeMapping(mapping: WorkspacePathMapping): WorkspacePathMapping {
  return {
    source: normalizePath(expandPath(mapping.source)),
    target: normalizePath(expandPath(mapping.target)),
  };
}

function readMappingArray(value: unknown, section: string): WorkspacePathMapping[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`TOML section [[${section}]] must be an array of tables`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid [[${section}]] entry at index ${index}`);
    }
    const record = entry as Record<string, unknown>;
    const source = record['source'];
    const target = record['target'];
    if (
      typeof source !== 'string' ||
      source.length === 0 ||
      typeof target !== 'string' ||
      target.length === 0
    ) {
      throw new Error(`[[${section}]] entries require non-empty source and target strings`);
    }
    return normalizeMapping({ source, target });
  });
}

export function readWorkspaceMappingFile(filePath: string): WorkspaceMappingConfigData {
  const expandedPath = expandPath(filePath);
  const parsed = parse(readFileSync(expandedPath, 'utf-8')) as Record<string, unknown>;
  const version = parsed['version'];
  if (version !== undefined && version !== 1 && version !== 1n) {
    throw new Error(`Unsupported workspace mapping version: ${String(version)}`);
  }
  return {
    pathPrefixes: readMappingArray(parsed['path_prefix'], 'path_prefix'),
    workspaces: readMappingArray(parsed['workspace'], 'workspace'),
  };
}

export function parseWorkspaceMappingArgument(value: string): WorkspacePathMapping {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Expected SOURCE=TARGET mapping, received: ${value}`);
  }
  return normalizeMapping({
    source: value.slice(0, separator).trim(),
    target: value.slice(separator + 1).trim(),
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function writeWorkspaceMappingFile(
  filePath: string,
  backupPath: string,
  proposals: WorkspaceMappingProposal[]
): string {
  const expandedPath = expandPath(filePath);
  mkdirSync(dirname(expandedPath), { recursive: true });
  const lines: string[] = [
    '# cursor-history workspace mapping proposal',
    '# Review/edit this file, then pass it to restore with --workspace-map.',
    '# Supplying the file on a real restore is explicit approval of these mappings.',
    'version = 1',
    `backup = ${tomlString(backupPath)}`,
    '',
  ];

  for (const proposal of proposals) {
    lines.push('[[workspace]]');
    lines.push(`source = ${tomlString(proposal.source)}`);
    lines.push(`target = ${tomlString(proposal.target)}`);
    lines.push(`confidence = ${tomlString(proposal.confidence)}`);
    lines.push(`reason = ${tomlString(proposal.reason)}`);
    lines.push(`session_ids = [${proposal.sessionIds.map(tomlString).join(', ')}]`);
    lines.push('');
  }
  writeFileSync(expandedPath, `${lines.join('\n').trimEnd()}\n`, 'utf-8');
  return expandedPath;
}

export class WorkspacePathMapper {
  private readonly exact = new Map<string, string>();
  private readonly prefixes: WorkspacePathMapping[];

  constructor(config: WorkspaceMappingConfigData) {
    for (const mapping of config.workspaces.map(normalizeMapping)) {
      this.exact.set(mapping.source, mapping.target);
    }
    this.prefixes = config.pathPrefixes
      .map(normalizeMapping)
      .sort((left, right) => right.source.length - left.source.length);
  }

  resolve(sourcePath: string): string | null {
    const normalized = normalizePath(sourcePath);
    const exact = this.exact.get(normalized);
    if (exact) return exact;
    for (const [source, target] of [...this.exact.entries()].sort(
      (left, right) => right[0].length - left[0].length
    )) {
      if (normalized.startsWith(`${source}/`)) {
        return `${target}${normalized.slice(source.length)}`;
      }
    }
    for (const mapping of this.prefixes) {
      if (normalized === mapping.source || normalized.startsWith(`${mapping.source}/`)) {
        return `${mapping.target}${normalized.slice(mapping.source.length)}`;
      }
    }
    return null;
  }

  rewriteString(value: string): string {
    const fileUriPrefix = value.startsWith('file://') ? 'file://' : '';
    const candidate = fileUriPrefix ? value.slice(fileUriPrefix.length) : value;
    const mapped = this.resolve(candidate);
    if (mapped) return `${fileUriPrefix}${mapped}`;

    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(value) as unknown;
        const rewritten = rewriteMappedPaths(parsed, this);
        if (rewritten.changed) return JSON.stringify(rewritten.value);
      } catch {
        // Preserve non-JSON strings.
      }
    }
    return value;
  }
}

export function rewriteMappedPaths(
  value: unknown,
  mapper: WorkspacePathMapper
): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const rewritten = mapper.rewriteString(value);
    return { value: rewritten, changed: rewritten !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((entry) => {
      const rewritten = rewriteMappedPaths(entry, mapper);
      changed ||= rewritten.changed;
      return rewritten.value;
    });
    return { value: result, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const rewritten = rewriteMappedPaths(entry, mapper);
      changed ||= rewritten.changed;
      result[key] = rewritten.value;
    }
    return { value: result, changed };
  }
  return { value, changed: false };
}

function homeRelativePath(path: string): string | null {
  const match = normalizePath(path).match(/^\/Users\/[^/]+\/(.+)$/);
  return match?.[1] ?? null;
}

export function proposeWorkspaceMappings(
  sourceSessions: Map<string, Set<string>>,
  localWorkspacePaths: string[],
  approved: WorkspaceMappingConfigData,
  autoMap: boolean
): {
  proposals: WorkspaceMappingProposal[];
  unmapped: string[];
} {
  const mapper = new WorkspacePathMapper(approved);
  const localPaths = localWorkspacePaths.map(normalizePath);
  const proposals: WorkspaceMappingProposal[] = [];
  const unmapped: string[] = [];

  for (const [source, sessionIds] of [...sourceSessions.entries()].sort()) {
    const normalizedSource = normalizePath(source);
    const explicit = mapper.resolve(normalizedSource);
    if (explicit) {
      proposals.push({
        source: normalizedSource,
        target: explicit,
        confidence: 'explicit',
        reason: 'approved mapping configuration',
        sessionIds: [...sessionIds].sort(),
      });
      continue;
    }
    const exact = localPaths.find((candidate) => pathsEqual(candidate, normalizedSource));
    if (exact) {
      proposals.push({
        source: normalizedSource,
        target: exact,
        confidence: 'exact',
        reason: 'exact local workspace path',
        sessionIds: [...sessionIds].sort(),
      });
      continue;
    }
    if (existsSync(normalizedSource)) {
      proposals.push({
        source: normalizedSource,
        target: normalizedSource,
        confidence: 'exact',
        reason: 'source workspace path exists locally',
        sessionIds: [...sessionIds].sort(),
      });
      continue;
    }
    if (!autoMap) {
      unmapped.push(normalizedSource);
      continue;
    }

    const relative = homeRelativePath(normalizedSource);
    const homeCandidate = relative ? normalizePath(`${homedir()}/${relative}`) : null;
    if (
      homeCandidate &&
      (localPaths.some((candidate) => pathsEqual(candidate, homeCandidate)) ||
        existsSync(homeCandidate))
    ) {
      proposals.push({
        source: normalizedSource,
        target: homeCandidate,
        confidence: 'high',
        reason: 'same path relative to the destination user home',
        sessionIds: [...sessionIds].sort(),
      });
      continue;
    }

    const suffixMatches = relative
      ? localPaths.filter((candidate) => candidate.endsWith(`/${relative}`))
      : [];
    if (suffixMatches.length === 1) {
      proposals.push({
        source: normalizedSource,
        target: suffixMatches[0]!,
        confidence: 'high',
        reason: 'unique matching path suffix',
        sessionIds: [...sessionIds].sort(),
      });
      continue;
    }

    const sourceName = basename(normalizedSource);
    const basenameMatches = localPaths.filter((candidate) => basename(candidate) === sourceName);
    if (basenameMatches.length === 1) {
      proposals.push({
        source: normalizedSource,
        target: basenameMatches[0]!,
        confidence: 'medium',
        reason: 'unique matching workspace basename',
        sessionIds: [...sessionIds].sort(),
      });
      continue;
    }
    unmapped.push(normalizedSource);
  }
  return { proposals, unmapped };
}
