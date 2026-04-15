# 🔑 Keyspector

A web UI to inspect and manage SSH `authorized_keys` across many servers at once. Connect to a fleet, see which key is present on which user/host, and plan add/remove actions with visual confirmation — all in the browser.

## Features

- **Multi-server table view** — servers as columns, keys as rows, badges show which user on which host has the key
- **Parallel SSH fetch** — progressive loading, errored servers highlighted red and refreshable one-by-one
- **Visual key planner** — click to mark additions (green), click existing to mark removals (red). Apply executes all pending actions with live SSE progress
- **Named keys + aliases** — `keys.txt` stores human-readable names; drag to reorder; add separator rows to group
- **Server profiles** — put multiple `.txt` files in `servers/` for prod/staging/etc., switch via tabs, URL stores selection
- **Restricted key detection** — keys with `command=`, `no-pty`, etc. are shown with a striped pattern; special keys cannot be modified
- **Parallel apply** — optional mode runs actions concurrently (adds first, then removes; max 1 op per server)
- **Dark / light / auto theme** — persists in `settings.json`

## Quick Start

```bash
npm install
npx tsx src/server.ts
```

Then open `http://localhost:3000`.

### First-run setup

1. Create `servers/default.txt` with one line per server (`alias user@host[:port]`) — see `servers/default.example.txt`
2. Keys are discovered from servers on first load; to give them nice names, edit inline (pencil icon) — saved to `keys.txt`
3. SSH auth uses keys from `~/.ssh/` (`id_ed25519`, `id_rsa`, `id_ecdsa`). The tool tries each until one works — same as OpenSSH client.

### CLI

- `--port N` or `PORT=N` — change port (default 3000)
- `--servers path` or `SERVERS_FILE=path` — override default profile location

## Server requirements

- SSH access as a user with **passwordless sudo** (or use `root` directly)
- Tool runs `getent passwd` to discover users, then reads each user's `~/.ssh/authorized_keys` via `sudo cat`
- Only UID 0 (root) + UID ≥ 1000 real users are considered

## Interaction cheatsheet

| Action | Effect |
|---|---|
| Click empty cell | Add key for server's default user (UID 1000) |
| `Ctrl`+click | Add key for `root` instead |
| Click existing badge | Mark for removal (red border, strikethrough) |
| Right-click cell | Per-user popup — toggle any user on that host |
| Click server header | Refresh just that server |
| Drag key row | Reorder in `keys.txt` |
| Drag separator | Move; drag to bottom zone to delete |

## Files

| File | Purpose | Tracked? |
|---|---|---|
| `src/`, `public/` | App code | ✅ |
| `servers/*.txt` | Server profiles (your infra) | ❌ |
| `keys.txt` | Key aliases + order | ❌ |
| `settings.json` | UI preferences | ❌ |
| `execution-*.log` | Apply history | ❌ |

## Tech stack

- Backend: Node.js + TypeScript + Express + [ssh2](https://github.com/mscdex/ssh2)
- Frontend: Vanilla HTML/CSS/JS (no bundler, no framework)
- Single command to run: `npx tsx src/server.ts`

## License

MIT
