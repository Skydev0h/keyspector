export interface ServerConfig {
  alias: string;
  user: string;
  host: string;
  port: number;
}

export interface KeyAlias {
  /** Full public key line (type + base64 + comment) */
  fullLine: string;
  /** Just the type + base64 portion (no comment), used as unique identifier */
  fingerprint: string;
  /** Alias from keys.txt or auto-generated from key tail */
  alias: string;
  /** Whether alias came from keys.txt (true) or was auto-generated (false) */
  isNamed: boolean;
  /** Discriminants: always undefined for real keys */
  isSeparator?: undefined;
  isCategory?: undefined;
}

export interface KeyPresence {
  /** Username that has this key */
  username: string;
  /** Server alias */
  serverAlias: string;
}

export interface ServerUser {
  name: string;
  uid: number;
}

export interface ServerData {
  config: ServerConfig;
  /** Username of the default user (UID 1000) */
  defaultUser: string | null;
  /** All users on the server (root + UID≥1000, no nologin/false) */
  users: ServerUser[];
  /** Map: fingerprint → list of usernames that have this key */
  keys: Record<string, string[]>;
  /** Map: fingerprint → comment from the authorized_keys line */
  keyComments: Record<string, string>;
  /** Map: fingerprint → options prefix (command="...",no-pty,...) if present */
  keyOptions: Record<string, string>;
  /** Raw AuthorizedKeysFile pattern list from sshd_config (global context) */
  authKeysPatterns: string[];
  /** Per user: list of authorized_keys files that actually exist, in pattern order (first = primary). */
  authKeysFiles: Record<string, string[]>;
  /** Per user: the "primary" (first pattern, expanded) path — used as add-target when no file exists yet. */
  authKeysPrimary: Record<string, string>;
  /** Per (fingerprint, user): list of files where this key currently lives. */
  keyFiles: Record<string, Record<string, string[]>>;
  /** Error if server was unreachable */
  error?: string;
}

export interface KeySeparatorEntry {
  isSeparator: true;
  isCategory?: undefined;
  id: string;
  fullLine: '---';
}

export interface KeyCategoryEntry {
  isCategory: true;
  isSeparator?: undefined;
  id: string;
  name: string;
  /** Stored as `* <name>` in keys.txt */
  fullLine: string;
}

export interface AppData {
  servers: ServerConfig[];
  /** All unique keys, separators, and categories (keys.txt order first, then unknown server keys) */
  keys: (KeyAlias | KeySeparatorEntry | KeyCategoryEntry)[];
  /** Server data keyed by alias */
  serverData: Record<string, ServerData>;
  /** Aggregated key comment stats: fingerprint → [{comment, count}] sorted by count desc */
  commentStats: Record<string, { comment: string; count: number }[]>;
}

export interface PendingAction {
  type: 'add' | 'remove';
  fingerprint: string;
  keyAlias: string;
  fullKeyLine: string;
  username: string;
  serverAlias: string;
  serverConfig: ServerConfig;
  /** For `add`: the file the frontend expects sshd to pick as target (first existing or primary).
      Backend verifies its own resolution matches and refuses if it diverges. */
  expectedTargetPath?: string;
  /** For `remove`: exact files the frontend believes contain the key.
      Backend verifies each is a valid sshd AuthorizedKeysFile and that the key is actually there. */
  expectedSourcePaths?: string[];
}

export interface ActionResult {
  index: number;
  status: 'running' | 'success' | 'error';
  error?: string;
}
