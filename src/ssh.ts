import { Client } from 'ssh2';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ServerConfig, ServerData } from './types.js';
import { extractFingerprint, extractComment, parseAuthorizedKeysLine } from './config.js';

function getPrivateKeys(): { key: Buffer; path: string }[] {
  const candidates = [
    path.join(os.homedir(), '.ssh', 'id_ed25519'),
    path.join(os.homedir(), '.ssh', 'id_rsa'),
    path.join(os.homedir(), '.ssh', 'id_ecdsa'),
    path.join(os.homedir(), '.ssh', 'id_dsa'),
  ];
  const found = candidates
    .filter(p => fs.existsSync(p))
    .map(p => ({ key: fs.readFileSync(p), path: p }));
  if (found.length === 0) throw new Error('No SSH private key found in ~/.ssh/');
  return found;
}

function sshExecWithKey(
  config: ServerConfig,
  command: string,
  keyInfo: { key: Buffer; path: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';

    const timeout = setTimeout(() => {
      conn.end();
      const err = new Error(`SSH timeout (15s) for ${config.alias} (${config.user}@${config.host}:${config.port})`);
      console.error(`[${config.alias}] TIMEOUT: ${err.message}`);
      reject(err);
    }, 15000);

    conn.on('ready', () => {
      console.log(`[${config.alias}] Connected (key: ${path.basename(keyInfo.path)}), running: ${command.slice(0, 80)}${command.length > 80 ? '...' : ''}`);
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          conn.end();
          console.error(`[${config.alias}] exec error: ${err.message}`);
          reject(err);
          return;
        }
        stream.on('data', (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on('data', (data: Buffer) => {
          const text = data.toString().trim();
          if (text) console.warn(`[${config.alias}] stderr: ${text}`);
        });
        stream.on('close', () => {
          clearTimeout(timeout);
          conn.end();
          resolve(stdout);
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    console.log(`[${config.alias}] Trying ${config.user}@${config.host}:${config.port} with key ${keyInfo.path}`);
    try {
      conn.connect({
        host: config.host,
        port: config.port,
        username: config.user,
        privateKey: keyInfo.key,
        readyTimeout: 10000,
      });
    } catch (err: any) {
      clearTimeout(timeout);
      console.error(`[${config.alias}] connect() threw: ${err.message}`);
      reject(err);
    }
  });
}

async function sshExec(config: ServerConfig, command: string): Promise<string> {
  const keys = getPrivateKeys();
  let lastError: Error = new Error('No keys to try');

  for (const keyInfo of keys) {
    try {
      return await sshExecWithKey(config, command, keyInfo);
    } catch (err: any) {
      lastError = err;
      const msg: string = err.message || '';
      // Auth failure → try next key
      if (msg.includes('authentication') || msg.includes('auth') || msg.includes('Permission denied')) {
        console.warn(`[${config.alias}] Auth failed with ${keyInfo.path}, trying next key...`);
        continue;
      }
      // Non-auth error (timeout, connection refused, etc.) — don't retry
      throw err;
    }
  }

  console.error(`[${config.alias}] All keys exhausted. Last error: ${lastError.message}`);
  throw lastError;
}

/**
 * Extract the *global* AuthorizedKeysFile pattern from sshd_config + .d/*.conf contents.
 * "Global" means any line that appears before the first `Match` directive in each file.
 * (We intentionally don't handle Match-specific overrides — those depend on user groups,
 * remote host patterns, etc. and require full match evaluation to apply correctly.)
 *
 * Returns a list of path patterns (e.g. [".ssh/authorized_keys", ".ssh/authorized_keys2"]).
 * sshd's built-in default when the directive is absent.
 */
function extractGlobalAuthKeysFiles(combinedContent: string): string[] {
  // Track per-file Match state via sentinel lines inserted by the caller (=== FILE: ... ===)
  let inMatch = false;
  for (const raw of combinedContent.split('\n')) {
    // Reset Match state at the start of each included file (a new file begins a fresh global ctx)
    if (raw.startsWith('=== FILE:')) { inMatch = false; continue; }

    const line = raw.split('#')[0].trim();
    if (!line) continue;

    if (/^Match\b/i.test(line)) { inMatch = true; continue; }
    if (inMatch) continue;

    const m = line.match(/^AuthorizedKeysFile\s+(.+)$/i);
    if (m) {
      return m[1].trim().split(/\s+/);
    }
  }
  // sshd default
  return ['.ssh/authorized_keys', '.ssh/authorized_keys2'];
}

/** Expand sshd pattern tokens (%h, %u, %%) for a specific user */
function expandAuthKeysPath(pattern: string, user: { name: string; home: string }): string {
  // Replace %% with a sentinel first, then handle other tokens, then restore %
  const SENTINEL = '\x00PCT\x00';
  let p = pattern.replace(/%%/g, SENTINEL)
                 .replace(/%h/g, user.home)
                 .replace(/%u/g, user.name)
                 .replace(new RegExp(SENTINEL, 'g'), '%');
  // Relative paths are resolved from the user's home
  if (!p.startsWith('/')) p = `${user.home}/${p}`;
  return p;
}

export async function fetchServerData(config: ServerConfig): Promise<ServerData> {
  console.log(`[${config.alias}] Starting fetch...`);
  try {
    // Get users: root + UID >= 1000 (real users)
    const passwdRaw = await sshExec(config,
      `getent passwd | awk -F: '($3 == 0 || $3 >= 1000) && $7 !~ /nologin|false/ {print $1":"$3":"$6}'`
    );

    const users: { name: string; uid: number; home: string }[] = [];
    let defaultUser: string | null = null;

    for (const line of passwdRaw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [name, uidStr, home] = trimmed.split(':');
      const uid = parseInt(uidStr, 10);
      users.push({ name, uid, home });
      if (uid === 1000) defaultUser = name;
    }

    console.log(`[${config.alias}] Found ${users.length} users: ${users.map(u => u.name).join(', ')} (default: ${defaultUser ?? 'none'})`);

    // Read sshd_config (main + drop-ins) to find the global AuthorizedKeysFile pattern.
    // Each file is prefixed with a "=== FILE: <path> ===" marker so the parser can reset
    // its Match-block tracking at the start of each file (Match blocks are file-scoped).
    const sshdConfigRaw = await sshExec(config, `
      echo "=== FILE: /etc/ssh/sshd_config ===";
      sudo cat /etc/ssh/sshd_config 2>/dev/null || true;
      for f in /etc/ssh/sshd_config.d/*.conf; do
        [ -f "$f" ] || continue;
        echo "=== FILE: $f ===";
        sudo cat "$f" 2>/dev/null || true;
      done
    `);

    const authKeysPatterns = extractGlobalAuthKeysFiles(sshdConfigRaw);
    console.log(`[${config.alias}] AuthorizedKeysFile patterns: ${authKeysPatterns.join(' ')}`);

    // Per-user expanded path lists (always in pattern order)
    const authKeysPrimary: Record<string, string> = {};
    for (const u of users) {
      authKeysPrimary[u.name] = expandAuthKeysPath(authKeysPatterns[0], u);
    }

    // For each user, read all authorized_keys files matching the pattern (using sudo),
    // emitting per-file markers so we can track which file each key came from.
    const keys: Record<string, string[]> = {};
    const keyComments: Record<string, string> = {};
    const keyOptions: Record<string, string> = {};
    const authKeysFiles: Record<string, string[]> = {};  // user → existing files (pattern order)
    const keyFiles: Record<string, Record<string, string[]>> = {}; // fp → user → files

    if (users.length > 0) {
      const catParts: string[] = [];
      for (const u of users) {
        catParts.push(`echo "===USER:${u.name}==="`);
        for (const pat of authKeysPatterns) {
          const path = expandAuthKeysPath(pat, u);
          // Emit FILE marker ONLY if the file exists — lets us distinguish "missing" from "empty"
          catParts.push(
            `if sudo test -e "${path}"; then echo "===FILE:${path}==="; sudo cat "${path}" 2>/dev/null || true; fi`
          );
        }
      }
      const output = await sshExec(config, catParts.join('; '));

      let currentUser = '';
      let currentFile = '';
      for (const line of output.split('\n')) {
        const userMatch = line.match(/^===USER:(.+)===$/);
        if (userMatch) {
          currentUser = userMatch[1];
          currentFile = '';
          continue;
        }
        const fileMatch = line.match(/^===FILE:(.+)===$/);
        if (fileMatch) {
          currentFile = fileMatch[1];
          if (!authKeysFiles[currentUser]) authKeysFiles[currentUser] = [];
          if (!authKeysFiles[currentUser].includes(currentFile)) {
            authKeysFiles[currentUser].push(currentFile);
          }
          continue;
        }
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !currentUser || !currentFile) continue;

        const parsed = parseAuthorizedKeysLine(trimmed);
        if (!parsed) continue;

        const fp = `${parsed.keyType} ${parsed.base64}`;
        if (!keys[fp]) keys[fp] = [];
        if (!keys[fp].includes(currentUser)) keys[fp].push(currentUser);

        if (!keyFiles[fp]) keyFiles[fp] = {};
        if (!keyFiles[fp][currentUser]) keyFiles[fp][currentUser] = [];
        if (!keyFiles[fp][currentUser].includes(currentFile)) {
          keyFiles[fp][currentUser].push(currentFile);
        }

        if (!(fp in keyComments) && parsed.comment) keyComments[fp] = parsed.comment;
        if (!(fp in keyOptions) && parsed.options) keyOptions[fp] = parsed.options;
      }
    }

    const totalKeys = Object.keys(keys).length;
    console.log(`[${config.alias}] Done: ${totalKeys} unique key(s) found`);
    return {
      config,
      defaultUser,
      users: users.map(u => ({ name: u.name, uid: u.uid })),
      keys,
      keyComments,
      keyOptions,
      authKeysPatterns,
      authKeysFiles,
      authKeysPrimary,
      keyFiles,
    };
  } catch (err: any) {
    const msg = err.message || String(err);
    console.error(`[${config.alias}] FAILED: ${msg}`);
    return {
      config,
      defaultUser: null,
      users: [],
      keys: {},
      keyComments: {},
      keyOptions: {},
      authKeysPatterns: [],
      authKeysFiles: {},
      authKeysPrimary: {},
      keyFiles: {},
      error: msg,
    };
  }
}

/**
 * Resolve the home directory + authorized_keys file paths for a user on a given server,
 * honoring the global AuthorizedKeysFile pattern from sshd_config (and drop-ins).
 */
async function resolveAuthKeysFilesForUser(
  config: ServerConfig,
  username: string
): Promise<{ home: string; paths: string[] }> {
  const output = await sshExec(config, `
    echo "===HOME===";
    getent passwd ${username} | cut -d: -f6;
    echo "===SSHD===";
    echo "=== FILE: /etc/ssh/sshd_config ===";
    sudo cat /etc/ssh/sshd_config 2>/dev/null || true;
    for f in /etc/ssh/sshd_config.d/*.conf; do
      [ -f "$f" ] || continue;
      echo "=== FILE: $f ===";
      sudo cat "$f" 2>/dev/null || true;
    done
  `);

  const [homePart, sshdPart] = output.split('===SSHD===');
  const home = homePart.replace('===HOME===', '').trim();
  if (!home) throw new Error(`User ${username} not found on ${config.alias}`);

  const patterns = extractGlobalAuthKeysFiles(sshdPart ?? '');
  const paths = patterns.map(p => expandAuthKeysPath(p, { name: username, home }));
  return { home, paths };
}

/** Error types so the server can report structured failures to the UI. */
export class PathMismatchError extends Error {
  kind = 'path-mismatch' as const;
}
export class InvalidPathError extends Error {
  kind = 'invalid-path' as const;
}
export class KeyNotFoundError extends Error {
  kind = 'key-not-found' as const;
}
/** A line with the same fingerprint exists but comment/options differ. Must remove first. */
export class KeyExistsError extends Error {
  kind = 'key-exists-differs' as const;
  paths: string[];
  constructor(message: string, paths: string[]) {
    super(message);
    this.paths = paths;
  }
}

export interface AddOptions {
  /** If given, backend must resolve the same target path or throw PathMismatchError. */
  expectedTargetPath?: string;
  /** If true, perform all checks but don't modify anything. */
  dryRun?: boolean;
}
export interface RemoveOptions {
  /** If given, backend removes ONLY from these files, after validating each is a legitimate
      AuthorizedKeysFile per sshd config (refusing otherwise) and that the key actually
      lives there (refusing if not). */
  expectedSourcePaths?: string[];
  dryRun?: boolean;
}

/** Result of addKey so callers can distinguish "appended" from "already-present (no-op)". */
export interface AddResult {
  status: 'added' | 'already-present';
  /** File that was (or would be) modified, OR — for already-present — where the identical line lives. */
  path: string;
}

/** Collapse a key line for exact-equality comparison (trim + normalize whitespace). */
function normalizeKeyLine(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

export async function addKey(
  config: ServerConfig,
  username: string,
  fingerprint: string,
  fullKeyLine: string,
  opts: AddOptions = {}
): Promise<AddResult> {
  const { home, paths } = await resolveAuthKeysFilesForUser(config, username);

  // Pick target: first existing file from the pattern list, else fall back to the primary pattern.
  const existsProbe = await sshExec(config,
    paths.map((p, i) => `sudo test -e "${p}" && echo ${i}`).join('; ')
  );
  const firstExistingIdx = parseInt(existsProbe.split('\n').find(l => l.trim())?.trim() ?? '', 10);
  const targetPath = !isNaN(firstExistingIdx) ? paths[firstExistingIdx] : paths[0];

  // Integrity check — backend's chosen target must match what the UI expected.
  if (opts.expectedTargetPath && opts.expectedTargetPath !== targetPath) {
    throw new PathMismatchError(
      `add target mismatch: UI expected "${opts.expectedTargetPath}", ` +
      `server resolved "${targetPath}" for ${username}`
    );
  }

  // Check if a line with this fingerprint already lives in any of the pattern files.
  // We emit per-path markers so we can attribute each matched line to its file.
  const escapedFp = fingerprint.replace(/'/g, "'\\''");
  const probeCmds = paths.map(p =>
    `if sudo test -e "${p}"; then echo "===PATH:${p}==="; sudo grep -F '${escapedFp}' "${p}" 2>/dev/null || true; fi`
  ).join('; ');
  const probeOut = await sshExec(config, probeCmds);

  // Parse: collect {path, line} for each line that contains the fingerprint.
  const found: { path: string; line: string }[] = [];
  let currentPath = '';
  for (const raw of probeOut.split('\n')) {
    const m = raw.match(/^===PATH:(.+)===$/);
    if (m) { currentPath = m[1]; continue; }
    if (!currentPath) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Only accept lines that actually contain the fingerprint (grep already filtered, but be safe)
    if (trimmed.includes(fingerprint)) found.push({ path: currentPath, line: raw });
  }

  if (found.length > 0) {
    // Any line that matches our fullKeyLine exactly (after whitespace normalization) = identical.
    const wanted = normalizeKeyLine(fullKeyLine);
    const identical = found.find(f => normalizeKeyLine(f.line) === wanted);
    if (identical) {
      console.log(`[${config.alias}] addKey ${username}: identical line already at ${identical.path} — no-op${opts.dryRun ? ' (dryRun)' : ''}`);
      return { status: 'already-present', path: identical.path };
    }
    // Same fingerprint but different comment or options — unsafe to append (sshd would use the first match).
    const distinctPaths = [...new Set(found.map(f => f.path))];
    throw new KeyExistsError(
      `key with same fingerprint already exists for ${username} at ${distinctPaths.join(', ')} ` +
      `with different comment/options — remove it first to replace`,
      distinctPaths
    );
  }

  console.log(`[${config.alias}] addKey ${username} → ${targetPath}${opts.dryRun ? ' (dryRun)' : ''}`);
  if (opts.dryRun) return { status: 'added', path: targetPath };

  const targetDir = targetPath.replace(/\/[^/]+$/, '');
  const inUserHome = targetPath.startsWith(home + '/');

  const escapedKey = fullKeyLine.replace(/'/g, "'\\''");
  const cmds = [
    `sudo mkdir -p "${targetDir}"`,
    `sudo touch "${targetPath}"`,
    `sudo chmod 700 "${targetDir}"`,
    `sudo chmod 600 "${targetPath}"`,
    ...(inUserHome ? [`sudo chown ${username}:${username} "${targetDir}" "${targetPath}"`] : []),
    `echo '${escapedKey}' | sudo tee -a "${targetPath}" > /dev/null`,
  ];
  await sshExec(config, cmds.join(' && '));
  return { status: 'added', path: targetPath };
}

export async function removeKey(
  config: ServerConfig,
  username: string,
  fingerprint: string,
  opts: RemoveOptions = {}
): Promise<void> {
  const { home, paths: patternPaths } = await resolveAuthKeysFilesForUser(config, username);

  // If caller supplied specific source paths, validate each is within the sshd pattern list.
  // This prevents the UI from asking us to delete arbitrary lines from arbitrary files.
  if (opts.expectedSourcePaths && opts.expectedSourcePaths.length > 0) {
    for (const p of opts.expectedSourcePaths) {
      if (!patternPaths.includes(p)) {
        throw new InvalidPathError(
          `"${p}" is not an AuthorizedKeysFile for ${username} per sshd config ` +
          `(allowed: ${patternPaths.join(', ') || '<none>'})`
        );
      }
    }
  }

  const candidates = opts.expectedSourcePaths ?? patternPaths;
  const escapedFp = fingerprint.replace(/'/g, "'\\''");

  // First pass: find which of the candidate files actually exist AND contain the key.
  const probeCmds = candidates.map(p =>
    `if sudo test -e "${p}" && sudo grep -q -F '${escapedFp}' "${p}"; then echo "FOUND:${p}"; fi`
  ).join('; ');
  const probeOut = await sshExec(config, probeCmds);
  const foundPaths = probeOut.split('\n')
    .filter(l => l.startsWith('FOUND:'))
    .map(l => l.slice('FOUND:'.length).trim())
    .filter(Boolean);

  if (foundPaths.length === 0) {
    throw new KeyNotFoundError(
      `key not found in expected source(s) for ${username}: ${candidates.join(', ')}`
    );
  }

  console.log(`[${config.alias}] removeKey ${username} from ${foundPaths.join(', ')}${opts.dryRun ? ' (dryRun)' : ''}`);
  if (opts.dryRun) return;

  const perPathScript = (path: string) => {
    const inUserHome = path.startsWith(home + '/');
    const chown = inUserHome ? `sudo chown ${username}:${username} "${path}"` : 'true';
    return `
      sudo cp "${path}" "${path}.bak" &&
      sudo grep -v -F '${escapedFp}' "${path}.bak" | sudo tee "${path}" > /dev/null &&
      ${chown} &&
      sudo chmod 600 "${path}"
    `.trim();
  };
  await sshExec(config, foundPaths.map(perPathScript).join(' && '));
}
