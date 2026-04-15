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

    // For each user, read their authorized_keys (using sudo)
    const keys: Record<string, string[]> = {};
    const keyComments: Record<string, string> = {};
    const keyOptions: Record<string, string> = {};  // fp → options string (first occurrence)

    if (users.length > 0) {
      // Build a single command to read all authorized_keys files
      const catParts = users.map(u =>
        `echo "===USER:${u.name}==="; sudo cat "${u.home}/.ssh/authorized_keys" 2>/dev/null || true`
      ).join('; ');

      const output = await sshExec(config, catParts);

      let currentUser = '';
      for (const line of output.split('\n')) {
        const userMatch = line.match(/^===USER:(.+)===$/);
        if (userMatch) {
          currentUser = userMatch[1];
          continue;
        }
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !currentUser) continue;

        // Parse the line (handles options prefix like command="...",no-pty ssh-ed25519 ...)
        const parsed = parseAuthorizedKeysLine(trimmed);
        if (!parsed) continue;

        const fp = `${parsed.keyType} ${parsed.base64}`;
        if (!keys[fp]) keys[fp] = [];
        if (!keys[fp].includes(currentUser)) {
          keys[fp].push(currentUser);
        }

        // Collect comment (only first occurrence per fingerprint)
        if (!(fp in keyComments) && parsed.comment) {
          keyComments[fp] = parsed.comment;
        }

        // Collect options (only first occurrence per fingerprint)
        if (!(fp in keyOptions) && parsed.options) {
          keyOptions[fp] = parsed.options;
        }
      }
    }

    const totalKeys = Object.keys(keys).length;
    console.log(`[${config.alias}] Done: ${totalKeys} unique key(s) found`);
    return { config, defaultUser, users: users.map(u => ({ name: u.name, uid: u.uid })), keys, keyComments, keyOptions };
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
      error: msg,
    };
  }
}

export async function addKey(
  config: ServerConfig,
  username: string,
  fullKeyLine: string
): Promise<void> {
  // Determine home directory for user
  const homeRaw = await sshExec(config,
    `getent passwd ${username} | cut -d: -f6`
  );
  const home = homeRaw.trim();
  if (!home) throw new Error(`User ${username} not found on ${config.alias}`);

  const authKeysPath = `${home}/.ssh/authorized_keys`;

  // Ensure .ssh directory exists and add the key
  const escapedKey = fullKeyLine.replace(/'/g, "'\\''");
  await sshExec(config, [
    `sudo mkdir -p "${home}/.ssh"`,
    `sudo touch "${authKeysPath}"`,
    `sudo chmod 700 "${home}/.ssh"`,
    `sudo chmod 600 "${authKeysPath}"`,
    `sudo chown ${username}:${username} "${home}/.ssh" "${authKeysPath}"`,
    `echo '${escapedKey}' | sudo tee -a "${authKeysPath}" > /dev/null`,
  ].join(' && '));
}

export async function removeKey(
  config: ServerConfig,
  username: string,
  fingerprint: string
): Promise<void> {
  const homeRaw = await sshExec(config,
    `getent passwd ${username} | cut -d: -f6`
  );
  const home = homeRaw.trim();
  if (!home) throw new Error(`User ${username} not found on ${config.alias}`);

  const authKeysPath = `${home}/.ssh/authorized_keys`;

  // Escape the fingerprint for use in grep -v (fixed string match)
  const escapedFp = fingerprint.replace(/'/g, "'\\''");
  await sshExec(config, [
    `sudo cp "${authKeysPath}" "${authKeysPath}.bak"`,
    `sudo grep -v -F '${escapedFp}' "${authKeysPath}.bak" | sudo tee "${authKeysPath}" > /dev/null`,
    `sudo chown ${username}:${username} "${authKeysPath}"`,
    `sudo chmod 600 "${authKeysPath}"`,
  ].join(' && '));
}
