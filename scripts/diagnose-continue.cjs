/**
 * Diagnose why restored sessions can't be continued or tagged as context.
 * Checks every session in composer.composerHeaders for the artifacts Cursor
 * needs: composerData, bubbles, and the agent transcript JSONL.
 * Run: node scripts/diagnose-continue.cjs
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const globalDbPath = path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
const projectsDir = path.join(home, '.cursor', 'projects');

function uriToSlug(uri) {
  // Mirror of workspaceUriToProjectSlug in src/core/backup.ts
  return uri.replace(/^file:\/\//, '').replace(/^\//, '').replace(/[/.]/g, '-');
}

const db = new Database(globalDbPath, { readonly: true });
const chRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'").get();
if (!chRow) { console.log('no composerHeaders'); process.exit(1); }
const headers = JSON.parse(chRow.value).allComposers || [];
console.log('composerHeaders total:', headers.length);

const bubbleCountStmt = db.prepare("SELECT COUNT(*) as c FROM cursorDiskKV WHERE key LIKE 'bubbleId:' || ? || ':%'");
const cdStmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = 'composerData:' || ?");

const groups = {}; // slug -> {total, noTranscript, noBubbles, noComposerData, samples}
let noWsId = 0;

for (const h of headers) {
  const id = h.composerId;
  if (!id) continue;
  const wsUri = h.workspaceIdentifier?.uri;
  let slug = null;
  if (typeof wsUri === 'string') slug = uriToSlug(wsUri);
  else if (wsUri && wsUri.path) slug = uriToSlug('file://' + wsUri.path);
  else if (wsUri && wsUri.fsPath) slug = uriToSlug('file://' + wsUri.fsPath);
  if (!slug) { noWsId++; continue; }

  if (!groups[slug]) groups[slug] = { total: 0, noTranscript: 0, noBubbles: 0, noComposerData: 0, samplesMissing: [], samplesOk: [] };
  const g = groups[slug];
  g.total++;

  const transcriptPath = path.join(projectsDir, slug, 'agent-transcripts', id, id + '.jsonl');
  const hasTranscript = fs.existsSync(transcriptPath);
  const bubbles = bubbleCountStmt.get(id).c;
  const hasCd = !!cdStmt.get(id);

  if (!hasTranscript) g.noTranscript++;
  if (bubbles === 0) g.noBubbles++;
  if (!hasCd) g.noComposerData++;

  const info = { id, name: (h.name || 'N/A').slice(0, 40), last: h.lastUpdatedAt ? new Date(h.lastUpdatedAt).toISOString().slice(0, 10) : '?', bubbles, hasTranscript, hasCd };
  if (!hasTranscript && g.samplesMissing.length < 5) g.samplesMissing.push(info);
  if (hasTranscript && g.samplesOk.length < 2) g.samplesOk.push(info);
}

console.log('headers without workspaceIdentifier uri:', noWsId);
for (const [slug, g] of Object.entries(groups)) {
  console.log(`\n${slug}: total=${g.total} noTranscript=${g.noTranscript} noBubbles=${g.noBubbles} noComposerData=${g.noComposerData}`);
  for (const s of g.samplesMissing) console.log('   MISSING-T:', JSON.stringify(s));
  for (const s of g.samplesOk) console.log('   HAS-T:    ', JSON.stringify(s));
}

// Also: transcripts on disk not referenced by any header (orphans)
console.log('\n=== Transcript dirs on disk vs headers ===');
const headerIds = new Set(headers.map((h) => h.composerId));
for (const proj of fs.readdirSync(projectsDir)) {
  const tDir = path.join(projectsDir, proj, 'agent-transcripts');
  if (!fs.existsSync(tDir)) continue;
  const dirs = fs.readdirSync(tDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (dirs.length === 0) continue;
  const notInHeaders = dirs.filter((d) => !headerIds.has(d.name)).length;
  console.log(`${proj}: transcriptDirs=${dirs.length} notInHeaders=${notInHeaders}`);
}
db.close();
