import fs from 'fs';
import path from 'path';
import type { ServerConfig, KeyAlias, KeySeparatorEntry } from './types.js';

export type KeyEntry = KeyAlias | KeySeparatorEntry;

const KEYS_FILE = path.resolve('keys.txt');
const SERVERS_DIR = path.resolve('servers');

export function getServersDir(): string {
  return SERVERS_DIR;
}

export function getServersFile(profile?: string): string {
  // Legacy: --servers flag or SERVERS_FILE env var override everything
  const fromArg = process.argv.find((_, i, a) => a[i - 1] === '--servers');
  const fromEnv = process.env.SERVERS_FILE;
  if (fromArg || fromEnv) return path.resolve(fromArg || fromEnv!);

  // Default: look in servers/ directory
  const name = profile || 'default';
  return path.join(SERVERS_DIR, `${name}.txt`);
}

/** List available server profiles (filenames without .txt in servers/ dir).
 *  Excludes `*.example.txt` template files and profiles that parse to 0 servers.
 *  Returns each profile with its server count for display purposes. */
export function listProfiles(): { name: string; count: number }[] {
  if (!fs.existsSync(SERVERS_DIR)) return [{ name: 'default', count: 0 }];
  const entries: { name: string; count: number }[] = [];
  for (const f of fs.readdirSync(SERVERS_DIR)) {
    if (!f.endsWith('.txt') || f.endsWith('.example.txt')) continue;
    let count = 0;
    try {
      count = parseServers(path.join(SERVERS_DIR, f)).length;
    } catch { continue; }
    if (count === 0) continue;
    entries.push({ name: f.replace(/\.txt$/, ''), count });
  }
  // Ensure 'default' is first, rest alphabetical
  entries.sort((a, b) => {
    if (a.name === 'default') return -1;
    if (b.name === 'default') return 1;
    return a.name.localeCompare(b.name);
  });
  return entries.length > 0 ? entries : [{ name: 'default', count: 0 }];
}

export function parseServers(filePath: string): ServerConfig[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const servers: ServerConfig[] = [];

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // Format: alias user@server:port
    // port is optional, defaults to 22
    const match = line.match(/^(\S+)\s+(\S+)@(\S+?)(?::(\d+))?$/);
    if (!match) {
      console.warn(`Skipping invalid server line: ${line}`);
      continue;
    }

    servers.push({
      alias: match[1],
      user: match[2],
      host: match[3],
      port: match[4] ? parseInt(match[4], 10) : 22,
    });
  }

  return servers;
}

/**
 * Parse an authorized_keys line which may have options prefix like:
 *   command="...",no-pty,... ssh-ed25519 AAAA... comment
 * Returns { options: string | null, keyType, base64, comment, fullKeyPart }
 */
const KEY_TYPES = ['ssh-rsa', 'ssh-ed25519', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'];

export function parseAuthorizedKeysLine(line: string): {
  options: string | null;
  keyType: string;
  base64: string;
  comment: string | undefined;
  fullKeyPart: string;
} | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // Try to find the key type anywhere in the line
  for (const kt of KEY_TYPES) {
    const idx = trimmed.indexOf(kt);
    if (idx < 0) continue;

    const optionsPart = idx > 0 ? trimmed.slice(0, idx).trim() : null;
    // Remove trailing comma from options if present
    const options = optionsPart ? optionsPart.replace(/,\s*$/, '') : null;

    const keyPart = trimmed.slice(idx);
    const parts = keyPart.split(/\s+/);
    if (parts.length < 2) continue;

    return {
      options,
      keyType: parts[0],
      base64: parts[1],
      comment: parts.length >= 3 ? parts.slice(2).join(' ') : undefined,
      fullKeyPart: keyPart,
    };
  }

  return null;
}

/** Extract fingerprint (type + base64) from a full authorized_keys line */
export function extractFingerprint(line: string): string {
  const parsed = parseAuthorizedKeysLine(line);
  if (parsed) return `${parsed.keyType} ${parsed.base64}`;
  // Fallback for plain key lines
  const parts = line.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  return line.trim();
}

/** Extract comment/alias from authorized_keys line */
export function extractComment(line: string): string | undefined {
  const parsed = parseAuthorizedKeysLine(line);
  if (parsed) return parsed.comment;
  const parts = line.trim().split(/\s+/);
  if (parts.length >= 3) {
    return parts.slice(2).join(' ');
  }
  return undefined;
}

/** Extract options string from authorized_keys line, or null */
export function extractOptions(line: string): string | null {
  const parsed = parseAuthorizedKeysLine(line);
  return parsed?.options ?? null;
}

/** Generate a short display name from key tail */
function generateShortName(fingerprint: string, maxLen: number = 20): string {
  const base64 = fingerprint.split(/\s+/)[1] || fingerprint;
  const tail = base64.slice(-Math.max(maxLen - 3, 6));
  return `...${tail}`;
}

export function loadKeyAliases(): KeyEntry[] {
  if (!fs.existsSync(KEYS_FILE)) {
    return [];
  }
  const content = fs.readFileSync(KEYS_FILE, 'utf-8');
  const entries: KeyEntry[] = [];
  const seenFp = new Set<string>();
  let sepCount = 0;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // Separator line
    if (line === '---') {
      entries.push({ isSeparator: true, id: `sep:${sepCount++}`, fullLine: '---' });
      continue;
    }

    const fingerprint = extractFingerprint(line);
    if (seenFp.has(fingerprint)) {
      console.warn(`[config] Duplicate fingerprint in keys.txt, skipping: ${line.slice(0, 80)}`);
      continue;
    }
    seenFp.add(fingerprint);

    const comment = extractComment(line);

    entries.push({
      fullLine: line,
      fingerprint,
      alias: comment || generateShortName(fingerprint),
      isNamed: !!comment,
    });
  }

  return entries;
}

export function saveKeyAlias(fingerprint: string, alias: string): void {
  const entries = loadKeyAliases();
  const existing = entries.find(e => !e.isSeparator && (e as KeyAlias).fingerprint === fingerprint) as KeyAlias | undefined;

  if (existing) {
    existing.alias = alias;
    existing.isNamed = true;
    existing.fullLine = `${fingerprint} ${alias}`;
  } else {
    entries.push({
      fullLine: `${fingerprint} ${alias}`,
      fingerprint,
      alias,
      isNamed: true,
    });
  }

  const lines = entries.map(e => e.fullLine);
  fs.writeFileSync(KEYS_FILE, lines.join('\n') + '\n', 'utf-8');
}

export function reorderKeys(fingerprints: string[]): void {
  const entries = loadKeyAliases();
  const onlyKeys = entries.filter(e => !e.isSeparator) as KeyAlias[];

  const used = new Set<number>();
  const reordered: KeyAlias[] = [];

  for (const fp of fingerprints) {
    const idx = onlyKeys.findIndex((a, i) => a.fingerprint === fp && !used.has(i));
    if (idx !== -1) {
      reordered.push(onlyKeys[idx]);
      used.add(idx);
    }
  }
  for (let i = 0; i < onlyKeys.length; i++) {
    if (!used.has(i)) reordered.push(onlyKeys[i]);
  }

  fs.writeFileSync(KEYS_FILE, reordered.map(a => a.fullLine).join('\n') + '\n', 'utf-8');
  console.log(`[config] Reordered ${reordered.length} keys in keys.txt`);
}

/** Save the full ordered list (keys + separators) back to keys.txt */
export function saveKeyOrder(entries: Array<{ fp?: string; sep?: boolean }>): void {
  const current = loadKeyAliases();
  const keyMap = new Map<string, KeyAlias>();
  for (const e of current) {
    if (!e.isSeparator) {
      const ka = e as KeyAlias;
      keyMap.set(ka.fingerprint, ka);
    }
  }

  const lines: string[] = [];
  for (const e of entries) {
    if (e.sep) {
      lines.push('---');
    } else if (e.fp) {
      const ka = keyMap.get(e.fp);
      if (ka) lines.push(ka.fullLine);
    }
  }

  fs.writeFileSync(KEYS_FILE, lines.join('\n') + '\n', 'utf-8');
  console.log(`[config] Saved key order: ${lines.length} entries (${lines.filter(l => l === '---').length} separators)`);
}

export function resolveKeyAlias(fingerprint: string, knownAliases: KeyEntry[]): KeyAlias {
  const onlyKeys = knownAliases.filter(e => !e.isSeparator) as KeyAlias[];
  const known = onlyKeys.find(a => a.fingerprint === fingerprint);
  if (known) return known;

  return {
    fullLine: fingerprint,
    fingerprint,
    alias: generateShortName(fingerprint),
    isNamed: false,
  };
}
