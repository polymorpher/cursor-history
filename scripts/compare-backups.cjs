/**
 * Compare the contents of a full backup vs a filtered backup to find
 * what's different that might affect Cursor sidebar visibility.
 * 
 * Run: node scripts/compare-backups.cjs <full-backup.zip> <filtered-backup.zip>
 * Output: output/backup-comparison.txt
 */
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'output');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'backup-comparison.txt');
const lines = [];
function log(msg) { lines.push(msg); console.log(msg); }

async function analyzeZip(zipPath, label) {
  log('\n=== ' + label + ': ' + path.basename(zipPath) + ' ===');
  const data = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(data);

  const manifestFile = zip.file('manifest.json');
  if (manifestFile === null) {
    log('  NO MANIFEST');
    return null;
  }
  const manifest = JSON.parse(await manifestFile.async('string'));
  log('  Files: ' + manifest.files.length);
  log('  Sessions: ' + manifest.stats.sessionCount);
  log('  Workspaces: ' + manifest.stats.workspaceCount);

  // Categorize files
  const types = {};
  for (const f of manifest.files) {
    types[f.type] = (types[f.type] || 0) + 1;
  }
  log('  File types: ' + JSON.stringify(types));

  // Workspace DB contents
  const wsDbFiles = manifest.files.filter(f => f.type === 'workspace-db');
  log('  Workspace DBs: ' + wsDbFiles.length);

  // Transcript files
  const transcripts = manifest.files.filter(f => f.type === 'transcript');
  log('  Transcripts: ' + transcripts.length);
  const transcriptIds = new Set(transcripts.map(f => {
    const parts = f.path.split('/');
    return parts[parts.length - 2]; // session ID directory
  }));

  // For each workspace DB, check what's inside
  for (const wsDb of wsDbFiles) {
    const wsId = wsDb.path.match(/workspaceStorage\/([^/]+)/)?.[1] || 'unknown';
    log('\n  --- Workspace DB: ' + wsId + ' ---');
    log('    Size: ' + Math.round(wsDb.size / 1024) + ' KB');

    // Can't open SQLite from zip easily, just report the size
    // The key question is whether the DB is a full copy or filtered
  }

  // Global DB info
  const globalDb = manifest.files.find(f => f.type === 'global-db');
  if (globalDb) {
    log('\n  --- Global DB ---');
    log('    Size: ' + Math.round(globalDb.size / (1024 * 1024)) + ' MB');
  }

  return { manifest, transcriptIds };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node scripts/compare-backups.cjs <full-backup.zip> <filtered-backup.zip>');
    process.exit(1);
  }

  log('=== Backup Comparison ===');
  log('Date: ' + new Date().toISOString());

  const full = await analyzeZip(args[0], 'FULL');
  const filtered = await analyzeZip(args[1], 'FILTERED');

  if (full && filtered) {
    log('\n=== Differences ===');

    // Transcript differences
    const fullIds = full.transcriptIds;
    const filteredIds = filtered.transcriptIds;
    const onlyInFull = [...fullIds].filter(id => filteredIds.has(id) === false);
    const onlyInFiltered = [...filteredIds].filter(id => fullIds.has(id) === false);
    const inBoth = [...fullIds].filter(id => filteredIds.has(id));

    log('  Transcripts in both: ' + inBoth.length);
    log('  Only in full: ' + onlyInFull.length);
    log('  Only in filtered: ' + onlyInFiltered.length);

    // Workspace differences
    const fullWs = new Set(full.manifest.files.filter(f => f.type === 'workspace-db').map(f => f.path));
    const filteredWs = new Set(filtered.manifest.files.filter(f => f.type === 'workspace-db').map(f => f.path));
    const wsOnlyFull = [...fullWs].filter(p => filteredWs.has(p) === false);
    const wsOnlyFiltered = [...filteredWs].filter(p => fullWs.has(p) === false);

    log('  Workspace DBs only in full: ' + wsOnlyFull.length);
    if (wsOnlyFull.length > 0 && wsOnlyFull.length <= 10) {
      wsOnlyFull.forEach(p => log('    ' + p));
    }
    log('  Workspace DBs only in filtered: ' + wsOnlyFiltered.length);

    // Size comparison for shared workspace DBs
    const sharedWs = [...fullWs].filter(p => filteredWs.has(p));
    if (sharedWs.length > 0) {
      log('\n  Shared workspace DB sizes:');
      for (const wsPath of sharedWs) {
        const fullEntry = full.manifest.files.find(f => f.path === wsPath);
        const filteredEntry = filtered.manifest.files.find(f => f.path === wsPath);
        const sizeDiff = fullEntry.size - filteredEntry.size;
        log('    ' + wsPath.replace('workspaceStorage/', '').replace('/state.vscdb', ''));
        log('      Full: ' + Math.round(fullEntry.size / 1024) + ' KB, Filtered: ' + Math.round(filteredEntry.size / 1024) + ' KB, Diff: ' + Math.round(sizeDiff / 1024) + ' KB');
      }
    }
  }

  fs.writeFileSync(outFile, lines.join('\n') + '\n');
  log('\nOutput written to: ' + outFile);
}

main().catch(e => console.error(e));
