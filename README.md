# 🔑 Keyspector

A web UI to inspect and manage SSH `authorized_keys` across many servers at once. Connect to a fleet, see which key is present on which user/host, and plan add/remove actions with visual confirmation — all in the browser.

## Features

### Viewing
- **Multi-server table view** — servers as columns, keys as rows, badges show which user on which host has the key (badge color + letter = username; root shown as `#`)
- **Parallel SSH fetch with progressive loading** — table renders immediately, servers fill in as their data arrives; columns of still-loading servers pulse gently
- **Errored servers tinted red** — click a server header to retry just that one
- **Key comment stats** (👀 / 🧐) — when the same key has different comments across servers, shows a popup with counts; click to adopt that comment as the alias
- **Restricted key detection** — keys with `command=`, `no-pty`, `from=…` etc. are rendered with a striped pattern; clicking opens a details popup; they cannot be modified
- **UID-sorted badges** — root always first, then users by UID (consistent across reloads)

### Organizing keys
- **Named keys + aliases** — `keys.txt` stores human-readable names; inline edit (✏️)
- **Drag to reorder** — any named key row can be dragged to a new position
- **Separators** (`---`) — drag the "drag to add separator" row up to insert a divider line
- **Categories** (`* Name`) — drag the "drag to add category" row to create a bold section header; auto-enters rename mode on creation
- **Delete** — drag an existing separator or category down to the delete zone
- **Multi-select** (<kbd>Shift</kbd>+drag) — draw a rectangle to select multiple rows (including separators/categories); drag the group to reorder them together as a block
- **Per-key filter** (⬜/🔲) — show only servers that have at least one of the filtered keys

### Planning changes
- **Click empty cell** — queue an add for the server's default user (UID 1000)
- **<kbd>Ctrl</kbd>+click empty cell** — queue an add for `root` (button turns red on hover to signal)
- **Click existing badge** — queue a removal (red border, strikethrough)
- **Right-click cell** — per-user popup: toggle any user on that host; <kbd>Ctrl</kbd>+click for multi-select mode
- **➕ bulk-add** — add the key to all visible servers that don't have it yet; <kbd>Ctrl</kbd>+click adds as root
- **🚫 bulk-remove** — mark every occurrence of the key for removal

### Applying
- **Confirmation modal** lists every action with live status icons (⏳ → 🔄 → ✅/❌)
- **Sequential apply** (default) — one action at a time, scroll-follows progress
- **Parallel apply** — optional checkbox; runs all adds first (barrier), then all removes; max 1 concurrent op per server to avoid race conditions
- **Execution log** written to `execution-YYYY-MM-DDTHH-mm-ss.log`
- **Adds before removes** — safe order for replacing your own key

### Ergonomics
- **Server profiles** — drop multiple `.txt` files in `servers/` for prod/staging/etc., switch via tabs in header; current profile stored in URL
- **Resizable key column** — drag the handle on the Key column; width saved to `settings.json`
- **Dark / light / auto theme** — three-button toggle in footer; auto follows system preference; persists in `settings.json`
- **Warns on close with unsaved changes** — standard `beforeunload` dialog
- **Hint bar** — common shortcuts documented at the bottom of the window

## Quick Start

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

### First-run setup

1. Create `servers/default.txt` with one line per server (`alias user@host[:port]`) — see `servers/default.example.txt` for format
2. Keys are discovered from servers on first load; give them nice names inline (✏️) — saves to `keys.txt`
3. SSH auth uses keys from `~/.ssh/` (`id_ed25519`, `id_rsa`, `id_ecdsa`, `id_dsa`). The tool tries each until one works — same as OpenSSH client.

### Profiles

Any `*.txt` file in `servers/` is a profile. Example:

```
servers/
├── default.txt    # → "default" tab
├── prod.txt       # → "prod" tab
└── staging.txt    # → "staging" tab
```

`default` is always first, the rest are alphabetical. Files ending in `.example.txt` are ignored (use them as templates). Profiles with zero valid server lines are also hidden. Each tab shows a small badge with the host count.

The active profile is reflected in the URL (`?profile=prod`) so reloads and bookmarks work.

### CLI

- `--port N` or `PORT=N` — change port (default 3000)
- `--servers path` or `SERVERS_FILE=path` — override profile lookup (bypasses the `servers/` directory entirely)

## Server requirements

- SSH access as a user with **passwordless sudo** (or use `root` directly)
- The tool runs `getent passwd` to discover users, then reads each user's `~/.ssh/authorized_keys` via `sudo cat`
- Only UID 0 (root) + UID ≥ 1000 real users are considered (nologin/false shells skipped)

## Interaction cheatsheet

| Action | Effect |
|---|---|
| Click empty cell | Add key for server's default user (UID 1000) |
| <kbd>Ctrl</kbd>+click empty cell | Add key for `root` instead |
| Click existing badge | Mark for removal |
| Right-click cell | Per-user popup — toggle any user |
| <kbd>Ctrl</kbd>+click in popup | Multi-select mode (popup stays open) |
| Click server header | Refresh just that server |
| Drag key row | Reorder in `keys.txt` |
| <kbd>Shift</kbd>+drag | Draw selection rectangle; drag group to move |
| Drag "drag to add separator/category" rows | Create a new separator / category |
| Drag separator/category to bottom zone | Delete it |
| ✏️ on key | Rename alias |
| ➕ on key | Add to all visible servers missing it |
| 🚫 on key | Mark all occurrences for removal |
| ⬜ / 🔲 on key | Toggle server-column filter |
| <kbd>Esc</kbd> | Clear multi-selection |

## Files

| File / path | Purpose | Tracked? |
|---|---|---|
| `src/`, `public/` | App code | ✅ |
| `servers/*.example.txt` | Config templates | ✅ |
| `keys.example.txt` | Config template | ✅ |
| `servers/*.txt` | Server profiles (your infra) | ❌ |
| `keys.txt` | Key aliases, order, separators, categories | ❌ |
| `settings.json` | UI preferences (theme, column width) | ❌ |
| `execution-*.log` | Apply history | ❌ |

## `keys.txt` format

```
# Named keys — alias is everything after the base64 body
ssh-ed25519 AAAAC3NzaC1l... alice@laptop
ssh-rsa     AAAAB3NzaC1y... bob-ci

---                         # separator (thin horizontal line)

* Production servers        # category (bold header)
ssh-ed25519 AAAAC3NzaC1l... admin-prod

---

* Developers
ssh-ed25519 AAAAC3NzaC1l... carol@dev
```

The UI edits this file in place when you rename, reorder, add, or remove entries.

## Tech stack

- Backend: Node.js + TypeScript + Express + [ssh2](https://github.com/mscdex/ssh2)
- Frontend: Vanilla HTML/CSS/JS (no bundler, no framework)
- Single command to run: `npm start`

## License

MIT
