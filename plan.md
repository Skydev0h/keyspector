# Keyspector — SSH Key Management Web UI

## Context
Build a web tool to visualize and manage SSH keys across multiple servers. Shows a table: servers as columns, SSH key names as rows, with presence indicators (user's first letter). Supports adding/removing keys with sudo, parallel fetching, sequential applying.

## Tech Stack
- **Backend**: Node.js + TypeScript + Express
- **Frontend**: Vanilla HTML/CSS/JS (served by Express, no build step needed)
- **SSH**: `ssh2` library for connecting to servers
- **No framework overhead** — single `npm install` and `npx tsx src/server.ts` to run

## Project Structure
```
keyspector/
├── package.json
├── tsconfig.json
├── src/
│   ├── server.ts          # Express server, API routes, CLI args
│   ├── ssh.ts             # SSH connection, fetch keys, modify keys
│   ├── config.ts          # Parse servers.txt, keys.txt
│   └── types.ts           # Shared TypeScript types
├── public/
│   ├── index.html         # Main UI
│   ├── style.css          # Styles (table, tooltips, colors)
│   └── app.js             # Frontend logic
├── servers.txt            # Example/template
└── keys.txt               # Key alias database
```

## Key Design Decisions

### Backend API Endpoints
- `GET /api/data` — Fetch all data (parallel SSH to all servers, read all users' authorized_keys via sudo)
- `POST /api/apply` — Apply pending changes (sequential, SSE stream for progress)
- `POST /api/keys` — Update key alias in keys.txt
- `GET /api/reload` — Re-read keys.txt + re-fetch from servers

### SSH Strategy
1. Connect as `user@server:port` from servers.txt
2. Run `sudo cat /home/*/.ssh/authorized_keys /root/.ssh/authorized_keys 2>/dev/null` with user path prefixes to map key→user
3. Actually: enumerate users via `getent passwd` (UID ≥ 1000 + root), then for each user read their `authorized_keys`
4. Parallel fetching using `Promise.allSettled`
5. Sequential applying — one operation at a time, streaming status via SSE

### Frontend Table Logic
- Columns = servers (alias in header, full info in tooltip)
- Rows = unique keys (alias from keys.txt or `...last_chars` if unknown)
- **Cell = one or more badges** (a key may be present for multiple users on same server)
  - Each badge: first letter of username, light background, padding, rounded corners
  - Root displayed as `#`
  - Tooltip on badge = full username
  - Color assignment: each unique username gets a distinct hue; if no collisions, black text
- **Badge interactions**:
  - Hover: badge highlights (cursor pointer, slight bg darken)
  - Click existing badge → thin **red border** (marked for removal), text gets strikethrough
  - Click again → toggle back to normal
  - Click empty area in cell → new badge appears for default user (UID 1000) with thin **green border** and underlined text (marked for addition)
  - Click added badge → remove it (cancel addition)
- **Row/column hover highlight**: on cell hover, entire row and column get subtle background highlight to help track position
- Edit icon ✏️ next to key name → inline edit alias, saves to keys.txt
- Ban icon 🚫 next to key name → mark ALL of that key's accesses for removal (red borders on all badges for that row)

### Bottom Buttons
- **Reload**: POST /api/reload → refresh everything from servers
- **Reset**: client-side only, discard pending changes
- **Apply**: show confirmation popup with action list → on confirm, SSE stream progress

### Apply Popup
- List of actions: "Add key X to user Y on server Z" / "Remove key X from user Y on server Z"
- Each action gets a status icon: ⏳→🔄→✅/❌
- Auto-scroll to keep current action centered
- Log written to `execution-YYYY-MM-DD-HH-mm-ss.log`

### CLI
- `--servers <path>` or `SERVERS_FILE=<path>` env to override servers.txt
- `--port <num>` or `PORT=<num>` for web server port (default 3000)
- On start, print `http://localhost:<port>` to console

## Implementation Steps

1. **Init project**: package.json, tsconfig.json, install deps (express, ssh2, @types/*)
2. **types.ts**: Define interfaces (ServerConfig, KeyInfo, KeyPresence, PendingAction)
3. **config.ts**: Parse servers.txt and keys.txt, save key aliases
4. **ssh.ts**: SSH connect, fetch authorized_keys per user (with sudo), add/remove key operations
5. **server.ts**: Express app, API routes, CLI arg parsing, SSE for apply progress
6. **public/index.html**: Table structure, popup modal, button bar
7. **public/style.css**: Table styling, tooltips, colors, strikethrough/underline states
8. **public/app.js**: Fetch data, render table, handle clicks, pending changes, apply flow with SSE
9. **Create example servers.txt and keys.txt**

## Files to Create
- `package.json` — deps: express, ssh2, @types/express, @types/ssh2, tsx, typescript
- `tsconfig.json`
- `src/types.ts`
- `src/config.ts`
- `src/ssh.ts`
- `src/server.ts`
- `public/index.html`
- `public/style.css`
- `public/app.js`
- `servers.txt` (example template)
- `keys.txt` (empty or with example)

## Verification
1. Create sample `servers.txt` with test server entries
2. Run `npx tsx src/server.ts`
3. Open `http://localhost:3000` in browser
4. Verify table renders, tooltips work, click interactions work
5. Test apply flow with real SSH server if available
