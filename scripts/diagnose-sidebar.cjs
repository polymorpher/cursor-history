/**
 * Diagnose why restored sessions don't appear in Cursor's sidebar.
 * Run: node scripts/diagnose-sidebar.cjs
 * Output: output/sidebar-diagnosis.txt
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const outDir = path.join(__dirname, '..', 'output');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'sidebar-diagnosis.txt');
const lines = [];
function log(msg) { lines.push(msg); console.log(msg); }

const cursorApp = path.join(home, 'Library/Application Support/Cursor');
const cursorDot = path.join(home, '.cursor');
const wsStorageDir = path.join(cursorApp, 'User/workspaceStorage');
const globalDbPath = path.join(cursorApp, 'User/globalStorage/state.vscdb');
const projectsDir = path.join(cursorDot, 'projects');

log('=== Sidebar Diagnosis ===');
log('Date: ' + new Date().toISOString());
log('Machine: ' + os.hostname());
log('');

// 1. Find all workspaces with their hashes and paths
log('=== 1. Workspaces ===');
const workspaces = [];
if (fs.existsSync(wsStorageDir)) {
  for (const entry of fs.readdirSync(wsStorageDir, { withFileTypes: true })) {
    if (entry.isDirectory() === false) continue;
    const wsJson = path.join(wsStorageDir, entry.name, 'workspace.json');
    if (fs.existsSync(wsJson) === false) continue;
    const data = JSON.parse(fs.readFileSync(wsJson, 'utf-8'));
    const wsPath = data.workspace || data.folder || '';
    if (wsPath.includes('lp-') || wsPath.includes('toggl') || wsPath.includes('cursor-history')) {
      workspaces.push({ hash: entry.name, path: wsPath });
    }
  }
}
workspaces.forEach(w => log('  ' + w.hash + ' -> ' + w.path));

// 2. For each workspace: compare pane keys, viewContainersWorkspaceState, transcripts
for (const ws of workspaces) {
  const dbPath = path.join(wsStorageDir, ws.hash, 'state.vscdb');
  if (fs.existsSync(dbPath) === false) continue;

  log('\n=== 2. Workspace: ' + ws.path + ' ===');
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    log('  ERROR opening DB: ' + e.message);
    continue;
  }

  try {

  // composer.composerData
  const cdRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
  if (cdRow) {
    const cd = JSON.parse(cdRow.value);
    log('  composerData keys: ' + Object.keys(cd).join(', '));
    log('  hasMigratedComposerData: ' + cd.hasMigratedComposerData);
    if (cd.allComposers) log('  allComposers count: ' + cd.allComposers.length);
    log('  selectedComposerIds: ' + JSON.stringify(cd.selectedComposerIds));
  }

  // Pane keys
  const paneRows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'workbench.panel.composerChatViewPane.%'").all();
  const paneSessionIds = new Set();
  const paneIdToSessions = new Map();
  for (const r of paneRows) {
    const paneId = r.key.replace('workbench.panel.composerChatViewPane.', '');
    const v = JSON.parse(r.value);
    const sessions = [];
    for (const k of Object.keys(v)) {
      const m = k.match(/^workbench\.panel\.aichat\.view\.(.+)$/);
      if (m) {
        paneSessionIds.add(m[1]);
        sessions.push(m[1]);
      }
    }
    paneIdToSessions.set(paneId, sessions);
  }
  log('  Pane keys: ' + paneRows.length);
  log('  Unique session IDs in panes: ' + paneSessionIds.size);

  // viewContainersWorkspaceState
  const vcsRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'workbench.auxiliarybar.viewContainersWorkspaceState'").get();
  let vcsContainerIds = new Set();
  if (vcsRow) {
    const vcs = JSON.parse(vcsRow.value);
    log('  viewContainersWorkspaceState entries: ' + vcs.length);
    for (const entry of vcs) {
      vcsContainerIds.add(entry.id);
    }
  } else {
    log('  viewContainersWorkspaceState: MISSING');
  }

  // numberOfVisibleViews keys
  const nvvRows = db.prepare("SELECT key FROM ItemTable WHERE key LIKE 'workbench.panel.aichat.%.numberOfVisibleViews'").all();
  log('  numberOfVisibleViews keys: ' + nvvRows.length);

  // Cross-reference: pane IDs that are NOT in viewContainersWorkspaceState
  let missingFromVcs = 0;
  let inVcs = 0;
  for (const [paneId] of paneIdToSessions) {
    const containerId = 'workbench.panel.aichat.' + paneId;
    if (vcsContainerIds.has(containerId)) {
      inVcs++;
    } else {
      missingFromVcs++;
    }
  }
  log('  Panes registered in viewContainersWorkspaceState: ' + inVcs);
  log('  Panes MISSING from viewContainersWorkspaceState: ' + missingFromVcs);

  // Check transcripts
  const slug = (ws.path.replace(/^file:\/\//, '')).replace(/^\//, '').replace(/[/.]/g, '-');
  const transcriptDir = path.join(projectsDir, slug, 'agent-transcripts');
  let transcriptCount = 0;
  let transcriptSessionIds = new Set();
  if (fs.existsSync(transcriptDir)) {
    for (const e of fs.readdirSync(transcriptDir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        transcriptCount++;
        transcriptSessionIds.add(e.name);
      }
    }
  }
  log('  Transcripts: ' + transcriptCount);

  // Sessions in panes but no transcript
  let paneNoTranscript = 0;
  let transcriptNoPane = 0;
  for (const sid of paneSessionIds) {
    if (transcriptSessionIds.has(sid) === false) paneNoTranscript++;
  }
  for (const sid of transcriptSessionIds) {
    if (paneSessionIds.has(sid) === false) transcriptNoPane++;
  }
  log('  In panes but no transcript: ' + paneNoTranscript);
  log('  In transcripts but no pane: ' + transcriptNoPane);

  // Sample: pick a session that has transcript but is NOT in a pane (likely restored)
  const restoredOnly = [...transcriptSessionIds].filter(sid => paneSessionIds.has(sid) === false);
  if (restoredOnly.length > 0) {
    const sampleId = restoredOnly[0];
    log('\n  --- Sample restored-only session: ' + sampleId + ' ---');
    log('    Has transcript: true');
    log('    Has pane key: false');

    // Check global DB
    const globalDb = new Database(globalDbPath, { readonly: true });
    const gRow = globalDb.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get('composerData:' + sampleId);
    if (gRow) {
      const gd = JSON.parse(gRow.value);
      log('    Global composerData: YES (name: ' + (gd.name || 'N/A') + ')');
      log('    workspaceIdentifier: ' + (gd.workspaceIdentifier ? JSON.stringify(gd.workspaceIdentifier).slice(0, 100) : 'NONE'));
    } else {
      log('    Global composerData: NO');
    }
    const bubbles = globalDb.prepare('SELECT COUNT(*) as c FROM cursorDiskKV WHERE key LIKE ?').get('bubbleId:' + sampleId + ':%');
    log('    Bubbles: ' + bubbles.c);
    globalDb.close();
  }

  // Sample: pick a LOCAL session that IS visible (has pane key, from this machine)
  const localWithPane = [...paneSessionIds].slice(0, 1);
  if (localWithPane.length > 0) {
    const sampleId = localWithPane[0];
    log('\n  --- Sample local session with pane: ' + sampleId + ' ---');
    log('    Has transcript: ' + transcriptSessionIds.has(sampleId));

    // Is it in viewContainersWorkspaceState?
    let foundInVcs = false;
    for (const [paneId, sessions] of paneIdToSessions) {
      if (sessions.includes(sampleId)) {
        const containerId = 'workbench.panel.aichat.' + paneId;
        foundInVcs = vcsContainerIds.has(containerId);
        log('    Pane ID: ' + paneId + ', in VCS: ' + foundInVcs);
      }
    }

    const globalDb = new Database(globalDbPath, { readonly: true });
    const gRow = globalDb.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get('composerData:' + sampleId);
    if (gRow) {
      const gd = JSON.parse(gRow.value);
      log('    Global composerData: YES (name: ' + (gd.name || 'N/A') + ')');
    }
    globalDb.close();
  }

  } catch (e) {
    log('  ERROR querying DB: ' + e.message);
  } finally {
    db.close();
  }
}

// 3. Global DB stats
log('\n=== 3. Global DB (cursorDiskKV) ===');
if (fs.existsSync(globalDbPath)) {
  const db = new Database(globalDbPath, { readonly: true });
  const total = db.prepare("SELECT COUNT(*) as c FROM cursorDiskKV WHERE key LIKE 'composerData:%'").get();
  log('  Total composerData entries: ' + total.c);

  const recent = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' ORDER BY rowid DESC LIMIT 5").all();
  log('  Most recent 5:');
  for (const r of recent) {
    const d = JSON.parse(r.value);
    const created = typeof d.createdAt === 'number' ? new Date(d.createdAt).toISOString() : String(d.createdAt);
    log('    ' + r.key.replace('composerData:', '') + ' | ' + (d.name || 'N/A').slice(0, 40) + ' | ' + created);
  }
  db.close();
}

// 3b. Global ItemTable (separate from cursorDiskKV)
log('\n=== 3b. Global DB (ItemTable) ===');
if (fs.existsSync(globalDbPath)) {
  const db = new Database(globalDbPath, { readonly: true });

  // List all keys and their value sizes
  const allKeys = db.prepare('SELECT key, length(value) as len FROM ItemTable ORDER BY key').all();
  log('  Total ItemTable keys: ' + allKeys.length);
  for (const k of allKeys) {
    log('    ' + k.key + ' (' + k.len + ' chars)');
  }

  // composer.composerHeaders -- suspected Cursor 3.0 sidebar index
  const chRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'").get();
  if (chRow) {
    const ch = JSON.parse(chRow.value);
    const topKeys = Object.keys(ch);
    log('\n  composer.composerHeaders keys: ' + topKeys.join(', '));
    if (ch.allComposers) {
      log('  composer.composerHeaders.allComposers count: ' + ch.allComposers.length);
      // Show first 3 entries to understand structure
      for (let i = 0; i < Math.min(3, ch.allComposers.length); i++) {
        const entry = ch.allComposers[i];
        const keys = Object.keys(entry);
        log('    [' + i + '] keys: ' + keys.join(', '));
        log('    [' + i + '] composerId: ' + (entry.composerId || 'NONE'));
        log('    [' + i + '] name: ' + (entry.name || 'N/A').slice(0, 50));
        if (entry.workspaceId) log('    [' + i + '] workspaceId: ' + entry.workspaceId);
        if (entry.lastUpdatedAt) log('    [' + i + '] lastUpdatedAt: ' + new Date(entry.lastUpdatedAt).toISOString());
      }

      // Cross-reference with workspace pane sessions
      const headerIds = new Set(ch.allComposers.map(h => h.composerId).filter(Boolean));

      // Group composerHeaders by workspaceIdentifier.id to see per-workspace distribution
      const headersByWs = {};
      for (const h of ch.allComposers) {
        const wsId = h.workspaceIdentifier?.id || 'NO_WORKSPACE';
        if (!headersByWs[wsId]) headersByWs[wsId] = [];
        headersByWs[wsId].push(h);
      }
      log('\n  composerHeaders per workspace:');
      for (const [wsId, headers] of Object.entries(headersByWs)) {
        const wsMatch = workspaces.find(w => w.hash === wsId);
        const label = wsMatch ? wsMatch.path.replace('file://', '').replace(home, '~') : wsId;
        log('    ' + label + ': ' + headers.length + ' sessions');
      }

      // Cross-reference pane keys vs composerHeaders
      log('\n  Pane vs composerHeaders cross-reference:');
      for (const ws of workspaces) {
        const dbPath = path.join(wsStorageDir, ws.hash, 'state.vscdb');
        if (fs.existsSync(dbPath) === false) continue;
        try {
          const wsDb = new Database(dbPath, { readonly: true });
          const paneRows = wsDb.prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'workbench.panel.composerChatViewPane.%'").all();
          const paneSessions = new Set();
          for (const r of paneRows) {
            const v = JSON.parse(r.value);
            for (const k of Object.keys(v)) {
              const m = k.match(/^workbench\.panel\.aichat\.view\.(.+)$/);
              if (m) paneSessions.add(m[1]);
            }
          }
          const wsHeaderCount = (headersByWs[ws.hash] || []).length;
          const inHeaderAndPane = [...paneSessions].filter(id => headerIds.has(id)).length;
          const inPaneNotHeader = [...paneSessions].filter(id => headerIds.has(id) === false).length;
          const shortPath = ws.path.replace('file://', '').replace(home, '~');
          log('    ' + shortPath + ': pane=' + paneSessions.size + ' headers=' + wsHeaderCount + ' inBoth=' + inHeaderAndPane + ' paneOnly=' + inPaneNotHeader);
          wsDb.close();
        } catch (e) {
          const shortPath = ws.path.replace('file://', '').replace(home, '~');
          log('    ' + shortPath + ': ERROR - ' + e.message);
        }
      }
    }
  } else {
    log('\n  composer.composerHeaders: NOT FOUND');
  }

  // composer.composerData in global (if any)
  const gcdRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
  if (gcdRow) {
    const gcd = JSON.parse(gcdRow.value);
    log('\n  Global composer.composerData keys: ' + Object.keys(gcd).join(', '));
    if (gcd.allComposers) log('  Global composer.composerData.allComposers count: ' + gcd.allComposers.length);
  }

  // WAL state
  const walPath = globalDbPath + '-wal';
  const shmPath = globalDbPath + '-shm';
  log('\n  WAL file exists: ' + fs.existsSync(walPath) + (fs.existsSync(walPath) ? ' (' + Math.round(fs.statSync(walPath).size / 1024) + ' KB)' : ''));
  log('  SHM file exists: ' + fs.existsSync(shmPath));

  db.close();
}

// 4. Chromium storage
log('\n=== 4. Chromium Storage ===');
for (const layer of ['Session Storage', 'Local Storage', 'IndexedDB']) {
  const dir = path.join(cursorApp, layer);
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    const totalSize = entries.reduce((sum, f) => {
      try { return sum + fs.statSync(path.join(dir, f)).size; } catch { return sum; }
    }, 0);
    log('  ' + layer + ': ' + entries.length + ' files, ' + Math.round(totalSize / 1024) + ' KB');
  } else {
    log('  ' + layer + ': NOT FOUND');
  }
}

// Write output
fs.writeFileSync(outFile, lines.join('\n') + '\n');
log('\nOutput written to: ' + outFile);
