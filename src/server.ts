import express from 'express';
import path from 'path';
import fs from 'fs';
import { parseServers, loadKeyAliases, saveKeyAlias, resolveKeyAlias, reorderKeys, saveKeyOrder, getServersFile, listProfiles } from './config.js';
import { fetchServerData, addKey, removeKey } from './ssh.js';
import type { AppData, PendingAction, KeyAlias, KeySeparatorEntry, ServerData } from './types.js';

const app = express();
app.use(express.json());
app.use(express.static(path.resolve('public')));

// Parse CLI args
const portArg = process.argv.find((_, i, a) => a[i - 1] === '--port');
const PORT = parseInt(portArg || process.env.PORT || '3000', 10);

// Settings
const SETTINGS_FILE = path.resolve('settings.json');

function loadSettings(): Record<string, unknown> {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveSettings(settings: Record<string, unknown>): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

// GET /api/settings
app.get('/api/settings', (_req, res) => {
  res.json(loadSettings());
});

// POST /api/settings — merge patch into existing settings
app.post('/api/settings', (req, res) => {
  try {
    const current = loadSettings();
    const updated = { ...current, ...req.body };
    saveSettings(updated);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

let cachedServerData: Record<string, ServerData> = {};

// GET /api/profiles — list available server profiles
app.get('/api/profiles', (_req, res) => {
  res.json(listProfiles());
});

async function loadAllData(): Promise<AppData> {
  const serversFile = getServersFile();
  const servers = parseServers(serversFile);
  const keyAliases = loadKeyAliases();

  console.log(`\n[load] Fetching ${servers.length} server(s): ${servers.map(s => s.alias).join(', ')}`);

  // Fetch from all servers in parallel
  const results = await Promise.allSettled(
    servers.map(s => fetchServerData(s))
  );

  cachedServerData = {};

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const sd = result.value;
      cachedServerData[sd.config.alias] = sd;
      if (sd.error) {
        console.error(`[load] ${sd.config.alias}: ERROR - ${sd.error}`);
      } else {
        console.log(`[load] ${sd.config.alias}: OK, ${Object.keys(sd.keys).length} key(s)`);
      }
    } else {
      console.error(`[load] server fetch rejected: ${result.reason}`);
    }
  }

  // Build keys list: keys.txt order (with separators), then unknown server keys appended
  const namedFps = new Set(
    keyAliases.filter(e => !e.isSeparator).map(e => (e as KeyAlias).fingerprint)
  );
  const unknownFps: string[] = [];
  for (const sd of Object.values(cachedServerData)) {
    for (const fp of Object.keys(sd.keys)) {
      if (!namedFps.has(fp)) unknownFps.push(fp);
    }
  }

  const keys: (KeyAlias | KeySeparatorEntry)[] = [
    ...keyAliases.map(e => e.isSeparator ? e as KeySeparatorEntry : resolveKeyAlias((e as KeyAlias).fingerprint, keyAliases)),
    ...unknownFps.map(fp => resolveKeyAlias(fp, keyAliases)),
  ];

  // Aggregate key comment stats across all servers
  const commentStats: Record<string, { comment: string; count: number }[]> = {};
  for (const sd of Object.values(cachedServerData)) {
    for (const [fp, comment] of Object.entries(sd.keyComments || {})) {
      if (!comment) continue;
      if (!commentStats[fp]) commentStats[fp] = [];
      const existing = commentStats[fp].find(c => c.comment === comment);
      if (existing) {
        existing.count++;
      } else {
        commentStats[fp].push({ comment, count: 1 });
      }
    }
  }
  // Sort each entry by count descending
  for (const entries of Object.values(commentStats)) {
    entries.sort((a, b) => b.count - a.count);
  }

  console.log(`[load] Done: ${keys.length} total key(s), ${servers.length} server(s)\n`);
  return { servers, keys, serverData: cachedServerData, commentStats };
}

// GET /api/stream — progressive SSE: init → server* → done
app.get('/api/stream', async (req, res) => {
  const profile = (req.query.profile as string) || undefined;
  console.log(`[api] GET /api/stream (profile: ${profile || 'default'})`);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const serversFile = getServersFile(profile);
  const servers = parseServers(serversFile);
  const keyAliases = loadKeyAliases();

  // Send initial structure immediately (keys from keys.txt incl. separators + server list)
  const initialKeys = keyAliases.map(e =>
    e.isSeparator ? e : resolveKeyAlias((e as KeyAlias).fingerprint, keyAliases)
  );
  send('init', { servers, keys: initialKeys });

  // Fetch all servers in parallel, stream each result as it arrives
  const serverDataMap: Record<string, ServerData> = {};

  await Promise.allSettled(
    servers.map(async (s) => {
      const data = await fetchServerData(s);
      serverDataMap[s.alias] = data;

      // New keys found on this server not already in keyAliases
      const newKeys: KeyAlias[] = [];
      for (const fp of Object.keys(data.keys)) {
        if (!keyAliases.find(ka => !ka.isSeparator && (ka as KeyAlias).fingerprint === fp)) {
          newKeys.push(resolveKeyAlias(fp, keyAliases));
        }
      }
      send('server', { alias: s.alias, data, newKeys });
    })
  );

  // Build final commentStats
  const commentStats: Record<string, { comment: string; count: number }[]> = {};
  for (const sd of Object.values(serverDataMap)) {
    for (const [fp, comment] of Object.entries(sd.keyComments || {})) {
      if (!comment) continue;
      if (!commentStats[fp]) commentStats[fp] = [];
      const existing = commentStats[fp].find(c => c.comment === comment);
      if (existing) existing.count++;
      else commentStats[fp].push({ comment, count: 1 });
    }
  }
  for (const entries of Object.values(commentStats)) {
    entries.sort((a, b) => b.count - a.count);
  }

  cachedServerData = serverDataMap;
  send('done', { commentStats });
  res.end();
});

// GET /api/data — load everything
app.get('/api/data', async (_req, res) => {
  console.log('[api] GET /api/data');
  try {
    const data = await loadAllData();
    res.json(data);
  } catch (err: any) {
    console.error('[api] /api/data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reload — re-read keys.txt + re-fetch servers
app.get('/api/reload', async (_req, res) => {
  console.log('[api] GET /api/reload');
  try {
    const data = await loadAllData();
    res.json(data);
  } catch (err: any) {
    console.error('[api] /api/reload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/refresh-server?alias=X&profile=Y — re-fetch a single server
app.get('/api/refresh-server', async (req, res) => {
  const alias = req.query.alias as string;
  const profile = (req.query.profile as string) || undefined;
  if (!alias) return res.status(400).json({ error: 'alias required' });

  const servers = parseServers(getServersFile(profile));
  const serverConfig = servers.find(s => s.alias === alias);
  if (!serverConfig) return res.status(404).json({ error: `Server ${alias} not found` });

  console.log(`[api] Refreshing server: ${alias}`);
  const keyAliases = loadKeyAliases();
  const data = await fetchServerData(serverConfig);
  cachedServerData[alias] = data;

  // New keys found on this server
  const newKeys: KeyAlias[] = [];
  for (const fp of Object.keys(data.keys)) {
    if (!keyAliases.find(ka => !ka.isSeparator && (ka as KeyAlias).fingerprint === fp)) {
      newKeys.push(resolveKeyAlias(fp, keyAliases));
    }
  }

  res.json({ alias, data, newKeys });
});

// POST /api/keys — update a key alias
app.post('/api/keys', (req, res) => {
  try {
    const { fingerprint, alias } = req.body;
    if (!fingerprint || !alias) {
      return res.status(400).json({ error: 'fingerprint and alias required' });
    }
    saveKeyAlias(fingerprint, alias);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reorder — save new key order to keys.txt
// Body: { entries: [{fp: string} | {sep: true}] }  (supports separators)
//   OR: { fingerprints: string[] }                  (legacy, keys only)
app.post('/api/reorder', (req, res) => {
  try {
    const body = req.body as { entries?: Array<{ fp?: string; sep?: boolean }>; fingerprints?: string[] };
    if (body.entries && Array.isArray(body.entries)) {
      saveKeyOrder(body.entries);
    } else if (body.fingerprints && Array.isArray(body.fingerprints)) {
      reorderKeys(body.fingerprints);
    } else {
      return res.status(400).json({ error: 'entries or fingerprints array required' });
    }
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[api] /api/reorder error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/apply — apply pending changes via SSE
app.post('/api/apply', async (req, res) => {
  const actions: PendingAction[] = req.body.actions;
  const parallel: boolean = req.body.parallel ?? false;
  if (!actions || !actions.length) {
    return res.status(400).json({ error: 'No actions provided' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Create log file
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logFile = path.resolve(`execution-${ts}.log`);
  const logLines: string[] = [];

  const log = (msg: string) => {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    logLines.push(entry);
  };

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  log(`Starting execution of ${actions.length} actions (mode: ${parallel ? 'parallel' : 'sequential'})`);
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    log(`Action ${i + 1}: ${a.type} key "${a.keyAlias}" for user ${a.username} on ${a.serverAlias}`);
  }

  const applyProfile = req.body.profile || undefined;
  const servers = parseServers(getServersFile(applyProfile));

  // Helper: run a single indexed action, sending SSE events
  const runAction = async (action: PendingAction, index: number) => {
    const serverConfig = servers.find(s => s.alias === action.serverAlias);
    if (!serverConfig) {
      sendEvent({ index, status: 'error', error: `Server ${action.serverAlias} not found` });
      log(`Action ${index + 1}: ERROR - Server ${action.serverAlias} not found`);
      return;
    }
    sendEvent({ index, status: 'running' });
    log(`Action ${index + 1}: executing...`);
    try {
      if (action.type === 'add') {
        await addKey(serverConfig, action.username, action.fullKeyLine);
      } else {
        await removeKey(serverConfig, action.username, action.fingerprint);
      }
      sendEvent({ index, status: 'success' });
      log(`Action ${index + 1}: SUCCESS`);
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      sendEvent({ index, status: 'error', error: errorMsg });
      log(`Action ${index + 1}: ERROR - ${errorMsg}`);
    }
  };

  if (parallel) {
    // Split into two phases: adds first (barrier), then removes.
    // Within each phase, use per-server chaining so max 1 action per server at a time.
    const addPhase = actions.map((a, i) => ({ action: a, index: i })).filter(x => x.action.type === 'add');
    const removePhase = actions.map((a, i) => ({ action: a, index: i })).filter(x => x.action.type === 'remove');

    const runPhase = async (phase: { action: PendingAction; index: number }[]) => {
      // Per-server chain: map serverAlias → last promise for that server
      const serverChains = new Map<string, Promise<void>>();
      const phasePromises = phase.map(({ action, index }) => {
        const prev = serverChains.get(action.serverAlias) ?? Promise.resolve();
        const next = prev.then(() => runAction(action, index));
        serverChains.set(action.serverAlias, next);
        return next;
      });
      await Promise.all(phasePromises);
    };

    log(`Phase 1: ${addPhase.length} additions`);
    await runPhase(addPhase);
    log(`Phase 2: ${removePhase.length} removals`);
    await runPhase(removePhase);
  } else {
    // Sequential execution
    for (let i = 0; i < actions.length; i++) {
      await runAction(actions[i], i);
    }
  }

  sendEvent({ done: true });
  log('Execution complete');

  // Write log file
  fs.writeFileSync(logFile, logLines.join('\n') + '\n', 'utf-8');
  console.log(`Execution log written to: ${logFile}`);

  res.end();
});

app.listen(PORT, () => {
  const profiles = listProfiles();
  console.log(`\n  Keyspector running at http://localhost:${PORT}\n`);
  console.log(`  Profiles:  ${profiles.map(p => `${p.name}(${p.count})`).join(', ')} (in servers/)`);
  console.log(`  Keys file: keys.txt\n`);
});
