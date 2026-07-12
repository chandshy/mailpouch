// src/settings/shell.ts
import nodePath from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { ALL_TOOLS, TOOL_CATEGORIES } from "../config/schema.js";
import { buildStyles } from "./styles.js";

const _moduleDir = nodePath.dirname(fileURLToPath(import.meta.url));
const _pkgJsonPath = nodePath.resolve(_moduleDir, "../../package.json");

export function buildShellHtml(csrfToken: string, runningPort = 8766, cspNonce = ""): string {
  const toolsJson = JSON.stringify(ALL_TOOLS);
  const categoriesJson = JSON.stringify(TOOL_CATEGORIES);
  const distIndexPath = JSON.stringify(nodePath.resolve(_moduleDir, "../index.js"));

  let pkgVersion = "unknown";
  let pkgName = "mailpouch";
  try {
    const pkgJson = JSON.parse(readFileSync(_pkgJsonPath, "utf-8")) as { version?: string; name?: string };
    if (pkgJson.version) pkgVersion = pkgJson.version;
    if (pkgJson.name)    pkgName    = pkgJson.name;
  } catch { /* use defaults */ }
  const pkgVersionJson  = JSON.stringify(pkgVersion);
  const pkgNameJson     = JSON.stringify(pkgName);
  const runningPortJson = JSON.stringify(runningPort);

  return `<!DOCTYPE html>
<!-- NEW WIZARD UI -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="csrf-token" content="${csrfToken}">
<title>mailpouch — Settings</title>
${buildStyles(cspNonce)}
</head>
<body>

<header>
  <div class="logo-wrap">
    <div class="logo-icon">✉</div>
    <div>
      <div class="header-title">mailpouch</div>
      <div class="header-subtitle">Settings</div>
    </div>
  </div>
  <div class="header-spacer"></div>
  <div class="status-pill" id="header-status">
    <div class="dot" id="config-dot"></div>
    <span id="config-status-text">Loading…</span>
  </div>
  <a href="/agent-setup"
     target="_blank"
     rel="noopener"
     class="btn-agent-ref"
     title="Integration reference for AI agents — share this URL with your agent so it has a copy-paste-ready guide to connect">
    For your Agent ↗
  </a>
  <button class="btn-shutdown" id="shutdown-btn" data-action="shutdownServer" title="Stop the settings server">⏹ Shutdown</button>
</header>

<!-- ══ POST-SETUP NAV (hidden until config saved) ══ -->
<nav id="main-nav" style="display:none">
  <button class="active" data-tab="setup">Setup</button>
  <button data-tab="accounts">Accounts</button>
  <button data-tab="permissions">Permissions</button>
  <button data-tab="agents">
    Agents
    <span id="agents-pending-badge" style="display:none;background:#ef4444;color:#fff;border-radius:10px;padding:2px 7px;margin-left:6px;font-size:11px;font-weight:700">0</span>
  </button>
  <button data-tab="status">Status</button>
  <button id="logs-tab-btn" style="display:none" data-tab="logs">Logs</button>
</nav>

<!-- ══ ESCALATION BANNER (shown on all views when pending) ══ -->
<div id="escalation-banner">
  <div class="escalation-banner-title">
    <span>⚠</span>
    <span>AI Permission Escalation Request — Human Approval Required</span>
  </div>
  <div id="escalation-cards"></div>
</div>

<!-- TLS warning banner -->
<div id="tls-warning" style="display:none;background:#ff6b00;color:white;padding:8px 16px;font-size:0.9em">
  &#9888; TLS certificate validation is disabled. Configure the Bridge Certificate Path in Settings &rarr; Connection to secure your connection.
</div>

<div id="wizard-view"></div>

<div id="settings-view" style="display:none">
<main>
<section id="setup" class="active"></section>
<section id="permissions"></section>
<section id="accounts"></section>
<section id="agents"></section>
<section id="status"></section>
<section id="logs"></section>
</main>
</div>

<div id="toast" role="status" aria-live="polite"></div>

<script nonce="${cspNonce}">
(function() {
  // ── Constants ─────────────────────────────────────────────────────────────
  const ALL_TOOLS  = ${toolsJson};
  const CATEGORIES = ${categoriesJson};
  const __distIndexPath = ${distIndexPath};
  const PKG_VERSION   = ${pkgVersionJson};
  const PKG_NAME      = ${pkgNameJson};
  const RUNNING_PORT  = ${runningPortJson};

  // ── State ─────────────────────────────────────────────────────────────────
  let cfg            = null;
  let toolEnabled    = {};
  let toolRate       = {};
  let customSnapshot = null; // saved custom tool state, keyed by tool name
  let _accountsById  = {};
  let __mpReloading  = false;
  let __mpLanSessionNoticeShown = false;
  // Empty auxiliary-secret inputs normally mean "not disclosed; retain".
  // Only the explicit Clear controls below set one of these flags.
  let pendingAuxiliarySecretClears = { simpleloginApiKey: false, passAccessToken: false };

  // Wizard in-progress state
  const W = {
    smtpHost: 'localhost', smtpPort: 1025,
    imapHost: 'localhost', imapPort: 1143,
    certPath: '',
    username: '', debug: false,
    preset: 'read_only',
    bridgeTested: false,
    credsSaved: false,
    presetSaved: false,
  };

  // ── CSRF ──────────────────────────────────────────────────────────────────
  const CSRF = document.querySelector('meta[name="csrf-token"]')?.content || '';

  // Auto-recover from stale CSRF tokens. The server's CSRF token is minted
  // per-process — when the daemon restarts (e.g. after install-update or a
  // crash), any open settings tab holds a token the new process rejects with
  // 403 { code: "session_expired" }. Without this wrapper the user sees a
  // raw "Missing or invalid CSRF token" alert and has no idea what to do;
  // with it, the page silently reloads and picks up the fresh token. Guarded
  // by __mpReloading so concurrent mutations only trigger one reload.
  (function installCsrfAutoReload() {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function(...args) {
      const response = await originalFetch(...args);
      if (response.status === 403 && !__mpReloading) {
        try {
          const clone = response.clone();
          const body = await clone.json();
          if (body && body.code === 'session_expired') {
            __mpReloading = true;
            try { window.location.reload(); } catch (_) { /* ignore */ }
          }
        } catch (_) { /* not JSON — not ours */ }
      }
      // LAN browser sessions live only in the settings-server process. After
      // that process restarts, the HttpOnly cookie is deliberately useless;
      // reloading cannot recover because the bootstrap bearer was removed from
      // the URL. Give the operator the actionable next step instead of making
      // each individual fetch failure look unrelated.
      if (response.status === 401 && !__mpLanSessionNoticeShown) {
        try {
          const clone = response.clone();
          const body = await clone.json();
          if (body && body.code === 'lan_session_required') {
            __mpLanSessionNoticeShown = true;
            toast('LAN settings session expired. Reopen the secure settings URL shown by mailpouch.', 'warn');
          }
        } catch (_) { /* not JSON — not ours */ }
      }
      return response;
    };
  })();

  // ── Central event delegation ───────────────────────────────────────────────
  // CSP3: when a nonce is present in script-src, 'unsafe-inline' is completely
  // ignored for ALL inline scripts including event handlers. All button wiring
  // must go through these delegated listeners — no onclick= attributes anywhere.
  document.addEventListener('click', function(e) {
    // Prevent category toggle when clicking the All checkbox label inside the header
    if (e.target.closest('.category-header .toggle-wrap')) return;
    const tabEl = e.target.closest('[data-tab]');
    if (tabEl && !tabEl.disabled) { e.preventDefault(); showTab(tabEl.dataset.tab, tabEl); return; }
    const el = e.target.closest('[data-action]');
    if (el && !el.disabled) { e.preventDefault(); _dispatch(el.dataset.action, el); }
  });
  document.addEventListener('input', function(e) {
    const el = e.target.closest('[data-input]');
    if (el) _dispatch(el.dataset.input, el);
  });
  // Replaces former inline onsubmit="return false" handlers (CSP nonce'd
  // script-src ignores 'unsafe-inline' event-handler attributes).
  document.addEventListener('submit', function(e) {
    if (e.target.closest('[data-submit]')) e.preventDefault();
  });
  document.addEventListener('change', function(e) {
    // Grant modal duration radio buttons don't use data-change — handle directly
    if (e.target.name === 'gm-dur') {
      document.getElementById('gm-custom-expiry').style.display = (e.target.value === 'custom') ? '' : 'none';
    }
    const el = e.target.closest('[data-change]');
    if (el) _dispatch(el.dataset.change, el);
  });

  function _dispatch(action, el) {
    switch (action) {
      // Shared confirm modal
      case 'confirmModalOk':            return confirmModalOk();
      case 'confirmModalCancel':        return confirmModalCancel();
      // Shell / view
      case 'shutdownServer':            return shutdownServer();
      case 'openSettingsView':          return openSettingsView();
      // Setup tab
      case 'saveSetup':                 return saveSetup();
      case 'testConnections':           return testConnections();
      case 'detectCertPath':            return detectCertPath();
      case 'searchBridgePath':          return searchBridgePath();
      case 'togglePw':                  return togglePw(el.dataset.target);
      case 'clearAuxiliarySecret':      return clearAuxiliarySecret(el.dataset.secret);
      case 'uploadCertBridge':          return document.getElementById('bridge-cert-file').click();
      case 'setMode':                   return setMode(el.dataset.mode);
      case 'updateSmtpTokenVisibility': return updateSmtpTokenVisibility();
      case 'checkPortMismatch':         return checkPortMismatch();
      case 'resetPort':                 return void (document.getElementById(el.dataset.field).value = el.dataset.value);
      // Permissions tab
      case 'savePermissions':           return savePermissions();
      case 'applyPreset':               return applyPreset(el.dataset.preset);
      case 'restoreCustom':             return restoreCustom();
      case 'toggleCategory':            return toggleCategory(el);
      case 'toggleCategoryAll':         return toggleCategoryAll(el.dataset.cat, el.checked);
      case 'onToolToggle':              return onToolToggle(el.dataset.tool, el.checked);
      // Accounts tab
      case 'openAccountForm':           return openAccountForm(el.dataset.providerType, null);
      case 'editAccount':               return editAccount(el.dataset.id);
      case 'deleteAccountConfirm':      return deleteAccountConfirm(el.dataset.id);
      case 'activateAccount':           return activateAccount(el.dataset.id);
      case 'closeAccountForm':          return closeAccountForm();
      case 'saveAccountForm':           return saveAccountForm();
      case 'detectCertPathAf':          return detectCertPath('af-cert');
      case 'uploadCertAf':              return document.getElementById('af-cert-file').click();
      // Agents tab
      case 'switchAgentFilter':         return switchAgentFilter(el.dataset.filter);
      case 'approveGrant':              return approveGrant(el.dataset.id, el.dataset.preset);
      case 'denyGrant':                 return denyGrant(el.dataset.id);
      case 'revokeGrant':               return revokeGrant(el.dataset.id);
      case 'openGrantModal':            return openGrantModal(el.dataset.id, el.dataset.name, el.dataset.conds ? JSON.parse(el.dataset.conds) : null);
      case 'closeGrantModal':           return closeGrantModal();
      case 'submitGrantModal':          return submitGrantModal();
      case 'openServiceAccountModal':   return openServiceAccountModal();
      case 'closeServiceAccountModal':  return closeServiceAccountModal();
      case 'submitServiceAccountModal': return submitServiceAccountModal();
      case 'revokeServiceAccount':      return revokeServiceAccount(el.dataset.id);
      case 'copySecret':                return copySecret();
      // Escalations
      case 'approveEscalation':         return approveEscalation(el.dataset.id);
      case 'denyEscalation':            return denyEscalation(el.dataset.id);
      case 'confirmInput':              return onConfirmInput(el.dataset.id);
      // Status tab
      case 'runStatusCheck':            return runStatusCheck();
      case 'checkForUpdates':           return checkForUpdates();
      case 'installUpdate':             return installUpdate();
      case 'resetConfig':               return resetConfig();
      case 'copySnippet':               return copySnippet();
      // Logs tab
      case 'logGoFirst':                return logGoFirst();
      case 'logGoPrev':                 return logGoPrev();
      case 'logGoNext':                 return logGoNext();
      case 'logGoLast':                 return logGoLast();
      case 'logToggleFollow':           return logToggleFollow();
      case 'logClear':                  return logClear();
      case 'rlResetDefaults':           return rlResetDefaults();
      case 'rlSave':                    return rlSave();
      // Wizard
      case 'wizGo':                     return wizGo(parseInt(el.dataset.step, 10));
      case 'wizDetectCert':             return wizDetectCert();
      case 'wizUploadCertClick':        return document.getElementById('wiz-cert-file').click();
      case 'wizSearchBridgePath':       return wizSearchBridgePath();
      case 'wizTestBridge':             return wizTestBridge();
      case 'wizSaveCreds':              return wizSaveCreds();
      case 'wizSavePreset':             return wizSavePreset();
      case 'wizFinalSave':              return wizFinalSave();
      case 'wizCopySnippet':            return wizCopySnippet();
      case 'wizSetTransport':           return wizSetTransport(el);
      case 'wizWriteClaudeCode':        return wizWriteClaudeCode();
      case 'wizWriteClaudeDesktop':     return wizWriteClaudeDesktop();
      case 'wizRestartClaude':          return wizRestartClaude();
      case 'wizSkipRestart':            return wizSkipRestart();
      // Connect-a-client (Setup tab)
      case 'setClientTransport':        return setClientTransport(el);
      case 'writeClaudeCode':           return writeClaudeCode();
      case 'writeClaudeDesktopFromSetup': return writeClaudeDesktopFromSetup();
      case 'copyClientSnippet':         return copyClientSnippet();
      // File input change events
      case 'uploadCertChange':          return uploadCert(el, el.dataset.target);
      case 'wizUploadCertChange':       return wizUploadCert(el);
      // Input events
      case 'wizClearErrorUsername':     return wizClearError('wiz-username');
      case 'wizClearErrorPassword':     return wizClearError('wiz-password');
    }
  }

  // ── Tab lazy-loading ──────────────────────────────────────────────────────
  const _tabLoaded = new Set();
  const _tabLoading = new Map(); // in-flight fetch promises — dedup concurrent clicks

  async function ensureTabLoaded(id) {
    if (_tabLoaded.has(id)) return;
    if (_tabLoading.has(id)) { await _tabLoading.get(id); return; }
    const targetEl = id === 'wizard'
      ? document.getElementById('wizard-view')
      : document.getElementById(id);
    if (!targetEl) return;
    targetEl.innerHTML = '<div class="hint" style="padding:30px;text-align:center">Loading…</div>';
    const p = (async () => {
      try {
        const r = await fetch('/api/tab/' + id, { headers: { 'x-csrf-token': CSRF } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const { html } = await r.json();
        targetEl.innerHTML = html;
        _tabLoaded.add(id);
        if (id === 'permissions') { buildCategoryUI(); if (cfg) populatePermissions(cfg); }
        if (id === 'setup') { ccApplyDaemonMode(); }
      } catch (e) {
        // A fetch that rejects (vs. a non-2xx response, which we throw as
        // "HTTP <code>") means the settings server is gone — the backing
        // mailpouch process stopped or restarted while this page stayed open.
        // Show an actionable message instead of the raw "TypeError: Failed to
        // fetch" the browser produces.
        var unreachable = (e instanceof TypeError) || /Failed to fetch|NetworkError|Load failed/i.test(String((e && e.message) || e));
        targetEl.innerHTML = unreachable
          ? '<div class="alert alert-warn">The settings server is no longer reachable — mailpouch may have stopped or restarted. Restart mailpouch and reload this page.</div>'
          : '<div class="alert alert-warn">Failed to load tab: ' + escHtml(String(e)) + '</div>';
      } finally {
        _tabLoading.delete(id);
      }
    })();
    _tabLoading.set(id, p);
    await p;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', async () => {
    let st;
    try { st = await fetch('/api/status').then(r => r.json()); } catch { st = { hasConfig: false }; }
    if (st.hasConfig) {
      await openSettingsView();
    } else {
      await ensureTabLoaded('wizard');
      document.getElementById('wizard-view').style.display = 'flex';
      document.getElementById('settings-view').style.display = 'none';
      wizShowStep(0);
    }
    loadEscalations();
    loadAuditLog();
    setInterval(loadEscalations, 15_000);
    // Deep-link: an auto-opened approval window points at #agents so the user
    // lands directly on the Agents tab to approve/deny the new connection.
    maybeOpenHashTab();
  });

  // Focus a tab from the URL hash (e.g. #agents). Used by the auto-opened
  // approval window and by manual navigation to #agents.
  function maybeOpenHashTab() {
    const id = (location.hash || '').replace(/^#/, '').split('/')[0];
    if (!id) return;
    const btn = document.querySelector('[data-tab="' + id + '"]');
    if (btn && !btn.disabled) showTab(id, btn);
  }
  window.addEventListener('hashchange', maybeOpenHashTab);

  async function refresh() {
    try {
      const r = await fetch('/api/config');
      cfg = await r.json();
      if (_tabLoaded.has('setup'))       populateSetup(cfg);
      if (_tabLoaded.has('permissions')) populatePermissions(cfg);
      if (_tabLoaded.has('status'))      { populateStatus(cfg); populateResponseLimits(cfg); }
      updateHeaderStatus(true);
    } catch {
      updateHeaderStatus(false);
    }
  }

  // ── View switching ─────────────────────────────────────────────────────────
  async function openSettingsView() {
    document.getElementById('wizard-view').style.display = 'none';
    document.getElementById('settings-view').style.display = '';
    document.getElementById('main-nav').style.display = '';
    await ensureTabLoaded('setup');
    await refresh();
  }

  async function showTab(id, btn) {
    await ensureTabLoaded(id);
    document.querySelectorAll('#settings-view section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('#main-nav button').forEach(b => b.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    if (btn) btn.classList.add('active');
    if (id === 'status')   { populateStatus(cfg); loadAuditLog(); }
    if (id === 'agents')   { refreshAgents(); }
    if (id === 'accounts') { refreshAccounts(); }
    if (id === 'logs')     { logInit(); }
    else                   { logStopFollow(); }
  }

  // ══ ACCOUNTS TAB LOGIC ═══════════════════════════════════════════════════
  async function refreshAccounts() {
    const r = await fetch('/api/accounts');
    const body = await r.json();
    const list = document.getElementById('accounts-list');
    const rows = body.accounts || [];
    const activeId = body.activeAccountId;
    if (!rows.length) {
      list.innerHTML = '<div class="hint" style="text-align:center;padding:30px">No accounts configured.</div>';
      return;
    }
    const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    list.innerHTML = rows.map(a => {
      const active = a.id === activeId;
      const buttons =
        (active ? '' : '<button class="btn btn-primary" data-action="activateAccount" data-id="' + esc(a.id) + '">Activate</button>') +
        '<button class="btn btn-ghost" data-action="editAccount" data-id="' + esc(a.id) + '">Edit</button>' +
        (!active ? '<button class="btn btn-ghost" data-action="deleteAccountConfirm" data-id="' + esc(a.id) + '">Delete</button>' : '');
      const last = a.lastCheckedAt ? ' · last check ' + new Date(a.lastCheckedAt).toLocaleString() + ' · ' + esc(a.lastCheckResult || '') : '';
      return (
        '<div class="card" style="padding:12px;border:1px solid #333;border-radius:8px;' + (active ? 'border-color:#6D4AFF' : '') + '">' +
          '<div style="display:flex;justify-content:space-between;align-items:start;gap:12px">' +
            '<div>' +
              '<div style="font-weight:600">' + (active ? '🟣 ' : '') + esc(a.name) + ' <span style="color:#888;font-size:12px">(' + esc(a.providerType) + ')</span></div>' +
              '<div style="font-size:12px;color:#888;margin-top:4px">' +
                'IMAP ' + esc(a.imapHost) + ':' + esc(a.imapPort) + ' · SMTP ' + esc(a.smtpHost) + ':' + esc(a.smtpPort) +
                ' · ' + esc(a.username) + last +
              '</div>' +
            '</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap">' + buttons + '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
    _accountsById = {};
    for (const a of rows) _accountsById[a.id] = a;
  }

  function openAccountForm(providerType, id) {
    const isEdit = !!id;
    document.getElementById('af-title').textContent = isEdit ? 'Edit account' : 'Add account';
    document.getElementById('af-id').value = id || '';
    document.getElementById('af-provider').value = providerType;
    document.getElementById('af-cert-row').style.display = providerType === 'proton-bridge' ? '' : 'none';

    if (isEdit && _accountsById && _accountsById[id]) {
      const a = _accountsById[id];
      document.getElementById('af-name').value = a.name || '';
      document.getElementById('af-imap-host').value = a.imapHost || '';
      document.getElementById('af-imap-port').value = a.imapPort || '';
      document.getElementById('af-smtp-host').value = a.smtpHost || '';
      document.getElementById('af-smtp-port').value = a.smtpPort || '';
      document.getElementById('af-username').value = a.username || '';
      document.getElementById('af-password').value = '';
      document.getElementById('af-cert').value = a.bridgeCertPath || '';
    } else {
      // Pre-fill sensible defaults for the chosen provider.
      document.getElementById('af-name').value = '';
      document.getElementById('af-username').value = '';
      document.getElementById('af-password').value = '';
      document.getElementById('af-cert').value = '';
      if (providerType === 'proton-bridge') {
        document.getElementById('af-imap-host').value = '127.0.0.1';
        document.getElementById('af-imap-port').value = '1143';
        document.getElementById('af-smtp-host').value = '127.0.0.1';
        document.getElementById('af-smtp-port').value = '1025';
      } else {
        document.getElementById('af-imap-host').value = '';
        document.getElementById('af-imap-port').value = '993';
        document.getElementById('af-smtp-host').value = '';
        document.getElementById('af-smtp-port').value = '587';
      }
    }
    document.getElementById('account-form-backdrop').style.display = 'block';
  }

  function editAccount(id) {
    const a = (_accountsById || {})[id];
    if (!a) return;
    openAccountForm(a.providerType, id);
  }

  function closeAccountForm() {
    document.getElementById('account-form-backdrop').style.display = 'none';
  }

  async function saveAccountForm() {
    const id = document.getElementById('af-id').value;
    const isEdit = !!id;
    const body = {
      configResetGeneration: cfg?.configResetGeneration ?? 0,
      name: document.getElementById('af-name').value.trim(),
      providerType: document.getElementById('af-provider').value,
      imapHost: document.getElementById('af-imap-host').value.trim(),
      imapPort: parseInt(document.getElementById('af-imap-port').value, 10) || 0,
      smtpHost: document.getElementById('af-smtp-host').value.trim(),
      smtpPort: parseInt(document.getElementById('af-smtp-port').value, 10) || 0,
      username: document.getElementById('af-username').value.trim(),
      password: document.getElementById('af-password').value,
      bridgeCertPath: document.getElementById('af-cert').value.trim() || undefined,
    };
    if (!body.name) { toast('Name is required.', 'err'); return; }
    const url = isEdit ? '/api/accounts/' + encodeURIComponent(id) : '/api/accounts';
    const method = isEdit ? 'PATCH' : 'POST';
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      if (__mpReloading) return;
      const errBody = await r.json().catch(() => null);
      toast('Save failed: ' + (errBody?.error || r.status), 'err');
      return;
    }
    const result = await r.json().catch(() => null);
    closeAccountForm();
    refreshAccounts();
    if (result?.restartRequired === true) {
      toast('Account saved. Restart the MCP server before using this change.', 'ok');
    } else {
      toast(isEdit ? 'Account updated.' : 'Account added.', 'ok');
    }
  }

  function activateAccount(id) {
    showConfirm({
      title: 'Switch active account?',
      body:  'New tool calls will use this account by default when the running server can switch live. Existing calls are not interrupted; otherwise you will be asked to restart.',
      label: 'Switch account',
      btnClass: 'btn-primary',
      onConfirm: async () => {
        const r = await fetch('/api/accounts/' + encodeURIComponent(id) + '/activate', {
          method: 'POST',
          headers: { 'X-CSRF-Token': CSRF },
        });
        const result = await r.json().catch(() => null);
        if (!r.ok) {
          if (__mpReloading) return;
          toast('Activate failed: ' + (result?.error || r.status), 'err');
          return;
        }
        // Fail closed: a successful response without an explicit false
        // cannot prove that this process rebound every account-scoped service.
        if (result?.restartRequired !== false) {
          toast('Active account saved. Restart the MCP server to apply it (Tray → Quit then relaunch, or restart_server tool).', 'ok');
        } else {
          toast('Active account switched. New tool calls now use it by default.', 'ok');
        }
        refreshAccounts();
      },
    });
  }

  function deleteAccountConfirm(id) {
    showConfirm({
      title: 'Delete account?',
      body:  'This removes the server\\'s ability to connect to it. The active account cannot be deleted.',
      label: 'Delete',
      onConfirm: async () => {
        const r = await fetch('/api/accounts/' + encodeURIComponent(id), {
          method: 'DELETE',
          headers: { 'X-CSRF-Token': CSRF },
        });
        const result = await r.json().catch(() => null);
        if (!r.ok) {
          if (__mpReloading) return;
          toast('Delete failed: ' + (result?.error || r.status), 'err');
          return;
        }
        refreshAccounts();
        if (result?.restartRequired === true) {
          toast('Account deleted. Restart the MCP server before relying on the updated account list.', 'ok');
        } else {
          toast('Account deleted.', 'ok');
        }
      },
    });
  }

  // ══ AGENTS TAB LOGIC ══════════════════════════════════════════════════════
  let agentFilter = 'pending';
  let agentEventSource = null;

  function switchAgentFilter(which) {
    agentFilter = which;
    ['pending','active','revoked','audit'].forEach(f => {
      const b = document.getElementById('ag-filter-' + f);
      if (b) b.style.fontWeight = (f === which ? '700' : '500');
    });
    document.getElementById('agents-list').style.display = (which === 'audit') ? 'none' : '';
    document.getElementById('agents-audit').style.display = (which === 'audit') ? '' : 'none';
    refreshAgents();
  }

  async function refreshAgents() {
    if (agentFilter === 'audit') { await loadAgentAudit(); return; }
    const r = await fetch('/api/agents?status=' + encodeURIComponent(agentFilter));
    const body = await r.json();
    renderAgents(body.grants || []);
    // Also update the counts on the filter buttons.
    for (const s of ['pending','active','revoked']) {
      const rr = await fetch('/api/agents?status=' + s);
      const bb = await rr.json();
      const el = document.getElementById('ag-count-' + s);
      if (el) el.textContent = '(' + (bb.grants ? bb.grants.length : 0) + ')';
    }
    updatePendingBadge();
  }

  async function updatePendingBadge() {
    const r = await fetch('/api/agents?status=pending');
    const b = await r.json();
    const n = (b.grants || []).length;
    const badge = document.getElementById('agents-pending-badge');
    if (!badge) return;
    if (n > 0) {
      badge.textContent = String(n);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  function renderAgents(grants) {
    const list = document.getElementById('agents-list');
    if (!grants.length) {
      list.innerHTML = '<div class="hint" style="text-align:center;padding:30px">No grants in this view.</div>';
      return;
    }
    const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    list.innerHTML = grants.map(g => {
      const badge = g.status === 'pending' ? '🔴 pending'
                  : g.status === 'active'  ? '🟢 active'
                  : g.status === 'revoked' ? '⚪ revoked'
                  : g.status === 'expired' ? '🟡 expired' : g.status;
      // Distinguish a local (stdio) agent from a remote one when acknowledging.
      const origin = (g.transport === 'stdio' || String(g.clientId).startsWith('stdio:'))
        ? ' <span style="color:#888;font-size:11px">· 🖥 local</span>' : '';
      const lastCall = g.lastCallAt ? new Date(g.lastCallAt).toLocaleString() : 'never';
      const expiry = g.conditions && g.conditions.expiresAt
        ? 'expires ' + new Date(g.conditions.expiresAt).toLocaleString() : 'no expiry';
      // Registration context shown on the card so the user has info to decide.
      const registered = g.createdAt ? new Date(g.createdAt).toLocaleString() : '';
      const fromIp = g.registeredFromIp ? ' · from ' + esc(g.registeredFromIp) : '';
      // Live MCP-handshake connection info (distinct from the DCR client_name).
      const mcpClient = g.mcpClientName
        ? 'MCP client: ' + esc(g.mcpClientName) + (g.mcpClientVersion ? ' v' + esc(g.mcpClientVersion) : '')
          + (g.transport ? ' · ' + esc(g.transport) : '')
          + (g.lastConnectedAt ? ' · last connected ' + esc(new Date(g.lastConnectedAt).toLocaleString()) : '')
        : '';
      const cidEsc  = esc(g.clientId);
      const nameEsc = esc(g.clientName);
      const condsJson = esc(JSON.stringify(g.conditions || null));
      // Service accounts (client_credentials) are credential-backed and
      // pre-approved; their revoke must also delete the credential, so it routes
      // to the service-account endpoint rather than the grant-only revoke.
      const buttons = g.isServiceAccount
        ? (g.status === 'active'
            ? '<button class="btn btn-ghost" data-action="revokeServiceAccount" data-id="' + cidEsc + '">Revoke</button>'
            : '')
        : g.status === 'pending'
        ? '<button class="btn btn-primary" data-action="approveGrant" data-id="' + cidEsc + '" data-preset="read_only">Approve read-only</button>' +
          '<button class="btn btn-primary" data-action="approveGrant" data-id="' + cidEsc + '" data-preset="supervised">Approve supervised</button>' +
          '<button class="btn btn-ghost"   data-action="openGrantModal" data-id="' + cidEsc + '" data-name="' + nameEsc + '" data-conds="null">Customize…</button>' +
          '<button class="btn btn-ghost"   data-action="denyGrant" data-id="' + cidEsc + '">Deny</button>'
        : g.status === 'active'
        ? '<button class="btn btn-ghost"   data-action="openGrantModal" data-id="' + cidEsc + '" data-name="' + nameEsc + '" data-conds="' + condsJson + '">Extend / modify…</button>' +
          '<button class="btn btn-ghost"   data-action="revokeGrant" data-id="' + cidEsc + '">Revoke</button>'
        : '';
      const saTag = g.isServiceAccount ? ' <span style="color:#888;font-size:11px">· 🔑 service account</span>' : '';
      return (
        '<div class="card" style="padding:12px;border:1px solid #333;border-radius:8px">' +
          '<div style="display:flex;justify-content:space-between;align-items:start;gap:12px">' +
            '<div>' +
              '<div style="font-weight:600">' + esc(g.clientName) + ' <span style="color:#888;font-size:12px">(' + esc(g.clientId) + ')</span>' + origin + saTag + '</div>' +
              '<div style="font-size:12px;color:#888;margin-top:4px">' +
                badge + ' · preset ' + esc(g.preset) + ' · ' + esc(expiry) + ' · ' + g.totalCalls + ' calls · last ' + esc(lastCall) +
              '</div>' +
              (g.status === 'pending' && (registered || fromIp)
                ? '<div style="font-size:12px;color:#888;margin-top:2px">registered ' + esc(registered) + fromIp + '</div>'
                : '') +
              (mcpClient ? '<div style="font-size:12px;color:#888;margin-top:2px">' + mcpClient + '</div>' : '') +
              (g.note ? '<div style="font-size:12px;color:#aaa;margin-top:4px;font-style:italic">' + esc(g.note) + '</div>' : '') +
            '</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap">' + buttons + '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  async function loadAgentAudit() {
    const r = await fetch('/api/agents/audit?limit=200');
    const body = await r.json();
    const rows = body.rows || [];
    const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    const tbody = document.getElementById('agents-audit-body');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:30px;color:#888">No calls logged yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.slice().reverse().map(r => {
      const d = new Date(r.ts);
      const when = d.toLocaleString('en-US', { timeZone: 'America/New_York' });
      const ok = r.ok ? '<span style="color:#10b981">ok</span>' : '<span style="color:#ef4444">blocked: ' + esc(r.blockedReason || '?') + '</span>';
      return '<tr>' +
        '<td style="padding:5px;border-bottom:1px solid #222">' + esc(when) + '</td>' +
        '<td style="padding:5px;border-bottom:1px solid #222">' + esc(r.clientName || r.clientId) + '</td>' +
        '<td style="padding:5px;border-bottom:1px solid #222"><code>' + esc(r.tool) + '</code></td>' +
        '<td style="padding:5px;border-bottom:1px solid #222">' + ok + '</td>' +
        '<td style="padding:5px;border-bottom:1px solid #222;text-align:right">' + esc(r.durMs) + '</td>' +
      '</tr>';
    }).join('');
  }

  async function approveGrant(clientId, preset) {
    const r = await fetch('/api/agents/' + encodeURIComponent(clientId) + '/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify({ preset })
    });
    if (!r.ok) { toast('Approve failed: ' + (await r.text()), 'err'); return; }
    refreshAgents();
  }

  function denyGrant(clientId) {
    showConfirm({
      title: 'Deny agent?',
      body:  'This agent will be unable to call any tools.',
      label: 'Deny',
      onConfirm: async () => {
        const r = await fetch('/api/agents/' + encodeURIComponent(clientId) + '/deny', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
          body: '{}'
        });
        if (!r.ok) { toast('Deny failed: ' + (await r.text()), 'err'); return; }
        refreshAgents();
      },
    });
  }

  function revokeGrant(clientId) {
    showConfirm({
      title: 'Revoke access?',
      body:  'Currently running tool calls will finish; the next one will be denied.',
      label: 'Revoke',
      onConfirm: async () => {
        const r = await fetch('/api/agents/' + encodeURIComponent(clientId) + '/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF }
        });
        if (!r.ok) { toast('Revoke failed: ' + (await r.text()), 'err'); return; }
        refreshAgents();
      },
    });
  }

  function openServiceAccountModal() {
    const m = document.getElementById('sa-modal');
    if (!m) return;
    // Reset to the form view (hide any previously-revealed secret).
    document.getElementById('sa-form').style.display = '';
    document.getElementById('sa-secret').style.display = 'none';
    document.getElementById('sa-name').value = '';
    document.getElementById('sa-preset').value = 'read_only';
    document.getElementById('sa-expires').value = '';
    document.getElementById('sa-folders').value = '';
    m.style.display = 'flex';
  }

  function closeServiceAccountModal() {
    const m = document.getElementById('sa-modal');
    if (m) m.style.display = 'none';
    refreshAgents();
  }

  async function submitServiceAccountModal() {
    const name = document.getElementById('sa-name').value.trim();
    if (!name) { toast('Name is required.', 'err'); return; }
    const preset = document.getElementById('sa-preset').value;
    const expires = document.getElementById('sa-expires').value.trim();
    const folders = document.getElementById('sa-folders').value.trim();
    const conditions = {};
    if (expires) {
      const t = Date.parse(expires);
      if (isNaN(t)) { toast('Expires must be an ISO-8601 timestamp.', 'err'); return; }
      conditions.expiresAt = new Date(t).toISOString();
    }
    if (folders) conditions.folderAllowlist = folders.split(',').map(s => s.trim()).filter(Boolean);
    const r = await fetch('/api/agents/service-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify({ name, preset, conditions })
    });
    if (!r.ok) { toast('Create failed: ' + (await r.text()), 'err'); return; }
    const body = await r.json();
    // Reveal the secret ONCE — the server never returns it again.
    document.getElementById('sa-form').style.display = 'none';
    document.getElementById('sa-secret').style.display = '';
    document.getElementById('sa-out-id').textContent = body.clientId;
    document.getElementById('sa-out-secret').textContent = body.clientSecret;
  }

  function copySecret() {
    const id = document.getElementById('sa-out-id').textContent || '';
    const secret = document.getElementById('sa-out-secret').textContent || '';
    navigator.clipboard.writeText('client_id=' + id + '\\nclient_secret=' + secret)
      .then(() => toast('Copied client_id + client_secret to clipboard.', 'ok'))
      .catch(() => toast('Copy failed — select the text manually.', 'err'));
  }

  function revokeServiceAccount(clientId) {
    showConfirm({
      title: 'Revoke service account?',
      body:  'Deletes the credential and revokes its grant. The client_secret stops working immediately and cannot be recovered — you would have to issue a new account.',
      label: 'Revoke',
      onConfirm: async () => {
        const r = await fetch('/api/agents/service-account/' + encodeURIComponent(clientId) + '/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF }
        });
        if (!r.ok) { toast('Revoke failed: ' + (await r.text()), 'err'); return; }
        refreshAgents();
      },
    });
  }

  // SSE subscription — live-update the Agents tab and the nav badge.
  function subscribeAgentEvents() {
    if (agentEventSource) return;
    try {
      agentEventSource = new EventSource('/api/notifications');
      agentEventSource.onerror = () => { /* swallow — browser auto-reconnects */ };
      const refresh = () => { updatePendingBadge(); if (document.getElementById('agents').classList.contains('active')) refreshAgents(); };
      for (const kind of ['grant-created','grant-approved','grant-denied','grant-revoked','grant-expired']) {
        agentEventSource.addEventListener(kind, refresh);
      }
    } catch (e) { /* SSE unavailable — poll-on-tab-show still works */ }
  }
  subscribeAgentEvents();
  updatePendingBadge();

  // ── Header status ─────────────────────────────────────────────────────────
  function updateHeaderStatus(ok) {
    document.getElementById('config-dot').className        = 'dot ' + (ok ? 'ok' : 'err');
    document.getElementById('config-status-text').textContent = ok ? 'Config loaded' : 'Not connected';
  }

  // ══ WIZARD LOGIC ══════════════════════════════════════════════════════════

  const STEP_LABELS = ['Welcome','Bridge','Account','Permissions','Review','Done'];
  const STEP_COUNT  = 6;

  function wizShowStep(n) {
    // Hide all panels
    document.querySelectorAll('.wiz-panel').forEach((el, i) => {
      el.classList.toggle('active', i === n);
    });
    // Update nodes
    for (let i = 0; i < STEP_COUNT; i++) {
      const node = document.getElementById('wnode-' + i);
      if (!node) continue;
      node.className = 'wiz-step-node' +
        (i === n ? ' active' : i < n ? ' done' : '');
      node.querySelector('.wiz-step-circle').textContent =
        i < n ? '✓' : String(i + 1);
    }
    // Progress fill
    const pct = n === 0 ? 0 : Math.round((n / (STEP_COUNT - 1)) * 100);
    document.getElementById('wiz-progress-fill').style.width = pct + '%';
    // Focus first focusable element
    const panel = document.getElementById('wpanel-' + n);
    if (panel) {
      const first = panel.querySelector('input:not([disabled]),button:not([disabled])');
      if (first) setTimeout(() => first.focus(), 80);
    }
    // Step-specific setup
    if (n === 4) wizBuildReview();
    if (n === 5) wizBuildSnippet();
  }

  function wizGo(n) { wizShowStep(n); }

  // ── Step 2: Bridge test ───────────────────────────────────────────────────
  async function wizTestBridge() {
    const btn  = document.getElementById('wiz-test-bridge-btn');
    const hint = document.getElementById('bridge-hint');
    const smtpRow = document.getElementById('smtp-row');
    const imapRow = document.getElementById('imap-row');
    const smtpSt  = document.getElementById('smtp-conn-status');
    const imapSt  = document.getElementById('imap-conn-status');
    const nextBtn = document.getElementById('wiz-bridge-next');

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Testing…';
    smtpSt.className = 'conn-row-status idle'; smtpSt.textContent = 'Checking…';
    imapSt.className = 'conn-row-status idle'; imapSt.textContent = 'Checking…';
    smtpRow.className = 'conn-row'; imapRow.className = 'conn-row';

    // Save cert path and bridge path
    W.certPath   = document.getElementById('wiz-cert-path').value.trim();
    W.bridgePath = document.getElementById('wiz-bridge-path').value.trim();

    async function _wizRunTest() {
      const r = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({
          smtpHost: W.smtpHost, smtpPort: W.smtpPort,
          imapHost: W.imapHost, imapPort: W.imapPort,
        }),
      });
      return r.json();
    }

    try {
      let d = await _wizRunTest();

      // If not reachable, attempt to start Bridge then re-test
      if (!d.smtp || !d.imap) {
        smtpSt.textContent = imapSt.textContent = 'Starting Bridge…';
        smtpSt.className = imapSt.className = 'conn-row-status idle';
        btn.innerHTML = '<span class="spinner"></span> Starting Bridge…';

        const startR = await fetch('/api/start-bridge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
          body: '{}',
        });
        const startD = await startR.json();

        if (startD.error) {
          hint.textContent = startD.error;
          hint.style.display = '';
        }

        btn.innerHTML = '<span class="spinner"></span> Re-testing…';
        d = await _wizRunTest();
      }

      var sst = connStatusText(d.smtp, d.smtpAuth);
      var ist = connStatusText(d.imap, d.imapAuth);
      // Auth failed counts as a non-ok row (amber/red), so the wizard doesn't
      // look "all good" while a 454 is happening.
      var smtpOk = d.smtp && (!d.smtpAuth || d.smtpAuth.authenticated !== false);
      var imapOk = d.imap && (!d.imapAuth || d.imapAuth.authenticated !== false);
      smtpSt.textContent = sst.text;
      smtpSt.className   = 'conn-row-status ' + (smtpOk ? 'ok' : 'fail');
      imapSt.textContent = ist.text;
      imapSt.className   = 'conn-row-status ' + (imapOk ? 'ok' : 'fail');
      smtpRow.className  = 'conn-row ' + (smtpOk ? 'ok' : 'fail');
      imapRow.className  = 'conn-row ' + (imapOk ? 'ok' : 'fail');
      // Progression still only requires reachability (credentials may be
      // entered/saved in a later step); auth state is shown but not gating.
      const allOk = d.smtp && d.imap;
      hint.style.display = allOk ? 'none' : '';
      W.bridgeTested = allOk;
      nextBtn.disabled = !allOk;
      if (allOk) nextBtn.classList.add('btn-success');
    } catch(e) {
      smtpSt.textContent = imapSt.textContent = 'Error';
      smtpSt.className = imapSt.className = 'conn-row-status fail';
      hint.style.display = '';
    } finally {
      btn.disabled = false; btn.textContent = 'Test Connection';
    }
  }

  // ── Step 3: Credential save ───────────────────────────────────────────────
  async function wizSaveCreds() {
    const username = document.getElementById('wiz-username').value.trim();
    const password = document.getElementById('wiz-password').value;
    const smtpToken = document.getElementById('wiz-smtp-token').value;
    const debug     = document.getElementById('wiz-debug').checked;

    let valid = true;
    if (!username) {
      setFieldError('wiz-username', 'err-wiz-username', true);
      valid = false;
    }
    if (!password) {
      setFieldError('wiz-password', 'err-wiz-password', true);
      valid = false;
    }
    if (!valid) return;

    const btn = document.getElementById('wiz-save-creds-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';

    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({
          configResetGeneration: cfg?.configResetGeneration ?? 0,
          connection: {
            username,
            password,
            smtpHost: W.smtpHost, smtpPort: W.smtpPort,
            imapHost: W.imapHost, imapPort: W.imapPort,
            bridgeCertPath:  W.certPath,
            bridgePath:      W.bridgePath || '',
            smtpToken,
            debug,
            autoStartBridge: document.getElementById('wiz-auto-start-bridge')?.checked || false,
          },
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      const result = await r.json().catch(() => null);
      W.username = username;
      W.debug    = debug;
      W.credsSaved = true;
      if (result?.restartRequired === true) {
        toast('Credentials saved. Restart the MCP server before using the updated account.', 'ok');
      }
      wizShowStep(3);
    } catch(e) {
      toast('Could not save credentials: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save & Continue →';
    }
  }

  function wizClearError(id) {
    setFieldError(id, 'err-' + id, false);
  }

  function setFieldError(inputId, errId, show) {
    const inp = document.getElementById(inputId);
    const err = document.getElementById(errId);
    if (inp) inp.classList.toggle('invalid', show);
    if (err) err.style.display = show ? 'block' : 'none';
  }

  // ── Step 4: Preset save ───────────────────────────────────────────────────
  async function wizSavePreset() {
    const radio = document.querySelector('input[name="wiz-preset"]:checked');
    const preset = radio ? radio.value : 'read_only';
    W.preset = preset;

    const btn = document.getElementById('wiz-apply-preset-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Applying…';

    try {
      const r = await fetch('/api/preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({ preset, configResetGeneration: cfg?.configResetGeneration ?? 0 }),
      });
      if (!r.ok) throw new Error('Save failed');
      W.presetSaved = true;
      wizShowStep(4);
    } catch(e) {
      toast('Could not apply preset: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Apply & Continue →';
    }
  }

  // ── Step 5: Review ────────────────────────────────────────────────────────
  function wizBuildReview() {
    const radio  = document.querySelector('input[name="wiz-preset"]:checked');
    const preset = radio ? radio.value : W.preset;
    const username = document.getElementById('wiz-username')?.value.trim() || W.username || '—';
    const connLabel = W.smtpHost === 'localhost'
      ? 'Proton Bridge (localhost:' + W.smtpPort + ' / ' + W.imapPort + ')'
      : 'Direct (smtp.protonmail.ch:' + W.smtpPort + ')';

    document.getElementById('review-connection').textContent = connLabel;
    document.getElementById('review-account').textContent    = username;
    document.getElementById('review-preset').textContent     = formatPreset(preset);
    document.getElementById('review-storage').textContent    = 'Config file (mode 0600)';
  }

  function formatPreset(p) {
    return { full:'Full Access', read_only:'Read-Only', supervised:'Supervised',
             send_only:'Send-Only', custom:'Custom' }[p] || p;
  }

  // ── Step 5: Final save ────────────────────────────────────────────────────
  async function wizFinalSave() {
    const btn = document.getElementById('wiz-final-save-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      // Config was already saved in steps 3 & 4.
      // Just advance to Done.
      toast('Configuration saved.', 'ok');
      wizShowStep(5);
    } catch(e) {
      toast('Save failed: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save Configuration';
    }
  }

  // ── Step 6: Done ──────────────────────────────────────────────────────────
  async function wizBuildSnippet() {
    // Reset state
    document.getElementById('write-result').style.display = 'none';
    document.getElementById('restart-result').style.display = 'none';
    document.getElementById('copy-result').style.display = 'none';
    document.getElementById('done-complete').style.display = 'none';
    document.getElementById('done-write-section').style.display = '';
    document.getElementById('claude-write-row').style.display = 'none';
    document.getElementById('restart-row').style.display = 'none';
    const writeBtn = document.getElementById('btn-write-claude');
    if (writeBtn) { writeBtn.disabled = false; writeBtn.textContent = 'Write to Claude Desktop →'; }

    wizRenderSnippet();

    // Detect Claude Desktop
    try {
      const r = await fetch('/api/claude-desktop-status');
      const data = await r.json();
      if (data.found) {
        document.getElementById('claude-write-row').style.display = '';
        document.getElementById('restart-row').style.display = '';
      }
    } catch { /* ignore — Claude Desktop section stays hidden */ }
  }

  let wizTransport = 'stdio';

  function wizRenderSnippet() {
    const pre = document.getElementById('done-snippet');
    if (!pre) return;
    const snippet = wizTransport === 'http'
      ? { mcpServers: { mailpouch: { type: 'http', url: 'http://127.0.0.1:8788/mcp' } } }
      : { mcpServers: { mailpouch: {
          type: 'stdio',
          command: 'node',
          args: [__distIndexPath || '/path/to/mailpouch/dist/index.js'],
          env: { MAILPOUCH_FORCE_STDIO: '1' },
        } } };
    pre.textContent = JSON.stringify(snippet, null, 2);
  }

  function wizSetTransport(el) {
    // A stdio entry can't work while a shared daemon is configured — force HTTP.
    if (el && el.value === 'stdio' && ccDaemonMode()) {
      wizTransport = 'http';
      const httpRadio = document.querySelector('input[name="wiz-cc-transport"][value="http"]');
      if (httpRadio) httpRadio.checked = true;
      wizRenderSnippet();
      return;
    }
    if (el && el.value) { wizTransport = el.value; el.checked = true; }
    wizRenderSnippet();
  }

  async function wizWriteClaudeCode() {
    const resultEl = document.getElementById('wiz-cc-result');
    if (resultEl) { resultEl.style.display = 'block'; resultEl.innerHTML = '<div class="hint" style="margin-top:6px">Writing…</div>'; }
    try {
      const r = await fetch('/api/write-claude-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({ transport: wizTransport })
      });
      const data = await r.json();
      if (!resultEl) return;
      if (data.ok) {
        resultEl.innerHTML = '<div class="hint" style="color:var(--success);margin-top:6px">✓ Wrote ' + escHtml(wizTransport) + ' entry to <code>' + escHtml(data.configPath) + '</code>'
          + (data.warning ? '<br><span style="color:var(--warn,#f59e0b)">' + escHtml(data.warning) + '</span>' : '') + '</div>';
      } else {
        resultEl.innerHTML = '<div class="hint" style="color:var(--danger);margin-top:6px">✗ ' + escHtml(data.error || 'Failed') + '</div>';
      }
    } catch (e) {
      if (resultEl) resultEl.innerHTML = '<div class="hint" style="color:var(--danger);margin-top:6px">✗ Network error</div>';
    }
  }

  function wizCopySnippet() {
    const text = document.getElementById('done-snippet').textContent;
    const resultEl = document.getElementById('copy-result');
    navigator.clipboard.writeText(text).then(() => {
      resultEl.style.display = 'block';
      resultEl.innerHTML = '<div class="hint" style="color:var(--success);margin-top:6px">✓ Copied to clipboard</div>';
      setTimeout(() => { resultEl.style.display = 'none'; }, 2500);
    });
  }

  async function wizWriteClaudeDesktop() {
    const btn = document.getElementById('btn-write-claude');
    const resultEl = document.getElementById('write-result');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Writing…';
    resultEl.style.display = 'none';
    try {
      const r = await fetch('/api/write-claude-desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({})
      });
      const data = await r.json();
      if (data.ok) {
        btn.textContent = '✓ Written';
        btn.className = 'btn btn-success';
        resultEl.style.display = 'block';
        resultEl.innerHTML = '<div class="hint" style="color:var(--success);margin-top:8px">✓ Saved to <code>' + escHtml(data.configPath) + '</code></div>';
      } else {
        btn.disabled = false;
        btn.textContent = 'Write to Claude Desktop →';
        resultEl.style.display = 'block';
        resultEl.innerHTML = '<div class="hint" style="color:var(--danger);margin-top:8px">✗ ' + escHtml(data.error || 'Failed') + '</div>';
      }
    } catch(e) {
      btn.disabled = false;
      btn.textContent = 'Write to Claude Desktop →';
      resultEl.style.display = 'block';
      resultEl.innerHTML = '<div class="hint" style="color:var(--danger);margin-top:8px">✗ Network error</div>';
    }
  }

  async function wizRestartClaude() {
    const btn = document.getElementById('btn-restart-claude');
    const resultEl = document.getElementById('restart-result');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Restarting…';
    try {
      await fetch('/api/restart-claude-desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({})
      });
      document.getElementById('done-write-section').style.display = 'none';
      document.getElementById('done-complete').style.display = 'flex';
    } catch(e) {
      btn.disabled = false;
      btn.textContent = 'Restart Claude Desktop';
      resultEl.style.display = 'block';
      resultEl.innerHTML = '<div class="hint" style="color:var(--danger);margin-top:8px">✗ Could not restart automatically — please restart Claude Desktop manually.</div>';
    }
  }

  function wizSkipRestart() {
    document.getElementById('done-write-section').style.display = 'none';
    document.getElementById('done-complete').style.display = 'flex';
    document.getElementById('done-complete').querySelector('strong').textContent = 'Done!';
    document.getElementById('done-complete').querySelector('strong').nextSibling.textContent = ' Restart Claude Desktop when you\\'re ready — Proton Mail tools will be available after it loads.';
  }

  // ── Connect-a-client (Setup tab) ──────────────────────────────────────────
  let clientTransport = 'stdio';

  // When a shared daemon is configured (remoteMode), a stdio entry would
  // collide with it — so force HTTP and disable the stdio option in the UI.
  function ccDaemonMode() { return !!(cfg && cfg.connection && cfg.connection.remoteMode); }

  function ccApplyDaemonMode() {
    const note = document.getElementById('cc-daemon-note');
    const stdioRadio = document.getElementById('cc-radio-stdio');
    const httpRadio = document.getElementById('cc-radio-http');
    const stdioLabel = document.getElementById('cc-stdio-label');
    const daemon = ccDaemonMode();
    if (note) note.style.display = daemon ? 'block' : 'none';
    if (stdioRadio) stdioRadio.disabled = daemon;
    if (stdioLabel) stdioLabel.style.opacity = daemon ? '0.5' : '1';
    if (daemon) {
      clientTransport = 'http';
      if (httpRadio) httpRadio.checked = true;
      if (stdioRadio) stdioRadio.checked = false;
    }
    ccBuildSnippet();
  }

  function ccBuildSnippet() {
    const pre = document.getElementById('cc-snippet');
    if (!pre) return;
    const snippet = clientTransport === 'http'
      ? { mcpServers: { mailpouch: { type: 'http', url: 'http://127.0.0.1:8788/mcp' } } }
      : { mcpServers: { mailpouch: { type: 'stdio', command: 'mailpouch', env: { MAILPOUCH_FORCE_STDIO: '1' } } } };
    pre.textContent = JSON.stringify(snippet, null, 2);
  }

  function setClientTransport(el) {
    // Ignore a stdio pick while the shared daemon is on — it can't work.
    if (el && el.value === 'stdio' && ccDaemonMode()) { ccApplyDaemonMode(); return; }
    if (el && el.value) { clientTransport = el.value; el.checked = true; }
    ccBuildSnippet();
  }

  async function writeClaudeCode() {
    const resultEl = document.getElementById('cc-result');
    if (resultEl) resultEl.textContent = 'Writing…';
    try {
      const r = await fetch('/api/write-claude-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({ transport: clientTransport })
      });
      const data = await r.json();
      if (data.ok) {
        if (resultEl) resultEl.innerHTML = '✓ Wrote ' + escHtml(clientTransport) + ' entry to <code>' + escHtml(data.configPath) + '</code>'
          + (data.warning ? ' — <span style="color:var(--warn,#f59e0b)">' + escHtml(data.warning) + '</span>' : '');
        toast(data.warning ? data.warning : 'Wrote mailpouch to Claude Code (' + clientTransport + ').', data.warning ? 'err' : 'ok');
      } else {
        if (resultEl) resultEl.textContent = '✗ ' + (data.error || 'Failed');
        toast(data.error || 'Write failed', 'err');
      }
    } catch (e) {
      if (resultEl) resultEl.textContent = '✗ Network error';
      toast('Network error', 'err');
    }
  }

  async function writeClaudeDesktopFromSetup() {
    const resultEl = document.getElementById('cc-result');
    if (resultEl) resultEl.textContent = 'Writing…';
    try {
      const r = await fetch('/api/write-claude-desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: '{}'
      });
      const data = await r.json();
      if (data.ok) {
        if (resultEl) resultEl.innerHTML = '✓ Wrote to <code>' + escHtml(data.configPath) + '</code>';
        toast('Wrote mailpouch to Claude Desktop.', 'ok');
      } else {
        if (resultEl) resultEl.textContent = '✗ ' + (data.error || 'Failed');
        toast(data.error || 'Write failed', 'err');
      }
    } catch (e) {
      if (resultEl) resultEl.textContent = '✗ Network error';
      toast('Network error', 'err');
    }
  }

  function copyClientSnippet() {
    const pre = document.getElementById('cc-snippet');
    if (!pre) return;
    navigator.clipboard.writeText(pre.textContent || '')
      .then(() => toast('Snippet copied.', 'ok'))
      .catch(() => toast('Copy failed — select the text manually.', 'err'));
  }

  // ── Shutdown server ───────────────────────────────────────────────────────
  function shutdownServer() {
    showConfirm({
      title: 'Stop settings server?',
      body:  'The browser tab will no longer work after this.',
      label: 'Stop server',
      onConfirm: async () => {
        const btn = document.getElementById('shutdown-btn');
        btn.disabled = true;
        btn.textContent = 'Shutting down…';
        try {
          await fetch('/api/shutdown', { method: 'POST', headers: { 'X-CSRF-Token': CSRF } });
        } catch { /* expected — server closes the connection */ }
        btn.textContent = '✓ Stopped';
        toast('Settings server stopped.', 'ok');
        setTimeout(() => { document.body.innerHTML = '<div style="font-family:sans-serif;color:#ccc;background:#0f0e1a;min-height:100vh;display:flex;align-items:center;justify-content:center;font-size:18px">Server stopped. Close this tab.</div>'; }, 1500);
      },
    });
  }

  // ══ SETTINGS TAB LOGIC ════════════════════════════════════════════════════

  function populateSetup(c) {
    if (!c) return;
    const cn = c.connection || {};
    set('username',    cn.username || '');
    set('smtp-host',   cn.smtpHost || 'localhost');
    set('smtp-port',   cn.smtpPort || 1025);
    set('imap-host',   cn.imapHost || 'localhost');
    set('imap-port',   cn.imapPort || 1143);
    set('bridge-cert', cn.bridgeCertPath || '');
    set('bridge-path', cn.bridgePath || '');
    document.getElementById('debug-mode').checked = !!cn.debug;
    document.getElementById('auto-start-bridge').checked = !!cn.autoStartBridge;
    var insecureEl = document.getElementById('allow-insecure-bridge');
    if (insecureEl) insecureEl.checked = !!cn.allowInsecureBridge;
    var confirmEl = document.getElementById('require-destructive-confirm');
    if (confirmEl) confirmEl.checked = c.requireDestructiveConfirm !== false;
    var desktopNotifEl = document.getElementById('desktop-notifications');
    if (desktopNotifEl) desktopNotifEl.checked = c.desktopNotificationsEnabled !== false;
    var surfaceSecEl = document.getElementById('surface-security-notifications');
    if (surfaceSecEl) surfaceSecEl.checked = c.surfaceSecurityNotifications === true;
    var autoOpenEl = document.getElementById('auto-open-approval');
    if (autoOpenEl) autoOpenEl.checked = c.autoOpenApprovalWindow !== false;
    set('sl-api-key',        cn.simpleloginApiKey  ? '••••••••' : '');
    set('sl-base-url',       cn.simpleloginBaseUrl || '');
    set('pass-access-token', cn.passAccessToken    ? '••••••••' : '');
    set('pass-cli-path',     cn.passCliPath        || '');
    // A fresh server snapshot supersedes any pending clear selected before a
    // save/reload. Keep the flags scoped to one deliberate save attempt.
    pendingAuxiliarySecretClears = { simpleloginApiKey: false, passAccessToken: false };
    set('settings-port', c.settingsPort || 8766);
    checkPortMismatch();
    const logsTabBtn = document.getElementById('logs-tab-btn'); if (logsTabBtn) logsTabBtn.style.display = cn.debug ? '' : 'none';
    const isDirect = (cn.smtpHost || '').includes('protonmail');
    setMode(isDirect ? 'direct' : 'bridge');

    // TLS mode select
    var tlsModeEl = document.getElementById('tls-mode');
    if (tlsModeEl) tlsModeEl.value = cn.tlsMode || 'starttls';

    // SMTP token visibility
    updateSmtpTokenVisibility();

    // TLS warning banner
    var tlsWarn = document.getElementById('tls-warning');
    if (tlsWarn) tlsWarn.style.display = (!cn.bridgeCertPath) ? '' : 'none';

    // Credential storage row in status tab
    var credStorageEl = document.getElementById('info-credential-storage');
    if (credStorageEl) {
      credStorageEl.textContent = c.credentialStorage === 'keychain' ? 'OS keychain' : c.credentialStorage === 'encrypted-file' ? 'Encrypted file' : 'Config file (plaintext)';
    }

    // Connect-an-app: reflect daemon mode now that config (remoteMode) is known.
    ccApplyDaemonMode();
  }

  var EYE_OPEN  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_SLASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function togglePw(inputId) {
    var inp = document.getElementById(inputId);
    if (!inp) return;
    var btn = inp.parentElement && inp.parentElement.querySelector('.eye-btn');
    var show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    if (btn) {
      btn.innerHTML = show ? EYE_SLASH : EYE_OPEN;
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    }
  }

  function setMode(mode) {
    const isBridge = mode === 'bridge';
    document.getElementById('mode-bridge').className = 'mode-btn' + (isBridge ? ' active' : '');
    document.getElementById('mode-direct').className = 'mode-btn' + (!isBridge ? ' active' : '');
    document.getElementById('setup-smtp-token-field').style.display = isBridge ? 'none' : '';
    if (isBridge) {
      set('smtp-host', 'localhost'); set('smtp-port', 1025);
      set('imap-host', 'localhost'); set('imap-port', 1143);
    } else {
      set('smtp-host', 'smtp.protonmail.ch'); set('smtp-port', 587);
    }
    updateSmtpTokenVisibility();
  }

  function checkPortMismatch() {
    const val  = parseInt(document.getElementById('settings-port').value, 10);
    const warn = document.getElementById('port-mismatch-warn');
    if (warn) warn.style.display = (!isNaN(val) && val !== RUNNING_PORT) ? '' : 'none';
  }

  function updateSmtpTokenVisibility() {
    var smtpHost = get('smtp-host').trim().toLowerCase();
    var isBridge = (smtpHost === 'localhost' || smtpHost === '127.0.0.1');
    var tokenRow = document.getElementById('smtp-token-row');
    if (tokenRow) tokenRow.style.display = isBridge ? 'none' : '';
  }

  function clearAuxiliarySecret(secret) {
    const fields = {
      simpleloginApiKey: { inputId: 'sl-api-key', label: 'SimpleLogin API key' },
      passAccessToken: { inputId: 'pass-access-token', label: 'Proton Pass access token' },
    };
    const field = fields[secret];
    if (!field) return;
    showConfirm({
      title: 'Clear ' + field.label + '?',
      body: 'This will disable the integration when you save the configuration. It cannot be undone.',
      label: 'Clear on save',
      onConfirm: function() {
        const input = document.getElementById(field.inputId);
        if (input) input.value = '';
        pendingAuxiliarySecretClears[secret] = true;
        toast(field.label + ' will be cleared when you save configuration.', 'warn');
      },
    });
  }

  async function saveSetup() {
    const btn = document.getElementById('save-btn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      var tlsModeEl = document.getElementById('tls-mode');
      var tlsModeVal = tlsModeEl ? tlsModeEl.value : 'starttls';
      const simpleloginApiKey = get('sl-api-key');
      const passAccessToken = get('pass-access-token');
      const body = {
        configResetGeneration: cfg?.configResetGeneration ?? 0,
        connection: {
          username:       get('username'),
          password:       get('password'),
          smtpHost:       get('smtp-host'),
          smtpPort:       parseInt(get('smtp-port'), 10),
          imapHost:       get('imap-host'),
          imapPort:       parseInt(get('imap-port'), 10),
          smtpToken:      get('smtp-token'),
          bridgeCertPath: get('bridge-cert'),
          bridgePath:       get('bridge-path'),
          tlsMode:          tlsModeVal,
          debug:            document.getElementById('debug-mode').checked,
          autoStartBridge:  document.getElementById('auto-start-bridge').checked,
          allowInsecureBridge: !!(document.getElementById('allow-insecure-bridge') && document.getElementById('allow-insecure-bridge').checked),
          simpleloginApiKey,
          simpleloginBaseUrl: get('sl-base-url'),
          passAccessToken,
          // A redacted/keychain-backed secret reaches the browser as blank.
          // Only send a destructive clear flag after the operator used Clear;
          // typing a replacement cancels that pending clear for this save.
          ...(pendingAuxiliarySecretClears.simpleloginApiKey && !simpleloginApiKey.trim()
            ? { clearSimpleloginApiKey: true } : {}),
          ...(pendingAuxiliarySecretClears.passAccessToken && !passAccessToken.trim()
            ? { clearPassAccessToken: true } : {}),
          passCliPath:        get('pass-cli-path'),
        },
        requireDestructiveConfirm: !!(document.getElementById('require-destructive-confirm') && document.getElementById('require-destructive-confirm').checked),
        desktopNotificationsEnabled: !!(document.getElementById('desktop-notifications') && document.getElementById('desktop-notifications').checked),
        surfaceSecurityNotifications: !!(document.getElementById('surface-security-notifications') && document.getElementById('surface-security-notifications').checked),
        autoOpenApprovalWindow: !!(document.getElementById('auto-open-approval') && document.getElementById('auto-open-approval').checked),
        settingsPort: (function(){ var p = parseInt(get('settings-port'), 10); return isNaN(p) ? 8766 : p; })(),
      };
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      const result = await r.json().catch(() => null);
      toast(result?.restartRequired === true
        ? 'Configuration saved. Restart the MCP server before using the updated account.'
        : 'Configuration saved.', 'ok');
      await refresh();
    } catch(e) {
      toast('Save failed: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save Configuration';
    }
  }

  // ── Bridge executable search ──────────────────────────────────────────────
  async function _doSearchBridge(inputId, hintId, btnId) {
    const btn  = document.getElementById(btnId);
    const hint = document.getElementById(hintId);
    btn.disabled = true; btn.textContent = 'Searching…';
    try {
      const r = await fetch('/api/search-bridge', { headers: { 'X-CSRF-Token': CSRF } });
      const d = await r.json();
      if (d.found) {
        set(inputId, d.path);
        hint.textContent = 'Found: ' + d.path;
        hint.style.color = 'var(--ok, #22c55e)';
      } else {
        set(inputId, '');
        hint.textContent = 'Not found in common locations. Enter the path manually.';
        hint.style.color = 'var(--warn, #f59e0b)';
      }
    } catch(e) {
      hint.textContent = 'Search failed: ' + e.message;
      hint.style.color = 'var(--err, #ef4444)';
    } finally {
      btn.disabled = false; btn.textContent = 'Search';
    }
  }

  function searchBridgePath() {
    return _doSearchBridge('bridge-path', 'bridge-path-hint', 'search-bridge-btn');
  }

  function wizSearchBridgePath() {
    return _doSearchBridge('wiz-bridge-path', 'wiz-bridge-path-hint', 'wiz-search-bridge-btn');
  }

  // ── Bridge TLS cert auto-detect + upload ──────────────────────────────────
  async function detectCertPath(inputId) {
    inputId = inputId || 'bridge-cert';
    const input = document.getElementById(inputId);
    if (!input) return;
    try {
      const r = await fetch('/api/find-bridge-cert', { headers: { 'X-CSRF-Token': CSRF } });
      const d = await r.json();
      if (d.found) {
        input.value = d.path;
        input.dispatchEvent(new Event('change'));
      } else {
        toast('No cert.pem found under your home directory. Click Browse to pick one manually, or export a cert via Bridge → Help → Export TLS Certificate.', 'warn');
      }
    } catch (e) {
      toast('Detection failed: ' + (e && e.message ? e.message : e), 'err');
    }
  }

  function wizDetectCert() { return detectCertPath('wiz-cert-path'); }

  // uploadCert receives the <input type="file"> element directly (not a DOM Event)
  async function uploadCert(el, targetInputId) {
    const file = el.files && el.files[0];
    if (!file) return;
    if (file.size > 256 * 1024) {
      toast('File too large (max 256 KB for a PEM cert).', 'err');
      el.value = '';
      return;
    }
    try {
      const text = await file.text();
      const r = await fetch('/api/upload-bridge-cert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-pem-file', 'X-CSRF-Token': CSRF },
        body: text,
      });
      const d = await r.json();
      if (r.ok && d.path) {
        const input = document.getElementById(targetInputId);
        if (input) {
          input.value = d.path;
          input.dispatchEvent(new Event('change'));
        }
      } else {
        toast('Upload failed: ' + (d.error || ('HTTP ' + r.status)), 'err');
      }
    } catch (e) {
      toast('Upload error: ' + (e && e.message ? e.message : e), 'err');
    } finally {
      el.value = ''; // allow re-picking the same file
    }
  }

  function wizUploadCert(el) { return uploadCert(el, 'wiz-cert-path'); }

  async function testConnections() {
    const btn = document.getElementById('test-btn');
    const res = document.getElementById('test-result');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    res.textContent = 'Testing…';

    async function _runTest() {
      const r = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({
          smtpHost: get('smtp-host'), smtpPort: parseInt(get('smtp-port'), 10),
          imapHost: get('imap-host'), imapPort: parseInt(get('imap-port'), 10),
        }),
      });
      return r.json();
    }

    try {
      let data = await _runTest();

      // If not reachable, try to start Bridge then re-test
      if (!data.smtp || !data.imap) {
        res.textContent = 'Bridge not running — starting…';
        res.style.color = 'var(--muted)';
        const startR = await fetch('/api/start-bridge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
          body: '{}',
        });
        const startD = await startR.json();
        if (startD.error) {
          res.textContent = '⚠️ ' + startD.error;
          res.style.color = 'var(--danger)';
          return;
        }
        res.textContent = 'Re-testing…';
        data = await _runTest();
      }

      var ss = connStatusText(data.smtp, data.smtpAuth);
      var iss = connStatusText(data.imap, data.imapAuth);
      res.innerHTML = 'SMTP: ' + escHtml(ss.text) + '<br>IMAP: ' + escHtml(iss.text);
      // Green only when BOTH authenticated; amber if any port-open-but-auth-failed; red if anything unreachable.
      var bothAuthed = data.smtpAuth && data.imapAuth && data.smtpAuth.authenticated === true && data.imapAuth.authenticated === true;
      var anyUnreachable = !data.smtp || !data.imap;
      res.style.color = bothAuthed ? 'var(--success)' : (anyUnreachable ? 'var(--danger)' : 'var(--warning, #b26a00)');
    } catch(e) {
      res.textContent = 'Error: ' + e.message;
      res.style.color = 'var(--danger)';
    } finally {
      btn.disabled = false; btn.textContent = 'Test Connections';
    }
  }

  // ── Permissions tab ───────────────────────────────────────────────────────
  function buildCategoryUI() {
    const container = document.getElementById('categories');
    if (!container) return;
    for (const [catKey, cat] of Object.entries(CATEGORIES)) {
      const el = document.createElement('div');
      el.className = 'category';
      el.innerHTML =
        '<div class="category-header" data-action="toggleCategory">' +
          '<span class="caret">▶</span>' +
          '<div class="category-info">' +
            '<div class="name">' + escHtml(cat.label) + '</div>' +
            '<div class="desc">' + escHtml(cat.description) + '</div>' +
          '</div>' +
          '<span class="risk-badge risk-' + escHtml(cat.risk) + '">' + escHtml(cat.risk) + '</span>' +
          '<label class="toggle-wrap">' +
            '<span class="toggle"><input type="checkbox" id="cat-' + escHtml(catKey) + '" ' +
              'data-change="toggleCategoryAll" data-cat="' + escHtml(catKey) + '"><span class="slider"></span></span>' +
            '<span style="font-size:12px;color:var(--muted)">All</span>' +
          '</label>' +
        '</div>' +
        '<div class="category-body" id="body-' + escHtml(catKey) + '">' +
          cat.tools.map(t => toolRow(t)).join('') +
        '</div>';
      container.appendChild(el);
    }
  }

  function toolRow(tool) {
    const label = tool.replace(/_/g,'  ').replace(/\\b\\w/g, c => c.toUpperCase());
    return '<div class="tool-row">' +
      '<span class="tool-name">' + escHtml(tool) + '</span>' +
      '<span style="font-size:12px;color:var(--muted);flex:1">' + escHtml(label) + '</span>' +
      '<div class="rate-wrap">' +
        '<label>Limit</label>' +
        '<input class="rate-input" type="number" min="1" max="9999" placeholder="∞" ' +
          'id="rate-' + escHtml(tool) + '" title="Max calls per window (blank = unlimited)">' +
        '<select class="rate-window" id="rate-window-' + escHtml(tool) + '" title="Rate limit time window">' +
          '<option value="second">/sec</option>' +
          '<option value="minute">/min</option>' +
          '<option value="hour" selected>/hr</option>' +
          '<option value="day">/day</option>' +
        '</select>' +
      '</div>' +
      '<label class="toggle-wrap">' +
        '<span class="toggle"><input type="checkbox" id="tool-' + escHtml(tool) + '" ' +
          'data-change="onToolToggle" data-tool="' + escHtml(tool) + '"><span class="slider"></span></span>' +
      '</label>' +
    '</div>';
  }

  function populatePermissions(c) {
    if (!c) return;
    const perms = c.permissions || {};
    const tools = perms.tools || {};
    document.querySelectorAll('.preset-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.preset === perms.preset);
    });
    if (perms.preset === 'custom') {
      document.getElementById('custom-preset-btn').style.display = '';
    }
    for (const tool of ALL_TOOLS) {
      const perm  = tools[tool] || { enabled: true, rateLimit: null };
      const cbEl  = document.getElementById('tool-' + tool);
      const rateEl= document.getElementById('rate-' + tool);
      const winEl = document.getElementById('rate-window-' + tool);
      if (cbEl)   { cbEl.checked = perm.enabled !== false; toolEnabled[tool] = cbEl.checked; }
      if (rateEl) { rateEl.value = perm.rateLimit != null ? perm.rateLimit : ''; rateEl.disabled = !perm.enabled; toolRate[tool] = perm.rateLimit; }
      if (winEl)  { winEl.value = perm.rateLimitWindow || 'hour'; winEl.disabled = !perm.enabled; }
    }
    for (const catKey of Object.keys(CATEGORIES)) { updateCategoryToggle(catKey); }
  }

  function onToolToggle(tool, enabled) {
    toolEnabled[tool] = enabled;
    const rateEl = document.getElementById('rate-' + tool);
    const winEl  = document.getElementById('rate-window-' + tool);
    if (rateEl) rateEl.disabled = !enabled;
    if (winEl)  winEl.disabled  = !enabled;
    for (const [catKey, cat] of Object.entries(CATEGORIES)) {
      if (cat.tools.includes(tool)) { updateCategoryToggle(catKey); break; }
    }
    markCustomPreset();
  }

  function toggleCategoryAll(catKey, checked) {
    const cat = CATEGORIES[catKey];
    for (const tool of cat.tools) {
      const el = document.getElementById('tool-' + tool);
      if (el) { el.checked = checked; toolEnabled[tool] = checked; }
      const re = document.getElementById('rate-' + tool);
      if (re) re.disabled = !checked;
    }
    markCustomPreset();
  }

  function toggleCategory(header) {
    header.classList.toggle('open');
    header.nextElementSibling.classList.toggle('open');
  }

  function updateCategoryToggle(catKey) {
    const cat = CATEGORIES[catKey];
    const allEnabled = cat.tools.every(t => {
      const el = document.getElementById('tool-' + t);
      return el ? el.checked : true;
    });
    const catEl = document.getElementById('cat-' + catKey);
    if (catEl) catEl.checked = allEnabled;
  }

  function captureToolState() {
    const snap = {};
    for (const tool of ALL_TOOLS) {
      const cbEl  = document.getElementById('tool-' + tool);
      const rateEl= document.getElementById('rate-' + tool);
      const winEl = document.getElementById('rate-window-' + tool);
      const rateVal = rateEl && rateEl.value.trim() !== '' ? parseInt(rateEl.value, 10) : null;
      snap[tool] = {
        enabled:         cbEl ? cbEl.checked : true,
        rateLimit:       rateVal && rateVal > 0 ? rateVal : null,
        rateLimitWindow: winEl ? winEl.value : 'hour',
      };
    }
    return snap;
  }

  function restoreCustom() {
    if (!customSnapshot) return;
    for (const tool of ALL_TOOLS) {
      const perm  = customSnapshot[tool] || { enabled: true, rateLimit: null, rateLimitWindow: 'hour' };
      const cbEl  = document.getElementById('tool-' + tool);
      const rateEl= document.getElementById('rate-' + tool);
      const winEl = document.getElementById('rate-window-' + tool);
      if (cbEl)   { cbEl.checked = perm.enabled !== false; toolEnabled[tool] = cbEl.checked; }
      if (rateEl) { rateEl.value = perm.rateLimit != null ? perm.rateLimit : ''; rateEl.disabled = !perm.enabled; toolRate[tool] = perm.rateLimit; }
      if (winEl)  { winEl.value = perm.rateLimitWindow || 'hour'; winEl.disabled = !perm.enabled; }
    }
    for (const catKey of Object.keys(CATEGORIES)) { updateCategoryToggle(catKey); }
    markCustomPreset();
  }

  async function applyPreset(preset) {
    if (cfg && cfg.permissions && cfg.permissions.preset === 'custom') {
      customSnapshot = captureToolState();
    }
    const r = await fetch('/api/preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify({ preset, configResetGeneration: cfg?.configResetGeneration ?? 0 }),
    });
    if (!r.ok) { toast('Failed to apply preset', 'err'); return; }
    await refresh();
    const customBtn = document.getElementById('custom-preset-btn');
    if (customSnapshot) {
      customBtn.style.display = '';
      customBtn.classList.remove('active');
    } else {
      customBtn.style.display = 'none';
    }
    toast('Preset "' + preset + '" applied.', 'ok');
  }

  function markCustomPreset() {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('custom-preset-btn');
    btn.style.display = ''; btn.classList.add('active');
  }

  async function savePermissions() {
    const tools = {};
    for (const tool of ALL_TOOLS) {
      const cbEl  = document.getElementById('tool-' + tool);
      const rateEl= document.getElementById('rate-' + tool);
      const winEl = document.getElementById('rate-window-' + tool);
      const enabled  = cbEl ? cbEl.checked : true;
      const rateVal  = rateEl && rateEl.value.trim() !== '' ? parseInt(rateEl.value, 10) : null;
      const rateLimit = rateVal && rateVal > 0 ? rateVal : null;
      const rateLimitWindow = winEl ? winEl.value : 'hour';
      tools[tool] = { enabled, rateLimit, ...(rateLimit ? { rateLimitWindow } : {}) };
    }
    let preset = 'custom';
    document.querySelectorAll('.preset-btn').forEach(b => {
      if (b.classList.contains('active') && b.dataset.preset !== 'custom') preset = b.dataset.preset;
    });
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify({
        configResetGeneration: cfg?.configResetGeneration ?? 0,
        permissions: { preset, tools },
      }),
    });
    if (r.ok) { toast('Permissions saved. Changes take effect within 15 s.', 'ok'); await refresh(); }
    else       { toast('Save failed.', 'err'); }
  }

  // ── Status tab ────────────────────────────────────────────────────────────
  function populateStatus(c) {
    if (!c) return;
    const perms = c.permissions || {};
    const tools = perms.tools || {};
    document.getElementById('info-config-exists').textContent = 'Yes';
    document.getElementById('info-preset').textContent = perms.preset || '—';
    const disabled = ALL_TOOLS.filter(t => tools[t] && !tools[t].enabled);
    document.getElementById('info-disabled').textContent = disabled.length ? disabled.join(', ') : 'None';
    const limited = ALL_TOOLS.filter(t => tools[t] && tools[t].rateLimit != null);
    document.getElementById('info-rate-limited').textContent =
      limited.length ? limited.map(t => {
        const w = tools[t].rateLimitWindow || 'hour';
        const wLabel = w === 'second' ? 'sec' : w === 'minute' ? 'min' : w === 'day' ? 'day' : 'hr';
        return t + ' (' + tools[t].rateLimit + '/' + wLabel + ')';
      }).join(', ') : 'None';
    var credStorageEl = document.getElementById('info-credential-storage');
    if (credStorageEl) {
      credStorageEl.textContent = c.credentialStorage === 'keychain' ? 'OS keychain' : c.credentialStorage === 'encrypted-file' ? 'Encrypted file' : 'Config file (plaintext)';
    }
    buildClaudeSnippet(c.connection || {});
  }

  function buildClaudeSnippet(cn) {
    const snippet = {
      'mailpouch': {
        command: 'node',
        args: [__distIndexPath || '/path/to/mailpouch/dist/index.js'],
      },
    };
    document.getElementById('claude-snippet').textContent = JSON.stringify(snippet, null, 2);
  }

  function copySnippet() {
    const text = document.getElementById('claude-snippet').textContent;
    navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard.', 'ok'));
  }

  // ══ UPDATES ═══════════════════════════════════════════════════════════════

  // Seed installed version immediately from injected constant
  document.getElementById('update-current') && (document.getElementById('update-current').textContent = PKG_VERSION);

  async function checkForUpdates() {
    const btn    = document.getElementById('check-update-btn');
    const status = document.getElementById('update-status');
    const installBtn = document.getElementById('install-update-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Checking…';
    status.textContent = 'Checking npm registry…';
    status.style.color = 'var(--muted)';
    installBtn.style.display = 'none';
    try {
      const r = await fetch('/api/check-update');
      const d = await r.json();
      if (d.error) {
        status.textContent = '⚠️ ' + d.error;
        status.style.color = 'var(--danger)';
        return;
      }
      document.getElementById('update-current').textContent = d.current;
      document.getElementById('update-latest').textContent  = d.latest;
      if (d.updateAvailable) {
        status.textContent = '🆕 Update available!';
        status.style.color = 'var(--success, #22c55e)';
        installBtn.style.display = '';
      } else {
        status.textContent = '✅ Up to date';
        status.style.color = 'var(--success, #22c55e)';
      }
    } catch(e) {
      status.textContent = '⚠️ Check failed: ' + e.message;
      status.style.color = 'var(--danger)';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check for Updates';
    }
  }

  async function installUpdate() {
    const installBtn   = document.getElementById('install-update-btn');
    const actionStatus = document.getElementById('update-action-status');
    const output       = document.getElementById('update-output');
    installBtn.disabled = true;
    installBtn.innerHTML = '<span class="spinner"></span> Installing…';
    actionStatus.textContent = 'Running npm install -g …';
    actionStatus.style.color = 'var(--muted)';
    output.style.display = 'none';
    output.textContent  = '';
    try {
      const r = await fetch('/api/install-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: '{}',
      });
      const d = await r.json();
      output.textContent  = d.output || d.error || '';
      output.style.display = '';
      if (d.ok) {
        installBtn.style.display = 'none';
        if (d.restarting) {
          actionStatus.textContent = '✅ Update installed — server is restarting…';
          actionStatus.style.color = 'var(--success, #22c55e)';
          var _pollAttempts = 0;
          var _poll = setInterval(function() {
            _pollAttempts++;
            fetch('/api/status').then(function() {
              clearInterval(_poll);
              window.location.reload();
            }).catch(function() {
              if (_pollAttempts >= 15) {
                clearInterval(_poll);
                actionStatus.textContent = '✅ Update installed — reload this page once the server restarts.';
              }
            });
          }, 2000);
        } else {
          actionStatus.textContent = '✅ Update installed. Restart the MCP server to use the new version.';
          actionStatus.style.color = 'var(--success, #22c55e)';
          await checkForUpdates();
        }
      } else {
        actionStatus.textContent = '❌ Install failed — see output below.';
        actionStatus.style.color = 'var(--danger)';
        installBtn.disabled = false;
        installBtn.textContent = 'Retry Install';
      }
    } catch(e) {
      actionStatus.textContent = '❌ ' + e.message;
      actionStatus.style.color = 'var(--danger)';
      installBtn.disabled = false;
      installBtn.textContent = 'Retry Install';
    }
  }

  // Auto-check for updates when the Status tab is first opened
  (function() {
    let checked = false;
    const observer = new MutationObserver(() => {
      const statusSection = document.getElementById('status');
      if (!checked && statusSection && statusSection.style.display !== 'none' && statusSection.offsetParent !== null) {
        checked = true;
        checkForUpdates();
      }
    });
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['style', 'class'] });
  })();

  // ══ LOGS TAB ══════════════════════════════════════════════════════════════

  const LOG = {
    page: 1,
    pages: 1,
    total: 0,
    following: false,
    pollTimer: null,
  };

  function logInit() {
    logGoLast();
  }

  async function logFetch(page) {
    try {
      const r    = await fetch('/api/logs?page=' + page);
      const data = await r.json();
      LOG.page  = data.page;
      LOG.pages = data.pages;
      LOG.total = data.total;
      logRender(data.lines);
      logUpdateToolbar();
    } catch(e) {
      const outEl = document.getElementById('log-output'); if (outEl) outEl.textContent = 'Error loading logs: ' + (e && e.message ? e.message : String(e));
    }
  }

  function logRender(lines) {
    const out = document.getElementById('log-output');
    if (!out) return;
    if (lines.length === 0) { out.textContent = '(no log entries on this page)'; return; }
    out.innerHTML = lines.map(function(l) {
      const ts  = l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : '';
      const lvl = (l.level || 'info').toUpperCase().padEnd(5);
      const ctx = (l.context || '').padEnd(12);
      const msg = escHtml(l.message || '');
      const cls = l.level === 'error' ? 'color:#f87171' :
                  l.level === 'warn'  ? 'color:#fbbf24' :
                  l.level === 'debug' ? 'color:#94a3b8' : 'color:var(--text)';
      return '<span style="' + cls + '">' +
        '<span style="color:var(--muted)">' + escHtml(ts) + ' </span>' +
        '<b>' + escHtml(lvl) + '</b> ' +
        '<span style="color:var(--muted)">[' + escHtml(ctx.trim()) + ']</span> ' +
        msg + '</span>';
    }).join('\\n');
    if (LOG.following) out.scrollTop = out.scrollHeight;
  }

  function logUpdateToolbar() {
    const info = document.getElementById('log-page-info');
    if (info) info.textContent = 'Page ' + LOG.page + ' of ' + LOG.pages + '  (' + LOG.total + ' lines)';
    const btnFirst = document.getElementById('log-btn-first'); if (btnFirst) btnFirst.disabled = LOG.page <= 1;
    const btnPrev  = document.getElementById('log-btn-prev');  if (btnPrev)  btnPrev.disabled  = LOG.page <= 1;
    const btnNext  = document.getElementById('log-btn-next');  if (btnNext)  btnNext.disabled  = LOG.page >= LOG.pages;
    const btnLast  = document.getElementById('log-btn-last');  if (btnLast)  btnLast.disabled  = LOG.page >= LOG.pages;
    const followBtn = document.getElementById('log-btn-follow');
    if (followBtn) { followBtn.textContent = LOG.following ? 'Following ●' : 'Follow ○'; followBtn.style.color = LOG.following ? 'var(--success)' : ''; }
  }

  function logStartFollow() {
    if (LOG.pollTimer) return;
    LOG.following = true;
    LOG.pollTimer = setInterval(async () => {
      const logsSection = document.getElementById('logs'); if (!logsSection || !logsSection.classList.contains('active')) return;
      await logFetch(LOG.pages);
    }, 2000);
    logUpdateToolbar();
  }

  function logStopFollow() {
    LOG.following = false;
    if (LOG.pollTimer) { clearInterval(LOG.pollTimer); LOG.pollTimer = null; }
    logUpdateToolbar();
  }

  function logGoFirst() { logStopFollow(); logFetch(1); }
  function logGoPrev()  { logStopFollow(); logFetch(Math.max(1, LOG.page - 1)); }
  function logGoNext()  { logStopFollow(); logFetch(Math.min(LOG.pages, LOG.page + 1)); }
  async function logGoLast() {
    await logFetch(9999);
    logStartFollow();
  }
  function logToggleFollow() {
    if (LOG.following) { logStopFollow(); } else { logGoLast(); }
  }
  function logClear() {
    showConfirm({
      title: 'Clear log file?',
      body:  'All log entries will be permanently deleted.',
      label: 'Clear',
      onConfirm: async () => {
        await fetch('/api/logs/clear', { method: 'POST', headers: { 'X-CSRF-Token': CSRF } });
        LOG.page = 1; LOG.pages = 1; LOG.total = 0;
        logFetch(1);
      },
    });
  }

  // ── Response Limits ───────────────────────────────────────────────────────
  const RL_DEFAULTS = { maxResponseBytes: 921600, maxEmailBodyChars: 500000, maxEmailListResults: 50, maxAttachmentBytes: 600000, warnOnLargeResponse: true };

  function populateResponseLimits(c) {
    const rl = (c && c.responseLimits) || RL_DEFAULTS;
    document.getElementById('rl-max-response').value = Math.round((rl.maxResponseBytes || RL_DEFAULTS.maxResponseBytes) / 1024);
    document.getElementById('rl-max-body').value     = rl.maxEmailBodyChars  || RL_DEFAULTS.maxEmailBodyChars;
    document.getElementById('rl-max-list').value      = rl.maxEmailListResults || RL_DEFAULTS.maxEmailListResults;
    document.getElementById('rl-max-attach').value    = Math.round((rl.maxAttachmentBytes || RL_DEFAULTS.maxAttachmentBytes) / 1024);
    document.getElementById('rl-warn-large').checked  = rl.warnOnLargeResponse !== false;
  }

  function gatherResponseLimits() {
    return {
      maxResponseBytes:    parseInt(document.getElementById('rl-max-response').value, 10) * 1024,
      maxEmailBodyChars:   parseInt(document.getElementById('rl-max-body').value, 10),
      maxEmailListResults: parseInt(document.getElementById('rl-max-list').value, 10),
      maxAttachmentBytes:  parseInt(document.getElementById('rl-max-attach').value, 10) * 1024,
      warnOnLargeResponse: document.getElementById('rl-warn-large').checked,
    };
  }

  function rlResetDefaults() {
    populateResponseLimits({ responseLimits: RL_DEFAULTS });
    document.getElementById('rl-status').textContent = 'Reset to defaults (not saved yet).';
  }

  async function rlSave() {
    const statusEl = document.getElementById('rl-status');
    statusEl.textContent = 'Saving…';
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({
          configResetGeneration: cfg?.configResetGeneration ?? 0,
          responseLimits: gatherResponseLimits(),
        }),
      });
      if (r.ok) {
        statusEl.textContent = 'Saved. Changes take effect within 15 seconds.';
        statusEl.style.color = 'var(--success)';
      } else {
        const err = await r.json();
        statusEl.textContent = 'Error: ' + (err.error || 'Unknown');
        statusEl.style.color = 'var(--danger)';
      }
    } catch(e) {
      statusEl.textContent = 'Network error.';
      statusEl.style.color = 'var(--danger)';
    }
  }

  // Map a (reachable, auth) pair to a label + color. Crucially, a port that is
  // open but failing auth (e.g. a 454) is shown as a WARNING, never green —
  // "reachable" alone never implies a working connection.
  function connStatusText(reachable, auth) {
    if (!reachable) return { text: '❌ Unreachable', color: 'var(--danger)' };
    if (auth && auth.authenticated === true) return { text: '✅ Connected', color: 'var(--success)' };
    if (auth && auth.authenticated === false) return { text: '⚠ Port open · auth failed' + (auth.error ? ' (' + auth.error + ')' : ''), color: 'var(--warning, #b26a00)' };
    return { text: '◐ Port open · auth not tested', color: 'var(--muted)' };
  }

  async function runStatusCheck() {
    const btn     = document.getElementById('status-check-btn');
    const res     = document.getElementById('status-check-result');
    const results = document.getElementById('connectivity-results');
    btn.disabled = true; btn.innerHTML = '<span class="spinner-dark"></span>';
    res.textContent = 'Checking…'; results.style.display = 'none';
    try {
      const c = (cfg && cfg.connection) || {};
      const r = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({
          smtpHost: c.smtpHost || 'localhost', smtpPort: c.smtpPort || 1025,
          imapHost: c.imapHost || 'localhost', imapPort: c.imapPort || 1143,
        }),
      });
      const data = await r.json();
      var ss = connStatusText(data.smtp, data.smtpAuth);
      var iss = connStatusText(data.imap, data.imapAuth);
      document.getElementById('smtp-check-status').textContent = ss.text;
      document.getElementById('smtp-check-status').style.color = ss.color;
      document.getElementById('imap-check-status').textContent = iss.text;
      document.getElementById('imap-check-status').style.color = iss.color;
      results.style.display = ''; res.textContent = '';
    } catch(e) {
      res.textContent = 'Error: ' + e.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Check Now';
    }
  }

  function resetConfig() {
    showConfirm({
      title: 'Reset to defaults?',
      body:  'Current settings will be permanently lost.',
      label: 'Reset',
      onConfirm: async () => {
        const r = await fetch('/api/reset', { method: 'POST', headers: { 'X-CSRF-Token': CSRF } });
        let result = null;
        try { result = await r.json(); } catch {}
        if (r.ok) {
          const manualKeychainCleanupRequired = result?.manualKeychainCleanupRequired === true
            || result?.credentialsCleared === false;
          const message = manualKeychainCleanupRequired
            ? 'Settings reset, but some OS-keychain credentials could not be removed. Delete them manually before restarting; live credential hydration is disabled.'
            : result?.restartRequired === true
              ? 'Settings reset. Restart the MCP server before new calls use the defaults.'
              : 'Settings reset. Live services now use the defaults.';
          toast(message, manualKeychainCleanupRequired ? 'warn' : 'ok');
          await refresh();
        } else {
          toast(result?.error || 'Reset failed.', 'err');
        }
      },
    });
  }

  // ── Escalation management ─────────────────────────────────────────────────
  async function loadEscalations() {
    try {
      const r = await fetch('/api/escalations', { headers: { 'X-CSRF-Token': CSRF } });
      const data = await r.json();
      renderEscalations(data.pending || []);
    } catch {}
  }

  async function loadAuditLog() {
    try {
      const r = await fetch('/api/audit', { headers: { 'X-CSRF-Token': CSRF } });
      const data = await r.json();
      renderAuditLog(data.entries || []);
    } catch {}
  }

  function renderEscalations(list) {
    const banner = document.getElementById('escalation-banner');
    const cards  = document.getElementById('escalation-cards');
    if (!list.length) { banner.style.display = 'none'; cards.innerHTML = ''; return; }
    banner.style.display = '';
    cards.innerHTML = list.map(e => {
      const newTools = e.newTools || [];
      const toolHtml = newTools.length
        ? '<div class="tool-chips">' + newTools.map(t => '<span class="tool-chip-new">' + escHtml(t) + '</span>').join('') + '</div>'
        : '<span style="color:var(--muted);font-size:12px">Rate-limit relaxation only — no new tool types.</span>';
      const riskClass = { read_only:'safe', send_only:'moderate', supervised:'moderate', full:'high' }[e.targetPreset] || 'moderate';
      return '<div class="escalation-card-body">' +
        '<div class="escalation-meta">Challenge ID: <code>' + escHtml(e.id) + '</code> &nbsp;·&nbsp; ' +
        'Requested: ' + new Date(e.requestedAt).toLocaleString() + '</div>' +
        '<div class="escalation-field"><label>Agent\\'s reason</label>' +
          '<div class="escalation-reason">' + escHtml(e.reason) + '</div></div>' +
        '<div class="escalation-field"><label>Privilege change</label>' +
          '<div class="escalation-preset-row">' +
            '<span class="preset-badge safe">' + escHtml(e.currentPreset) + '</span>' +
            '<span style="color:var(--muted)">→</span>' +
            '<span class="preset-badge ' + escHtml(riskClass) + '">' + escHtml(e.targetPreset) + '</span>' +
          '</div></div>' +
        '<div class="escalation-field"><label>New tools (' + newTools.length + ')</label>' + toolHtml + '</div>' +
        '<div class="escalation-confirm-wrap">' +
          '<label>Type APPROVE to enable the button</label>' +
          '<input class="escalation-confirm-input" type="text" id="conf-' + escHtml(e.id) + '" ' +
            'placeholder="APPROVE" autocomplete="off" spellcheck="false" ' +
            'data-input="confirmInput" data-id="' + escHtml(e.id) + '">' +
        '</div>' +
        '<div class="escalation-actions">' +
          '<button class="btn btn-deny" data-action="denyEscalation" data-id="' + escHtml(e.id) + '">✗ Deny</button>' +
          '<button class="btn btn-approve" id="approve-' + escHtml(e.id) + '" disabled ' +
            'data-action="approveEscalation" data-id="' + escHtml(e.id) + '">✓ Approve</button>' +
          '<span class="escalation-countdown" id="cd-' + escHtml(e.id) + '">' +
            formatCountdown(e.expiresAt) + '</span>' +
        '</div></div>';
    }).join('<hr style="border-color:var(--border);margin:0">');
    for (const e of list) { startCountdown(e.id, e.expiresAt); }
  }

  function renderAuditLog(entries) {
    const tbody = document.getElementById('audit-log-body');
    if (!tbody) return;
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);padding:12px 10px">No escalation events recorded yet.</td></tr>';
      return;
    }
    tbody.innerHTML = entries.map(e => {
      const cls = ['requested','approved','denied','expired'].includes(e.event) ? 'audit-event-' + e.event : 'audit-event-other';
      return '<tr>' +
        '<td>' + new Date(e.time).toLocaleString() + '</td>' +
        '<td class="' + cls + '">' + escHtml(e.event) + '</td>' +
        '<td>' + escHtml(e.fromPreset) + '</td>' +
        '<td>' + escHtml(e.toPreset) + '</td>' +
        '<td>' + escHtml(e.via || '—') + '</td>' +
        '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" ' +
          'title="' + escHtml(e.reason || '') + '">' + escHtml((e.reason || '—').slice(0,60)) + '</td>' +
      '</tr>';
    }).join('');
  }

  function formatCountdown(expiresAt) {
    const secs = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
    return 'Expires in ' + Math.floor(secs/60) + ':' + String(secs%60).padStart(2,'0');
  }

  const countdownIntervals = {};
  function startCountdown(id, expiresAt) {
    if (countdownIntervals[id]) clearInterval(countdownIntervals[id]);
    countdownIntervals[id] = setInterval(() => {
      const el = document.getElementById('cd-' + id);
      if (!el) { clearInterval(countdownIntervals[id]); return; }
      const secs = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
      el.textContent = 'Expires in ' + Math.floor(secs/60) + ':' + String(secs%60).padStart(2,'0');
      el.classList.toggle('urgent', secs < 60);
      if (secs === 0) { clearInterval(countdownIntervals[id]); loadEscalations(); }
    }, 1000);
  }

  function onConfirmInput(id) {
    const input = document.getElementById('conf-' + id);
    const btn   = document.getElementById('approve-' + id);
    if (input && btn) btn.disabled = input.value !== 'APPROVE';
  }

  async function approveEscalation(id) {
    const input = document.getElementById('conf-' + id);
    if (!input || input.value !== 'APPROVE') return;
    try {
      const r = await fetch('/api/escalations/' + id + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({ confirm: 'APPROVE' }),
      });
      const d = await r.json();
      if (r.ok) {
        toast('Escalation approved. New preset: ' + d.preset + '. Takes effect within 15 s.', 'ok');
        await loadEscalations(); await loadAuditLog(); await refresh();
      } else {
        toast('Error: ' + (d.error || 'Unknown error'), 'err');
      }
    } catch(e) {
      toast('Network error: ' + e.message, 'err');
    }
  }

  async function denyEscalation(id) {
    try {
      const r = await fetch('/api/escalations/' + id + '/deny', {
        method: 'POST', headers: { 'X-CSRF-Token': CSRF },
      });
      if (r.ok) {
        toast('Escalation denied.', 'ok');
        await loadEscalations(); await loadAuditLog();
      } else {
        const d = await r.json();
        toast('Error: ' + (d.error || 'Unknown error'), 'err');
      }
    } catch(e) {
      toast('Network error: ' + e.message, 'err');
    }
  }

  // ── Grant modal (merged from second IIFE) ─────────────────────────────────
  let currentClientId = null;

  function openGrantModal(clientId, clientName, currentConditions) {
    currentClientId = clientId;
    document.getElementById('gm-subtitle').textContent = clientName + ' (' + clientId + ')';
    document.getElementById('gm-preset').value = 'supervised';
    document.getElementById('gm-folders').value = '';
    document.getElementById('gm-ip').value = '';
    document.getElementById('gm-note').value = '';
    document.getElementById('gm-deny-delete').checked = false;
    document.getElementById('gm-deny-send').checked = false;
    (document.querySelector('input[name="gm-dur"][value="1h"]') || {}).checked = true;
    if (currentConditions && currentConditions.folderAllowlist) {
      document.getElementById('gm-folders').value = (currentConditions.folderAllowlist || []).join(', ');
    }
    if (currentConditions && currentConditions.ipPins) {
      document.getElementById('gm-ip').value = (currentConditions.ipPins || []).join(', ');
    }
    document.getElementById('grant-modal-backdrop').style.display = 'block';
  }

  function closeGrantModal() {
    document.getElementById('grant-modal-backdrop').style.display = 'none';
    currentClientId = null;
  }

  async function submitGrantModal() {
    if (!currentClientId) return;
    const preset = document.getElementById('gm-preset').value;
    const dur = (document.querySelector('input[name="gm-dur"]:checked') || {}).value || 'never';
    let expiresAt;
    if (dur === '1h')   expiresAt = new Date(Date.now() + 60*60*1000).toISOString();
    else if (dur === '24h') expiresAt = new Date(Date.now() + 24*60*60*1000).toISOString();
    else if (dur === '7d')  expiresAt = new Date(Date.now() + 7*24*60*60*1000).toISOString();
    else if (dur === 'custom') {
      const v = document.getElementById('gm-custom-expiry').value;
      if (v) expiresAt = new Date(v).toISOString();
    }
    const foldersRaw = document.getElementById('gm-folders').value.trim();
    const folderAllowlist = foldersRaw ? foldersRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const ipRaw = document.getElementById('gm-ip').value.trim();
    const ipPins = ipRaw ? ipRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const toolOverrides = {};
    if (document.getElementById('gm-deny-delete').checked) {
      toolOverrides.delete_email = false;
      toolOverrides.bulk_delete_emails = false;
    }
    if (document.getElementById('gm-deny-send').checked) {
      toolOverrides.send_email = false;
      toolOverrides.reply_to_email = false;
      toolOverrides.forward_email = false;
    }
    const note = document.getElementById('gm-note').value.trim() || undefined;
    const body = {
      preset,
      conditions: (expiresAt || folderAllowlist || ipPins) ? { expiresAt, folderAllowlist, ipPins } : undefined,
      toolOverrides: Object.keys(toolOverrides).length > 0 ? toolOverrides : undefined,
      note,
    };
    const r = await fetch('/api/agents/' + encodeURIComponent(currentClientId) + '/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      if (__mpReloading) return;
      const errBody = await r.json().catch(() => null);
      toast('Approve failed: ' + (errBody?.error || r.status), 'err');
      return;
    }
    closeGrantModal();
    refreshAgents();
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function get(id) { return document.getElementById(id)?.value ?? ''; }
  function set(id, v) { const el = document.getElementById(id); if (el) el.value = v; }

  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ── Shared confirm modal ─────────────────────────────────────────────────
  let _confirmCallback = null;
  function showConfirm({ title, body, label, btnClass, onConfirm }) {
    label    = label    || 'Confirm';
    btnClass = btnClass || 'btn-danger';
    document.getElementById('mp-confirm-title').textContent = title || '';
    document.getElementById('mp-confirm-body').textContent  = body;
    const okBtn = document.getElementById('mp-confirm-ok');
    okBtn.textContent = label;
    okBtn.className   = 'btn ' + btnClass;
    _confirmCallback  = onConfirm;
    document.getElementById('mp-confirm-backdrop').style.display = '';
  }
  function confirmModalOk() {
    document.getElementById('mp-confirm-backdrop').style.display = 'none';
    const cb = _confirmCallback;
    _confirmCallback = null;
    if (cb) cb();
  }
  function confirmModalCancel() {
    document.getElementById('mp-confirm-backdrop').style.display = 'none';
    _confirmCallback = null;
  }

  let toastTimer;
  function toast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, 3500);
  }

})();
</script>

<!-- ══ SHARED CONFIRM MODAL ══════════════════════════════════════════════ -->
<div id="mp-confirm-backdrop" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:150">
  <div style="max-width:420px;margin:20vh auto;background:var(--surface);border-radius:var(--radius);padding:22px;color:var(--text);font-family:system-ui,sans-serif;border:1px solid var(--border);box-shadow:var(--shadow-lg)">
    <div id="mp-confirm-title" style="font-size:16px;font-weight:700;margin-bottom:8px"></div>
    <div id="mp-confirm-body" style="font-size:14px;color:var(--text2);margin-bottom:20px;line-height:1.5"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px">
      <button class="btn btn-ghost" data-action="confirmModalCancel">Cancel</button>
      <button class="btn btn-danger" id="mp-confirm-ok" data-action="confirmModalOk">Confirm</button>
    </div>
  </div>
</div>

<!-- ══ APPROVE-WITH-CONDITIONS MODAL (Agents tab) ═════════════════════════ -->
<div id="grant-modal-backdrop" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100">
  <div id="grant-modal" style="max-width:520px;margin:8vh auto;background:var(--surface);border-radius:var(--radius);padding:22px;color:var(--text);font-family:system-ui,sans-serif">
    <div style="font-size:16px;font-weight:700;margin-bottom:6px">Approve with conditions</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:16px" id="gm-subtitle"></div>
    <div class="field" style="margin-bottom:12px">
      <label style="font-size:12px;color:var(--text2)">Preset</label>
      <select id="gm-preset" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px">
        <option value="read_only">read_only</option>
        <option value="send_only">send_only</option>
        <option value="supervised" selected>supervised</option>
        <option value="full">full</option>
      </select>
    </div>
    <div class="field" style="margin-bottom:12px">
      <label style="font-size:12px;color:var(--text2)">Duration</label>
      <div style="margin-top:4px;display:flex;gap:8px;flex-wrap:wrap">
        <label><input type="radio" name="gm-dur" value="never"> never expires</label>
        <label><input type="radio" name="gm-dur" value="1h" checked> 1 hour</label>
        <label><input type="radio" name="gm-dur" value="24h"> 24 hours</label>
        <label><input type="radio" name="gm-dur" value="7d"> 7 days</label>
        <label><input type="radio" name="gm-dur" value="custom"> custom…</label>
      </div>
      <input type="datetime-local" id="gm-custom-expiry" style="display:none;margin-top:6px;padding:6px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px">
    </div>
    <div class="field" style="margin-bottom:12px">
      <label style="font-size:12px;color:var(--text2)">Folder allowlist (optional, comma-separated)</label>
      <input type="text" id="gm-folders" placeholder="INBOX, Sent" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;box-sizing:border-box">
    </div>
    <div class="field" style="margin-bottom:12px">
      <label style="font-size:12px;color:var(--text2)">IP pin (optional)</label>
      <input type="text" id="gm-ip" placeholder="e.g. 10.0.0.23" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;box-sizing:border-box">
    </div>
    <div class="field" style="margin-bottom:12px">
      <label style="font-size:12px;color:var(--text2)">Advanced</label>
      <div style="margin-top:4px;display:flex;flex-direction:column;gap:4px">
        <label><input type="checkbox" id="gm-deny-delete"> Disable deletion tools (delete_email / bulk_delete_emails)</label>
        <label><input type="checkbox" id="gm-deny-send"> Disable sending (send_email / reply_to_email / forward_email)</label>
      </div>
    </div>
    <div class="field" style="margin-bottom:16px">
      <label style="font-size:12px;color:var(--text2)">Note (optional)</label>
      <input type="text" id="gm-note" maxlength="240" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;box-sizing:border-box">
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px">
      <button class="btn btn-ghost" data-action="closeGrantModal">Cancel</button>
      <button class="btn btn-primary" data-action="submitGrantModal">Save and approve</button>
    </div>
  </div>
</div>

<div id="sa-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100;align-items:flex-start;justify-content:center">
  <div style="max-width:520px;width:92%;margin-top:8vh;background:var(--surface);border-radius:var(--radius);padding:22px;color:var(--text);font-family:system-ui,sans-serif">
    <div style="font-size:16px;font-weight:700;margin-bottom:6px">Create service account</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:16px">
      For headless agents (cron, CI, scheduled) that can't do interactive approval.
      Issues a client_id + client_secret and pre-approves its grant. Log in via OAuth
      <code>client_credentials</code>.
    </div>
    <div id="sa-form">
      <div class="field" style="margin-bottom:12px">
        <label style="font-size:12px;color:var(--text2)">Name</label>
        <input type="text" id="sa-name" placeholder="e.g. nightly-triage-cron" maxlength="100" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;box-sizing:border-box">
      </div>
      <div class="field" style="margin-bottom:12px">
        <label style="font-size:12px;color:var(--text2)">Preset</label>
        <select id="sa-preset" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px">
          <option value="read_only" selected>read_only</option>
          <option value="send_only">send_only</option>
          <option value="supervised">supervised</option>
          <option value="full">full</option>
        </select>
      </div>
      <div class="field" style="margin-bottom:12px">
        <label style="font-size:12px;color:var(--text2)">Expires (optional, ISO-8601)</label>
        <input type="datetime-local" id="sa-expires" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;box-sizing:border-box">
      </div>
      <div class="field" style="margin-bottom:16px">
        <label style="font-size:12px;color:var(--text2)">Folder allowlist (optional, comma-separated)</label>
        <input type="text" id="sa-folders" placeholder="INBOX, Archive" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;box-sizing:border-box">
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" data-action="closeServiceAccountModal">Cancel</button>
        <button class="btn btn-primary" data-action="submitServiceAccountModal">Create</button>
      </div>
    </div>
    <div id="sa-secret" style="display:none">
      <div style="font-size:13px;color:#f59e0b;margin-bottom:10px">⚠ Copy the secret now — it is shown once and cannot be recovered.</div>
      <div style="font-size:12px;color:var(--text2)">client_id</div>
      <div id="sa-out-id" style="font-family:monospace;background:var(--surface2);padding:8px;border-radius:6px;margin:4px 0 12px;word-break:break-all"></div>
      <div style="font-size:12px;color:var(--text2)">client_secret</div>
      <div id="sa-out-secret" style="font-family:monospace;background:var(--surface2);padding:8px;border-radius:6px;margin:4px 0 16px;word-break:break-all"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" data-action="copySecret">Copy</button>
        <button class="btn btn-primary" data-action="closeServiceAccountModal">Done</button>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;
}
