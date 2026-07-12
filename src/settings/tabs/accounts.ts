// src/settings/tabs/accounts.ts
export interface AccountsParams {
  certBrowsePlaceholderAttr: string;
}

export function buildAccountsHtml(p: AccountsParams): string {
  return `
  <div class="section-heading">Mail accounts</div>
  <div class="section-subheading">
    Manage the mail providers this server talks to. The active account
    drives default IMAP/SMTP services; a running daemon can apply a live switch
    to new calls without interrupting work already in progress. If live
    switching is unavailable, the UI will ask you to restart. Tools can also
    use an <code>account_id</code> argument to target a configured account directly.
  </div>

  <div class="card" style="margin-top:10px">
    <div id="accounts-list" style="display:flex;flex-direction:column;gap:10px">
      <div class="hint" style="text-align:center;padding:30px">Loading…</div>
    </div>
    <div style="margin-top:16px;display:flex;gap:8px">
      <button class="btn btn-primary" data-action="openAccountForm" data-provider-type="proton-bridge">+ Add Proton Bridge account</button>
      <button class="btn btn-primary" data-action="openAccountForm" data-provider-type="imap">+ Add IMAP account</button>
    </div>
  </div>

  <div id="account-form-backdrop" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100">
    <div style="max-width:560px;margin:6vh auto;background:var(--surface);border-radius:var(--radius);padding:22px;color:var(--text);font-family:system-ui,sans-serif;max-height:86vh;overflow:auto;border:1px solid var(--border)">
      <div style="font-size:16px;font-weight:700;margin-bottom:6px" id="af-title">Add account</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:16px" id="af-subtitle"></div>

      <div class="field" style="margin-bottom:10px">
        <label style="font-size:12px;color:var(--text2)">Display name</label>
        <input type="text" id="af-name" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);box-sizing:border-box">
      </div>
      <div class="field" style="margin-bottom:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>
          <label style="font-size:12px;color:var(--text2)">IMAP host</label>
          <input type="text" id="af-imap-host" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:12px;color:var(--text2)">IMAP port</label>
          <input type="number" id="af-imap-port" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);box-sizing:border-box">
        </div>
      </div>
      <div class="field" style="margin-bottom:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>
          <label style="font-size:12px;color:var(--text2)">SMTP host</label>
          <input type="text" id="af-smtp-host" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:12px;color:var(--text2)">SMTP port</label>
          <input type="number" id="af-smtp-port" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);box-sizing:border-box">
        </div>
      </div>
      <div class="field" style="margin-bottom:10px">
        <label style="font-size:12px;color:var(--text2)">Username / email</label>
        <input type="text" id="af-username" style="width:100%;padding:6px;margin-top:4px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);box-sizing:border-box">
      </div>
      <div class="field" style="margin-bottom:10px">
        <label style="font-size:12px;color:var(--text2)">Password</label>
        <div class="pw-wrap" style="margin-top:4px">
          <input type="password" id="af-password" placeholder="Leave blank to keep existing" style="padding:6px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm)">
          <button type="button" class="eye-btn" data-action="togglePw" data-target="af-password" aria-label="Show password" tabindex="-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
        </div>
      </div>
      <div class="field" style="margin-bottom:10px" id="af-cert-row">
        <label style="font-size:12px;color:var(--text2)">Bridge TLS cert path (Bridge accounts only)</label>
        <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
          <input type="text" id="af-cert" placeholder="${p.certBrowsePlaceholderAttr}" style="flex:1;padding:6px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);box-sizing:border-box">
          <button class="btn btn-ghost" type="button" data-action="detectCertPathAf" style="white-space:nowrap;padding:6px 10px" title="Scan home directory for cert.pem">Detect</button>
          <button class="btn btn-ghost" type="button" data-action="uploadCertAf" style="white-space:nowrap;padding:6px 10px" title="Choose a cert.pem file from your disk">📁 Browse</button>
          <input type="file" id="af-cert-file" accept=".pem,.crt" style="display:none" data-change="uploadCertChange" data-target="af-cert">
        </div>
      </div>
      <input type="hidden" id="af-id">
      <input type="hidden" id="af-provider">
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button class="btn btn-ghost" data-action="closeAccountForm">Cancel</button>
        <button class="btn btn-primary" data-action="saveAccountForm" id="af-save-btn">Save account</button>
      </div>
    </div>
  </div>
  `;
}
