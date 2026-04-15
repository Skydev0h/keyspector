// @ts-check

/** @type {import('../src/types').AppData | null} */
let appData = null;

/** Server profile management */
let currentProfile = 'default';
let availableProfiles = ['default'];

/** @type {Map<string, Map<string, Set<string>>>} pending removals: fingerprint → serverAlias → Set<username> */
const pendingRemove = new Map();

/** @type {Map<string, Map<string, string>>} pending additions: fingerprint → serverAlias → username */
const pendingAdd = new Map();

/** Color palette for user badges */
const USER_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6',
  '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#06b6d4',
  '#84cc16', '#e879f9', '#fb923c', '#22d3ee', '#a3e635',
];

const userColorMap = new Map();
let colorIdx = 0;

function getUserColor(username) {
  if (username === 'root') return '#c53030';
  if (!userColorMap.has(username)) {
    userColorMap.set(username, USER_COLORS[colorIdx % USER_COLORS.length]);
    colorIdx++;
  }
  return userColorMap.get(username);
}

function getUserDisplay(username) {
  if (username === 'root') return '#';
  return username.charAt(0).toUpperCase();
}

// Column hover tracking
let hoveredCol = -1;

// Loading state for progressive rendering
let loadingServers = new Set(); // server aliases still being fetched

// Column filter state: fingerprints of keys whose filter is active
const activeKeyFilters = new Set();

// Drag-and-drop state (named keys only)
let dragSrcFp = null;
let dragOverPos = 'before'; // 'before' | 'after'

// Column resize
let saveSettingsTimer = null;

function setKeyColWidth(px) {
  document.documentElement.style.setProperty('--key-col-width', px + 'px');
}

function scheduleSaveSettings() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--key-col-width'), 10);
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyColumnWidth: w }),
    }).catch(err => console.error('Failed to save settings:', err));
  }, 400);
}

function makeResizeHandle() {
  const handle = document.createElement('div');
  handle.className = 'col-resize-handle';

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--key-col-width'), 10);
    handle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      setKeyColWidth(Math.max(150, startWidth + (e.clientX - startX)));
    }
    function onUp() {
      handle.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      scheduleSaveSettings();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  return handle;
}

async function loadSettings() {
  try {
    const resp = await fetch('/api/settings');
    const s = await resp.json();
    if (s.keyColumnWidth) setKeyColWidth(s.keyColumnWidth);
    if (s.theme) applyTheme(s.theme);
  } catch (e) { /* use defaults */ }
}

// ─── Theme management ───
let currentTheme = 'auto'; // 'auto' | 'light' | 'dark'

function applyTheme(theme) {
  currentTheme = theme;
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  renderThemeToggle();
}

function renderThemeToggle() {
  const container = document.getElementById('theme-toggle');
  if (!container) return;
  container.innerHTML = '';

  const modes = [
    { key: 'auto', icon: '\uD83D\uDD04', title: 'Auto (system)' },
    { key: 'light', icon: '\u2600\uFE0F', title: 'Light' },
    { key: 'dark', icon: '\uD83C\uDF19', title: 'Dark' },
  ];

  for (const m of modes) {
    const btn = document.createElement('button');
    btn.className = 'theme-btn' + (currentTheme === m.key ? ' active' : '');
    btn.textContent = m.icon;
    btn.title = m.title;
    btn.onclick = () => {
      applyTheme(m.key);
      // Save to server settings
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: m.key }),
      }).catch(() => {});
    };
    container.appendChild(btn);
  }
}

function setColumnHighlight(colIndex) {
  if (hoveredCol === colIndex) return;
  // Remove old
  if (hoveredCol >= 0) {
    document.querySelectorAll(`.col-${hoveredCol}`).forEach(el => el.classList.remove('col-highlight'));
  }
  hoveredCol = colIndex;
  if (colIndex >= 0) {
    document.querySelectorAll(`.col-${colIndex}`).forEach(el => el.classList.add('col-highlight'));
  }
}

function hasPendingChanges() {
  for (const servers of pendingRemove.values()) {
    for (const users of servers.values()) {
      if (users.size > 0) return true;
    }
  }
  for (const servers of pendingAdd.values()) {
    for (const users of servers.values()) {
      if (users.size > 0) return true;
    }
  }
  return false;
}

function collectActions() {
  const actions = [];
  if (!appData) return actions;

  // Additions first — ensures new keys are in place before old ones are removed.
  // This is critical when replacing your own key: add the new key first so access
  // is never lost if the removal succeeds but the subsequent add would have failed.
  for (const [fp, servers] of pendingAdd) {
    const keyInfo = appData.keys.find(k => k.fingerprint === fp);
    for (const [serverAlias, usernames] of servers) {
      for (const username of usernames) {
        actions.push({
          type: 'add',
          fingerprint: fp,
          keyAlias: keyInfo?.alias || fp,
          fullKeyLine: keyInfo?.fullLine || fp,
          username,
          serverAlias,
        });
      }
    }
  }

  // Removals after additions
  for (const [fp, servers] of pendingRemove) {
    const keyInfo = appData.keys.find(k => k.fingerprint === fp);
    for (const [serverAlias, users] of servers) {
      for (const username of users) {
        actions.push({
          type: 'remove',
          fingerprint: fp,
          keyAlias: keyInfo?.alias || fp,
          fullKeyLine: keyInfo?.fullLine || fp,
          username,
          serverAlias,
        });
      }
    }
  }

  return actions;
}

function updatePendingCount() {
  const actions = collectActions();
  const el = document.getElementById('pending-count');
  const btn = document.getElementById('btn-apply');
  if (actions.length > 0) {
    el.textContent = `${actions.length} pending change${actions.length > 1 ? 's' : ''}`;
    btn.disabled = false;
  } else {
    el.textContent = '';
    btn.disabled = true;
  }
}

function render() {
  if (!appData) return;
  if (!keepPopupOnRender) closeCommentPopup();

  const headerRow = document.getElementById('header-row');
  const tbody = document.getElementById('body');
  headerRow.innerHTML = '';
  tbody.innerHTML = '';

  // Header: key name column + server columns
  const th0 = document.createElement('th');
  th0.textContent = 'Key';
  th0.appendChild(makeResizeHandle());
  headerRow.appendChild(th0);

  // Determine which servers are visible (filter: show servers with any active-filtered key)
  const visibleServerIndices = activeKeyFilters.size === 0
    ? appData.servers.map((_, i) => i)
    : appData.servers.reduce((acc, server, i) => {
        const sd = appData.serverData[server.alias];
        // Always show loading servers (don't know yet if key exists)
        if (!sd || loadingServers.has(server.alias)) { acc.push(i); return acc; }
        const hasAny = Array.from(activeKeyFilters).some(fp => (sd.keys[fp]?.length ?? 0) > 0);
        if (hasAny) acc.push(i);
        return acc;
      }, []);

  // Track which columns have errors (for cell tinting)
  const errorServerIndices = new Set();

  // Header columns
  visibleServerIndices.forEach(si => {
    const server = appData.servers[si];
    const th = document.createElement('th');
    th.classList.add(`col-${si + 1}`);
    th.setAttribute('data-tooltip', `${server.user}@${server.host}:${server.port}`);

    const sd = appData.serverData[server.alias];

    if (loadingServers.has(server.alias)) {
      th.classList.add('col-loading');
      const label = document.createElement('span');
      label.textContent = server.alias;
      th.appendChild(label);
    } else {
      th.textContent = server.alias;
      // Clickable to refresh
      th.classList.add('server-clickable');
      th.onclick = () => refreshServer(server.alias, si);
    }

    if (sd?.error) {
      th.innerHTML += ` <span class="server-error" data-tooltip="${escapeHtml(sd.error)}">!</span>`;
      th.classList.add('col-error');
      errorServerIndices.add(si);
    }

    th.addEventListener('mouseenter', () => setColumnHighlight(si + 1));
    th.addEventListener('mouseleave', () => setColumnHighlight(-1));
    headerRow.appendChild(th);
  });

  // Rows: one per key (+ separators); add the "new separator" template before unnamed keys
  let sepAddRowInserted = false;
  appData.keys.forEach(keyInfo => {
    // Insert the sep-add-row before the first unnamed key
    if (!keyInfo.isSeparator && !keyInfo.isNamed && !sepAddRowInserted) {
      tbody.appendChild(createSepAddRow(visibleServerIndices.length));
      sepAddRowInserted = true;
    }

    const tr = document.createElement('tr');

    // ── SEPARATOR ROW ──────────────────────────────────────────────────────
    if (keyInfo.isSeparator) {
      tr.classList.add('separator-row', 'draggable-row');
      tr.draggable = true;

      tr.addEventListener('dragstart', (e) => {
        dragSrcFp = keyInfo.id;
        tr.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        document.getElementById('keys-table')?.classList.add('dragging-separator');
      });
      tr.addEventListener('dragend', () => {
        dragSrcFp = null;
        document.querySelectorAll('.drag-over-before, .drag-over-after, .dragging')
          .forEach(el => el.classList.remove('drag-over-before', 'drag-over-after', 'dragging'));
        document.getElementById('keys-table')?.classList.remove('dragging-separator');
      });
      addDropTarget(tr, keyInfo);

      const td = document.createElement('td');
      td.colSpan = visibleServerIndices.length + 1;
      td.innerHTML = '<div class="separator-line-inner"><span class="separator-grip">\u283F</span></div>';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return; // nothing else to render for separators
    }

    // ── KEY ROW ────────────────────────────────────────────────────────────
    if (keyInfo.isNamed) {
      tr.draggable = true;
      tr.classList.add('draggable-row');

      tr.addEventListener('dragstart', (e) => {
        dragSrcFp = keyInfo.fingerprint;
        tr.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      tr.addEventListener('dragend', () => {
        dragSrcFp = null;
        document.querySelectorAll('.drag-over-before, .drag-over-after, .dragging')
          .forEach(el => el.classList.remove('drag-over-before', 'drag-over-after', 'dragging'));
        document.getElementById('keys-table')?.classList.remove('dragging-separator');
      });
      addDropTarget(tr, keyInfo);
    }

    // Key name cell
    const tdName = document.createElement('td');
    const nameDiv = document.createElement('div');
    nameDiv.className = 'key-name-cell';

    const aliasSpan = document.createElement('span');
    aliasSpan.className = `key-alias${keyInfo.isNamed ? '' : ' unnamed'}`;
    aliasSpan.textContent = keyInfo.alias;
    aliasSpan.title = keyInfo.fingerprint;
    nameDiv.appendChild(aliasSpan);

    // Comment stats icon — always present to keep text aligned
    const stats = appData.commentStats?.[keyInfo.fingerprint];
    const eyeIcon = document.createElement('span');
    eyeIcon.className = 'key-icon key-icon-eye';
    if (stats && stats.length > 0) {
      eyeIcon.textContent = stats.length > 1 ? '\uD83E\uDDD0' : '\uD83D\uDC40';
      eyeIcon.title = 'Key comments from servers';
      eyeIcon.onclick = (e) => {
        e.stopPropagation();
        showCommentPopup(eyeIcon, keyInfo, stats);
      };
    } else {
      eyeIcon.style.visibility = 'hidden';
      eyeIcon.textContent = '\uD83D\uDC40';
    }
    nameDiv.appendChild(eyeIcon);

    // Edit icon
    const editIcon = document.createElement('span');
    editIcon.className = 'key-icon';
    editIcon.textContent = '\u270F\uFE0F';
    editIcon.title = 'Edit alias';
    editIcon.onclick = (e) => {
      e.stopPropagation();
      startEditAlias(aliasSpan, keyInfo);
    };
    nameDiv.appendChild(editIcon);

    // ➕ Add to all visible servers (only for named keys that have a real public key line)
    if (keyInfo.isNamed) {
      const fp = keyInfo.fingerprint;

      // Visible servers where key is absent and not yet pending-add
      const serversWithout = visibleServerIndices
        .map(si => appData.servers[si])
        .filter(server => {
          if (loadingServers.has(server.alias)) return false;
          const sd = appData.serverData[server.alias];
          if (!sd) return false;
          const confirmed = (sd.keys[fp] || []).length > 0;
          const pendingAlready = (pendingAdd.get(fp)?.get(server.alias)?.size ?? 0) > 0;
          return !confirmed && !pendingAlready;
        });

      const addAllIcon = document.createElement('span');
      addAllIcon.className = 'key-icon';
      addAllIcon.textContent = '\u2795'; // ➕
      addAllIcon.title = serversWithout.length > 0
        ? `Add to ${serversWithout.length} visible server(s) missing this key`
        : 'Cancel all pending additions for this key';
      addAllIcon.onclick = (e) => {
        e.stopPropagation();
        if (serversWithout.length > 0) {
          // Add to every visible server that doesn't have it yet
          if (!pendingAdd.has(fp)) pendingAdd.set(fp, new Map());
          for (const server of serversWithout) {
            const defaultUser = appData.serverData[server.alias]?.defaultUser;
            if (defaultUser) {
              if (!pendingAdd.get(fp).has(server.alias)) pendingAdd.get(fp).set(server.alias, new Set());
              pendingAdd.get(fp).get(server.alias).add(defaultUser);
            }
          }
        } else {
          // All visible servers already have it — cancel pending additions only
          pendingAdd.delete(fp);
        }
        render();
      };
      nameDiv.appendChild(addAllIcon);
    } else {
      // Placeholder to keep alignment consistent
      const placeholder = document.createElement('span');
      placeholder.className = 'key-icon';
      placeholder.style.visibility = 'hidden';
      placeholder.textContent = '\u2795';
      nameDiv.appendChild(placeholder);
    }

    // Ban icon
    const banIcon = document.createElement('span');
    banIcon.className = 'key-icon';
    banIcon.textContent = '\uD83D\uDEAB';
    banIcon.title = 'Mark all for removal';
    banIcon.onclick = (e) => {
      e.stopPropagation();
      markAllForRemoval(keyInfo.fingerprint);
    };
    nameDiv.appendChild(banIcon);

    // Filter toggle button
    const filterIcon = document.createElement('span');
    filterIcon.className = 'key-icon' + (activeKeyFilters.has(keyInfo.fingerprint) ? ' filter-active' : '');
    filterIcon.textContent = activeKeyFilters.has(keyInfo.fingerprint) ? '\uD83D\uDD32' : '\u2B1C';
    filterIcon.title = 'Toggle server filter for this key';
    filterIcon.onclick = (e) => {
      e.stopPropagation();
      if (activeKeyFilters.has(keyInfo.fingerprint)) {
        activeKeyFilters.delete(keyInfo.fingerprint);
      } else {
        activeKeyFilters.add(keyInfo.fingerprint);
      }
      render();
    };
    nameDiv.appendChild(filterIcon);

    tdName.appendChild(nameDiv);
    tr.appendChild(tdName);

    // Dim row if filters active but this key is not one of them
    if (activeKeyFilters.size > 0 && !activeKeyFilters.has(keyInfo.fingerprint)) {
      tr.classList.add('filter-dim');
    }

    // Data cells: visible servers only
    visibleServerIndices.forEach(si => {
      const server = appData.servers[si];
      const td = document.createElement('td');
      td.classList.add(`col-${si + 1}`);
      if (errorServerIndices.has(si)) td.classList.add('col-error');
      td.addEventListener('mouseenter', () => setColumnHighlight(si + 1));
      td.addEventListener('mouseleave', () => setColumnHighlight(-1));

      if (loadingServers.has(server.alias)) {
        td.classList.add('col-loading');
        const pulse = document.createElement('div');
        pulse.className = 'cell-pulse';
        td.appendChild(pulse);
      } else {
        const sd = appData.serverData[server.alias];
        const users = sd?.keys[keyInfo.fingerprint] || [];

        const container = document.createElement('div');
        container.className = 'badge-container';

        const options = sd?.keyOptions?.[keyInfo.fingerprint] || null;
        const addedUsers = pendingAdd.get(keyInfo.fingerprint)?.get(server.alias) || new Set();

        // Build unified badge list sorted by UID (root=0 first, then ascending UID)
        const getUid = (name) => {
          if (name === 'root') return 0;
          const u = sd?.users?.find(x => x.name === name);
          return u ? u.uid : 99999;
        };
        const badgeList = [
          ...users.map(name => ({ name, isAdded: false })),
          ...Array.from(addedUsers).filter(u => !users.includes(u)).map(name => ({ name, isAdded: true })),
        ];
        badgeList.sort((a, b) => getUid(a.name) - getUid(b.name));

        for (const { name, isAdded } of badgeList) {
          const badge = createBadge(name, keyInfo.fingerprint, server.alias, isAdded, isAdded ? null : options);
          container.appendChild(badge);
        }

        const hasAdded = addedUsers.size > 0;
        if (users.length === 0 && !hasAdded) {
          container.classList.add('cell-empty');
        }

        // Determine what can be added (default user without Ctrl, root with Ctrl)
        const defaultUser = sd?.defaultUser;
        const hasDefault = defaultUser && (users.includes(defaultUser) || addedUsers.has(defaultUser));
        const hasRoot = users.includes('root') || addedUsers.has('root');
        const canAddDefault = sd && defaultUser && !hasDefault;
        const canAddRoot = sd && !hasRoot;

        if (canAddDefault) container.classList.add('cell-can-add-default');
        if (canAddRoot) container.classList.add('cell-can-add-root');

        if (canAddDefault || canAddRoot) {
          container.onclick = (e) => {
            // Only fire when clicking the container background, not a badge inside
            if (e.target !== container) return;
            const useRoot = e.ctrlKey || e.metaKey;
            const username = useRoot ? 'root' : defaultUser;
            if (!username) return;
            if (users.includes(username) || addedUsers.has(username)) return;
            if (!pendingAdd.has(keyInfo.fingerprint)) pendingAdd.set(keyInfo.fingerprint, new Map());
            if (!pendingAdd.get(keyInfo.fingerprint).has(server.alias)) pendingAdd.get(keyInfo.fingerprint).set(server.alias, new Set());
            pendingAdd.get(keyInfo.fingerprint).get(server.alias).add(username);
            render();
          };
        }

        // Right-click: show per-user context menu
        td.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (loadingServers.size > 0 || !sd || !keyInfo.isNamed) return;
          showUserContextMenu(e, keyInfo, server.alias, sd);
        });

        td.appendChild(container);
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  // If all keys are named (no unnamed keys), add the sep-add-row at the very end
  if (!sepAddRowInserted) {
    tbody.appendChild(createSepAddRow(visibleServerIndices.length));
  }

  updatePendingCount();
}

function createBadge(username, fingerprint, serverAlias, isAdded, options) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = getUserDisplay(username);
  badge.setAttribute('data-tooltip', username);
  badge.style.color = getUserColor(username);

  if (username === 'root') badge.classList.add('root');

  // Restricted key (has options like command=..., no-pty, etc.)
  if (options && !isAdded) {
    badge.classList.add('restricted');
    badge.setAttribute('data-tooltip', username + ' \uD83D\uDD12');
    badge.onclick = (e) => {
      e.stopPropagation();
      showRestrictedKeyPopup(e, fingerprint, serverAlias, username, options);
    };
    return badge;
  }

  // Check if pending removal
  const isRemoved = pendingRemove.get(fingerprint)?.get(serverAlias)?.has(username);

  if (isAdded) {
    badge.classList.add('pending-add');
    badge.onclick = (e) => {
      e.stopPropagation();
      // Cancel addition for this specific user
      pendingAdd.get(fingerprint)?.get(serverAlias)?.delete(username);
      render();
    };
  } else if (isRemoved) {
    badge.classList.add('pending-remove');
    badge.onclick = (e) => {
      e.stopPropagation();
      // Cancel removal
      pendingRemove.get(fingerprint)?.get(serverAlias)?.delete(username);
      render();
    };
  } else {
    badge.onclick = (e) => {
      e.stopPropagation();
      // Mark for removal
      if (!pendingRemove.has(fingerprint)) pendingRemove.set(fingerprint, new Map());
      if (!pendingRemove.get(fingerprint).has(serverAlias)) pendingRemove.get(fingerprint).set(serverAlias, new Set());
      pendingRemove.get(fingerprint).get(serverAlias).add(username);
      render();
    };
  }

  return badge;
}

// Comment stats popup
let activePopup = null;
let keepPopupOnRender = false;

function closeCommentPopup() {
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
  keepPopupOnRender = false;
  document.removeEventListener('click', onDocClickClosePopup);
}

function onDocClickClosePopup(e) {
  if (activePopup && !activePopup.contains(e.target)) {
    closeCommentPopup();
  }
}

// --- Restricted key info popup ---
function showRestrictedKeyPopup(event, fingerprint, serverAlias, username, optionsStr) {
  closeCommentPopup();

  const popup = document.createElement('div');
  popup.className = 'comment-popup restricted-popup';

  // Header
  const header = document.createElement('div');
  header.className = 'restricted-popup-header';
  header.textContent = `\uD83D\uDD12 Special key — ${username}@${serverAlias}`;
  popup.appendChild(header);

  // Parse options into individual items
  // Options can contain quoted strings with commas inside, e.g. command="rrsync /path,opt"
  const optionItems = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < optionsStr.length; i++) {
    const ch = optionsStr[i];
    if (ch === '"') { inQuotes = !inQuotes; current += ch; }
    else if (ch === ',' && !inQuotes) { optionItems.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  if (current.trim()) optionItems.push(current.trim());

  for (const opt of optionItems) {
    const row = document.createElement('div');
    row.className = 'restricted-popup-row';

    const eqIdx = opt.indexOf('=');
    if (eqIdx > 0) {
      const key = opt.slice(0, eqIdx);
      const val = opt.slice(eqIdx + 1).replace(/^"|"$/g, '');
      const keyEl = document.createElement('span');
      keyEl.className = 'restricted-opt-key';
      keyEl.textContent = key;
      row.appendChild(keyEl);
      const valEl = document.createElement('span');
      valEl.className = 'restricted-opt-val';
      valEl.textContent = val;
      valEl.title = val;
      row.appendChild(valEl);
    } else {
      const keyEl = document.createElement('span');
      keyEl.className = 'restricted-opt-key restricted-opt-flag';
      keyEl.textContent = opt;
      row.appendChild(keyEl);
    }

    popup.appendChild(row);
  }

  // Fingerprint row
  const fpRow = document.createElement('div');
  fpRow.className = 'restricted-popup-row restricted-popup-fp';
  fpRow.textContent = fingerprint.length > 60 ? fingerprint.slice(0, 30) + '...' + fingerprint.slice(-20) : fingerprint;
  fpRow.title = fingerprint;
  popup.appendChild(fpRow);

  // Position at mouse cursor
  popup.style.position = 'fixed';
  popup.style.top = event.clientY + 'px';
  popup.style.left = event.clientX + 'px';
  document.body.appendChild(popup);

  const rect = popup.getBoundingClientRect();
  if (rect.right > window.innerWidth) popup.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) popup.style.top = (window.innerHeight - rect.height - 8) + 'px';

  activePopup = popup;
  setTimeout(() => document.addEventListener('click', onDocClickClosePopup), 0);
}

// --- Right-click context menu: per-user key management ---
function showUserContextMenu(event, keyInfo, serverAlias, sd) {
  closeCommentPopup();

  const fp = keyInfo.fingerprint;
  const serverUsers = [...(sd.users || [])].sort((a, b) => a.uid - b.uid);
  if (serverUsers.length === 0) return;

  const existingUsers = sd.keys[fp] || [];
  const hasOptions = !!sd.keyOptions?.[fp]; // Special key — no modifications allowed

  const popup = document.createElement('div');
  popup.className = 'comment-popup user-context-menu';

  // Helper to (re)build rows from current pending state
  function buildRows() {
    popup.innerHTML = '';
    for (const { name, uid } of serverUsers) {
      const hasKey = existingUsers.includes(name);
      const isPendingRemove = pendingRemove.get(fp)?.get(serverAlias)?.has(name);
      const isPendingAdd = pendingAdd.get(fp)?.get(serverAlias)?.has(name);
      const isActive = hasKey || isPendingAdd;

      const row = document.createElement('div');
      row.className = 'comment-popup-row ctx-user-row';
      if (!isActive && !isPendingRemove) row.classList.add('ctx-user-dim');

      // UID chip
      const uidEl = document.createElement('span');
      uidEl.className = 'ctx-uid';
      uidEl.textContent = String(uid);
      if (name === 'root') uidEl.classList.add('ctx-uid-root');
      uidEl.style.color = getUserColor(name);
      if (isPendingAdd) uidEl.classList.add('ctx-uid-add');
      else if (isPendingRemove) uidEl.classList.add('ctx-uid-remove');
      row.appendChild(uidEl);

      // Username text
      const nameEl = document.createElement('span');
      nameEl.className = 'ctx-username';
      nameEl.textContent = name;
      nameEl.style.color = getUserColor(name);
      if (isPendingAdd) nameEl.classList.add('ctx-text-add');
      else if (isPendingRemove) nameEl.classList.add('ctx-text-remove');
      row.appendChild(nameEl);

      // Click handler: toggle like a checkbox (disabled for special keys)
      if (hasOptions && hasKey) {
        row.style.cursor = 'default';
        row.title = 'Special key — cannot modify';
      } else {
        row.onclick = (e) => {
          e.stopPropagation();
          if (hasKey && !isPendingRemove) {
            if (!pendingRemove.has(fp)) pendingRemove.set(fp, new Map());
            if (!pendingRemove.get(fp).has(serverAlias)) pendingRemove.get(fp).set(serverAlias, new Set());
            pendingRemove.get(fp).get(serverAlias).add(name);
          } else if (hasKey && isPendingRemove) {
            pendingRemove.get(fp)?.get(serverAlias)?.delete(name);
          } else if (!hasKey && isPendingAdd) {
            pendingAdd.get(fp)?.get(serverAlias)?.delete(name);
          } else if (!hasKey && !isPendingAdd) {
            if (!pendingAdd.has(fp)) pendingAdd.set(fp, new Map());
            if (!pendingAdd.get(fp).has(serverAlias)) pendingAdd.get(fp).set(serverAlias, new Set());
            pendingAdd.get(fp).get(serverAlias).add(name);
          }
          buildRows();
          render();
        };
      }

      popup.appendChild(row);
    }
  }

  buildRows();

  // Position at mouse cursor
  popup.style.position = 'fixed';
  popup.style.top = event.clientY + 'px';
  popup.style.left = event.clientX + 'px';
  document.body.appendChild(popup);

  // Adjust if it overflows viewport
  const rect = popup.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    popup.style.left = (window.innerWidth - rect.width - 8) + 'px';
  }
  if (rect.bottom > window.innerHeight) {
    popup.style.top = (window.innerHeight - rect.height - 8) + 'px';
  }

  activePopup = popup;
  keepPopupOnRender = true;

  // Close when mouse moves ~15px away from popup bounds
  const MARGIN = 15;
  const onMouseMove = (e) => {
    if (!activePopup) { document.removeEventListener('mousemove', onMouseMove); return; }
    const r = activePopup.getBoundingClientRect();
    if (e.clientX < r.left - MARGIN || e.clientX > r.right + MARGIN ||
        e.clientY < r.top - MARGIN || e.clientY > r.bottom + MARGIN) {
      document.removeEventListener('mousemove', onMouseMove);
      closeCommentPopup();
    }
  };
  setTimeout(() => document.addEventListener('mousemove', onMouseMove), 0);
}

function showCommentPopup(anchor, keyInfo, stats) {
  closeCommentPopup();

  const popup = document.createElement('div');
  popup.className = 'comment-popup';

  for (const { comment, count } of stats) {
    const row = document.createElement('div');
    row.className = 'comment-popup-row';

    const countEl = document.createElement('span');
    countEl.className = 'comment-count';
    countEl.textContent = String(count);
    row.appendChild(countEl);

    const textEl = document.createElement('span');
    textEl.className = 'comment-text';
    textEl.textContent = comment;
    row.appendChild(textEl);

    row.onclick = async (e) => {
      e.stopPropagation();
      closeCommentPopup();
      try {
        await fetch('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint: keyInfo.fingerprint, alias: comment }),
        });
        keyInfo.alias = comment;
        keyInfo.isNamed = true;
      } catch (err) {
        console.error('Failed to save alias:', err);
      }
      render();
    };

    popup.appendChild(row);
  }

  // Position popup in document body, aligned to anchor
  const rect = anchor.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.top = (rect.bottom + 4) + 'px';
  popup.style.left = rect.left + 'px';
  document.body.appendChild(popup);
  activePopup = popup;

  // Close on outside click (next tick to avoid immediate close)
  setTimeout(() => document.addEventListener('click', onDocClickClosePopup), 0);
}

function startEditAlias(span, keyInfo) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'alias-input';
  input.value = keyInfo.isNamed ? keyInfo.alias : '';
  input.placeholder = 'Enter alias...';

  span.replaceWith(input);
  input.focus();
  input.select();

  let saved = false;
  const save = async () => {
    if (saved) return;
    saved = true;
    const newAlias = input.value.trim();
    if (newAlias && newAlias !== keyInfo.alias) {
      try {
        await fetch('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint: keyInfo.fingerprint, alias: newAlias }),
        });
        keyInfo.alias = newAlias;
        keyInfo.isNamed = true;
      } catch (err) {
        console.error('Failed to save alias:', err);
      }
    }
    render();
  };

  input.onblur = save;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { saved = true; render(); }
  };
}

function markAllForRemoval(fingerprint) {
  if (!appData) return;

  // Check if already all (non-special) marked — if so, unmark all
  let allMarked = true;
  for (const server of appData.servers) {
    const sd = appData.serverData[server.alias];
    const users = sd?.keys[fingerprint] || [];
    const hasOptions = !!sd?.keyOptions?.[fingerprint];
    if (hasOptions) continue; // Skip special keys entirely
    for (const u of users) {
      if (!pendingRemove.get(fingerprint)?.get(server.alias)?.has(u)) {
        allMarked = false;
        break;
      }
    }
    if (!allMarked) break;
  }

  if (allMarked) {
    // Unmark all
    pendingRemove.delete(fingerprint);
  } else {
    // Mark all (skip special keys with options)
    if (!pendingRemove.has(fingerprint)) pendingRemove.set(fingerprint, new Map());
    for (const server of appData.servers) {
      const sd = appData.serverData[server.alias];
      const hasOptions = !!sd?.keyOptions?.[fingerprint];
      if (hasOptions) continue; // Don't mark special keys for removal
      const users = sd?.keys[fingerprint] || [];
      if (users.length > 0) {
        if (!pendingRemove.get(fingerprint).has(server.alias)) {
          pendingRemove.get(fingerprint).set(server.alias, new Set());
        }
        for (const u of users) {
          pendingRemove.get(fingerprint).get(server.alias).add(u);
        }
      }
    }
  }

  render();
}

function resetPending() {
  pendingRemove.clear();
  pendingAdd.clear();
  render();
}

// ─── Separator / reorder helpers ────────────────────────────────────────────

/** POST the full named-entries order (keys + separators) to the server */
function saveOrder(namedEntries) {
  fetch('/api/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entries: namedEntries.map(e => e.isSeparator ? { sep: true } : { fp: e.fingerprint }),
    }),
  }).catch(err => console.error('Reorder failed:', err));
}

/** Move or insert src entry before/after tgtKeyInfo and persist */
function handleDrop(tgtKeyInfo, pos) {
  if (!dragSrcFp) return;

  const namedEntries = appData.keys.filter(k => k.isSeparator || k.isNamed);
  const unnamedKeys  = appData.keys.filter(k => !k.isSeparator && !k.isNamed);

  let srcEntry;
  if (dragSrcFp === 'sep:new') {
    // Brand new separator – doesn't exist in the list yet
    srcEntry = { isSeparator: true, id: 'sep:t:' + Date.now(), fullLine: '---' };
  } else if (dragSrcFp.startsWith('sep:')) {
    // Existing separator – remove from its current position
    const isSameTgt = tgtKeyInfo.isSeparator && tgtKeyInfo.id === dragSrcFp;
    if (isSameTgt) return;
    const srcIdx = namedEntries.findIndex(e => e.isSeparator && e.id === dragSrcFp);
    if (srcIdx === -1) return;
    [srcEntry] = namedEntries.splice(srcIdx, 1);
  } else {
    // Named key
    const isSameTgt = !tgtKeyInfo.isSeparator && tgtKeyInfo.fingerprint === dragSrcFp;
    if (isSameTgt) return;
    const srcIdx = namedEntries.findIndex(e => !e.isSeparator && e.fingerprint === dragSrcFp);
    if (srcIdx === -1) return;
    [srcEntry] = namedEntries.splice(srcIdx, 1);
  }

  const tgtIdx = tgtKeyInfo.isSeparator
    ? namedEntries.findIndex(e => e.isSeparator && e.id === tgtKeyInfo.id)
    : namedEntries.findIndex(e => !e.isSeparator && e.fingerprint === tgtKeyInfo.fingerprint);

  const insertIdx = tgtIdx === -1 ? namedEntries.length : (pos === 'before' ? tgtIdx : tgtIdx + 1);
  namedEntries.splice(insertIdx, 0, srcEntry);

  appData.keys = [...namedEntries, ...unnamedKeys];
  saveOrder(namedEntries);
  dragSrcFp = null;
  render();
}

/** Delete a separator by id and persist */
function applyDelete(sepId) {
  const namedEntries = appData.keys.filter(k => k.isSeparator || k.isNamed);
  const unnamedKeys  = appData.keys.filter(k => !k.isSeparator && !k.isNamed);
  const idx = namedEntries.findIndex(e => e.isSeparator && e.id === sepId);
  if (idx !== -1) namedEntries.splice(idx, 1);
  appData.keys = [...namedEntries, ...unnamedKeys];
  saveOrder(namedEntries);
  dragSrcFp = null;
  render();
}

/** Attach dragover / dragleave / drop handlers to a row that acts as a drop target */
function addDropTarget(tr, keyInfo) {
  tr.addEventListener('dragover', (e) => {
    if (!dragSrcFp) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = tr.getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    dragOverPos = pos;
    document.querySelectorAll('.drag-over-before, .drag-over-after')
      .forEach(el => el.classList.remove('drag-over-before', 'drag-over-after'));
    const isSameSrc = keyInfo.isSeparator
      ? dragSrcFp === keyInfo.id
      : dragSrcFp === keyInfo.fingerprint;
    if (!isSameSrc) tr.classList.add(`drag-over-${pos}`);
  });

  tr.addEventListener('dragleave', (e) => {
    if (!tr.contains(e.relatedTarget))
      tr.classList.remove('drag-over-before', 'drag-over-after');
  });

  tr.addEventListener('drop', (e) => {
    e.preventDefault();
    tr.classList.remove('drag-over-before', 'drag-over-after');
    handleDrop(keyInfo, dragOverPos);
  });
}

/** Create the "add separator" / "delete separator" template row shown at bottom of named keys */
function createSepAddRow(colCount) {
  const tr = document.createElement('tr');
  tr.classList.add('sep-add-row');

  const td = document.createElement('td');
  td.colSpan = colCount + 1;
  td.innerHTML =
    '<div class="sep-add-hint">' +
      '<span class="sep-add-line"></span>' +
      '<span class="sep-add-label">drag to add separator</span>' +
      '<span class="sep-add-line"></span>' +
    '</div>' +
    '<div class="sep-delete-hint">✕ drop here to delete separator</div>';

  // Draggable — to create a new separator by dropping it on a row
  tr.draggable = true;
  tr.addEventListener('dragstart', (e) => {
    dragSrcFp = 'sep:new';
    tr.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  tr.addEventListener('dragend', () => {
    dragSrcFp = null;
    document.querySelectorAll('.drag-over-before, .drag-over-after, .dragging')
      .forEach(el => el.classList.remove('drag-over-before', 'drag-over-after', 'dragging'));
    document.getElementById('keys-table')?.classList.remove('dragging-separator');
  });

  // Drop target — accepts existing separators for deletion
  tr.addEventListener('dragover', (e) => {
    if (!dragSrcFp?.startsWith('sep:') || dragSrcFp === 'sep:new') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tr.classList.add('drag-over-delete');
  });
  tr.addEventListener('dragleave', (e) => {
    if (!tr.contains(e.relatedTarget)) tr.classList.remove('drag-over-delete');
  });
  tr.addEventListener('drop', (e) => {
    if (!dragSrcFp?.startsWith('sep:') || dragSrcFp === 'sep:new') return;
    e.preventDefault();
    tr.classList.remove('drag-over-delete');
    applyDelete(dragSrcFp);
  });

  tr.appendChild(td);
  return tr;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Apply flow
function showApplyModal() {
  const actions = collectActions();
  if (actions.length === 0) return;

  const overlay = document.getElementById('modal-overlay');
  const actionsDiv = document.getElementById('modal-actions');
  const buttonsDiv = document.getElementById('modal-buttons');
  const title = document.getElementById('modal-title');

  title.textContent = `Confirm ${actions.length} Action${actions.length > 1 ? 's' : ''}`;
  actionsDiv.innerHTML = '';

  actions.forEach((action, i) => {
    const div = document.createElement('div');
    div.className = 'modal-action';
    div.id = `action-${i}`;

    const icon = document.createElement('span');
    icon.className = 'action-icon';
    icon.textContent = '\u23F3'; // hourglass
    div.appendChild(icon);

    const text = document.createElement('span');
    text.className = `action-text action-type-${action.type}`;
    text.textContent = action.type === 'add'
      ? `Add "${action.keyAlias}" to ${action.username} on ${action.serverAlias}`
      : `Remove "${action.keyAlias}" from ${action.username} on ${action.serverAlias}`;
    div.appendChild(text);

    actionsDiv.appendChild(div);
  });

  buttonsDiv.innerHTML = '';

  // Parallel execution checkbox
  const parallelLabel = document.createElement('label');
  parallelLabel.className = 'parallel-label';
  const parallelCheckbox = document.createElement('input');
  parallelCheckbox.type = 'checkbox';
  parallelCheckbox.id = 'parallel-checkbox';
  parallelLabel.appendChild(parallelCheckbox);
  parallelLabel.appendChild(document.createTextNode('\u00A0Parallel execution'));
  parallelLabel.title = 'Run actions concurrently: all adds first (barrier), then all removes. Max 1 action per server at a time.';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.textContent = 'Confirm';
  confirmBtn.onclick = () => executeActions(actions, parallelCheckbox.checked);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => overlay.classList.add('hidden');

  buttonsDiv.appendChild(parallelLabel);
  buttonsDiv.appendChild(confirmBtn);
  buttonsDiv.appendChild(cancelBtn);

  overlay.classList.remove('hidden');
}

async function executeActions(actions, parallel = false) {
  const buttonsDiv = document.getElementById('modal-buttons');
  const actionsDiv = document.getElementById('modal-actions');
  buttonsDiv.innerHTML = '';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn';
  closeBtn.textContent = 'Close';
  closeBtn.disabled = true;
  closeBtn.onclick = async () => {
    document.getElementById('modal-overlay').classList.add('hidden');
    resetPending();
    await loadData();
  };
  buttonsDiv.appendChild(closeBtn);

  try {
    const resp = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions, parallel, profile: currentProfile }),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));

        if (data.done) {
          closeBtn.disabled = false;
          continue;
        }

        const el = document.getElementById(`action-${data.index}`);
        if (!el) continue;

        const iconEl = el.querySelector('.action-icon');

        if (data.status === 'running') {
          iconEl.innerHTML = '<span class="spinner"></span>';
          // Only scroll in sequential mode to avoid jumpy behavior
          if (!parallel) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (data.status === 'success') {
          iconEl.textContent = '\u2705'; // green check
        } else if (data.status === 'error') {
          iconEl.textContent = '\u274C'; // red X
          const errSpan = document.createElement('span');
          errSpan.className = 'action-error';
          errSpan.textContent = ' error';
          errSpan.title = data.error || 'Unknown error';
          el.appendChild(errSpan);
        }
      }
    }
  } catch (err) {
    console.error('Apply failed:', err);
    closeBtn.disabled = false;
  }
}

async function refreshServer(alias, serverIndex) {
  if (loadingServers.has(alias)) return; // already loading

  // Mark as loading and re-render to show pulse
  loadingServers.add(alias);
  render();

  try {
    const profileParam = currentProfile !== 'default' ? `&profile=${encodeURIComponent(currentProfile)}` : '';
    const resp = await fetch(`/api/refresh-server?alias=${encodeURIComponent(alias)}${profileParam}`);
    const result = await resp.json();

    loadingServers.delete(alias);
    appData.serverData[alias] = result.data;

    // Add any new keys discovered
    for (const newKey of (result.newKeys || [])) {
      if (!appData.keys.find(k => !k.isSeparator && k.fingerprint === newKey.fingerprint)) {
        appData.keys.push(newKey);
      }
    }
  } catch (err) {
    loadingServers.delete(alias);
    console.error(`Failed to refresh ${alias}:`, err);
  }

  render();
}

async function streamData(isReload = false) {
  const status = document.getElementById('status');
  if (isReload) {
    resetPending();
    status.textContent = 'Reloading...';
  } else {
    status.textContent = 'Loading...';
  }

  userColorMap.clear();
  colorIdx = 0;
  appData = { servers: [], keys: [], serverData: {}, commentStats: {} };
  loadingServers = new Set();

  try {
    const profileParam = currentProfile !== 'default' ? `?profile=${encodeURIComponent(currentProfile)}` : '';
    const resp = await fetch('/api/stream' + profileParam);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));

          if (currentEvent === 'init') {
            appData.servers = data.servers;
            appData.keys = data.keys;
            appData.serverData = {};
            appData.commentStats = {};
            loadingServers = new Set(data.servers.map(s => s.alias));
            status.textContent = `${appData.servers.length} servers — loading...`;
            render();

          } else if (currentEvent === 'server') {
            loadingServers.delete(data.alias);
            appData.serverData[data.alias] = data.data;
            // Append new keys discovered on this server (skip separators when checking)
            for (const newKey of (data.newKeys || [])) {
              if (!appData.keys.find(k => !k.isSeparator && k.fingerprint === newKey.fingerprint)) {
                appData.keys.push(newKey);
              }
            }
            const loaded = appData.servers.length - loadingServers.size;
            status.textContent = `${appData.servers.length} servers — ${loaded}/${appData.servers.length} loaded`;
            render();

          } else if (currentEvent === 'done') {
            appData.commentStats = data.commentStats;
            loadingServers = new Set();
            const keyCount = appData.keys.filter(k => !k.isSeparator).length;
            status.textContent = `${appData.servers.length} servers, ${keyCount} keys`;
            render();
          }

          currentEvent = '';
        }
      }
    }
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
}

async function loadData() {
  return streamData(false);
}

async function reloadData() {
  return streamData(true);
}

// Wire up buttons
document.getElementById('btn-reload').onclick = reloadData;
document.getElementById('btn-reset').onclick = () => { resetPending(); };
document.getElementById('btn-apply').onclick = showApplyModal;

// Warn before leaving if there are unsaved pending changes
window.addEventListener('beforeunload', (e) => {
  if (hasPendingChanges()) {
    e.preventDefault();
    e.returnValue = ''; // Required for Chrome/Edge to show the dialog
  }
});

// --- Profile tab management ---
async function loadProfiles() {
  try {
    const resp = await fetch('/api/profiles');
    availableProfiles = await resp.json();
  } catch { availableProfiles = ['default']; }

  // Pick up ?profile=X from URL, fall back to default if unknown
  const urlProfile = new URLSearchParams(window.location.search).get('profile');
  if (urlProfile && availableProfiles.includes(urlProfile)) {
    currentProfile = urlProfile;
  }
  updateUrlForProfile(); // normalize URL (strips invalid profile, or removes ?profile=default)
  renderProfileTabs();
}

/** Reflect current profile in URL without navigation */
function updateUrlForProfile() {
  const url = new URL(window.location.href);
  if (currentProfile === 'default') {
    url.searchParams.delete('profile');
  } else {
    url.searchParams.set('profile', currentProfile);
  }
  history.replaceState(null, '', url.toString());
}

function renderProfileTabs() {
  const container = document.getElementById('profile-tabs');
  container.innerHTML = '';
  if (availableProfiles.length <= 1) return; // No tabs if only one profile

  for (const name of availableProfiles) {
    const tab = document.createElement('span');
    tab.className = 'profile-tab' + (name === currentProfile ? ' active' : '');
    tab.textContent = name;
    tab.onclick = () => switchProfile(name);
    container.appendChild(tab);
  }
}

function switchProfile(name) {
  if (name === currentProfile) return;
  if (hasPendingChanges()) {
    if (!confirm('You have unsaved changes. Switch profile and discard them?')) return;
  }
  currentProfile = name;
  updateUrlForProfile();
  resetPending();
  renderProfileTabs();
  streamData(false);
}

// Track Ctrl/Meta modifier state on body so CSS can toggle hover colors
function updateCtrlHeld(e) {
  document.body.classList.toggle('ctrl-held', !!(e.ctrlKey || e.metaKey));
}
window.addEventListener('keydown', updateCtrlHeld);
window.addEventListener('keyup', updateCtrlHeld);
window.addEventListener('mousemove', updateCtrlHeld);
window.addEventListener('blur', () => document.body.classList.remove('ctrl-held'));

// Initial load: settings + profiles, then data
loadSettings().then(() => {
  renderThemeToggle(); // ensure toggle is drawn even if no saved theme
  return loadProfiles();
}).then(() => loadData());
