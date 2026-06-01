// src/settings/tabs/status.ts
export interface StatusParams {
  safeConfigPath: string;
  runningPort: number;
}

export function buildStatusHtml(p: StatusParams): string {
  return `
  <div class="section-heading">Status</div>
  <div class="section-subheading">Server information and connection health.</div>

  <div class="card">
    <div class="card-title">Server Information</div>
    <table class="info-table">
      <tr><td>Config file</td><td><code id="info-config-path">${p.safeConfigPath}</code></td></tr>
      <tr><td>Settings UI port</td><td><code>${p.runningPort}</code> <span style="color:var(--muted);font-size:12px">(currently running)</span></td></tr>
      <tr><td>Config exists</td><td id="info-config-exists">—</td></tr>
      <tr><td>Active preset</td><td id="info-preset">—</td></tr>
      <tr><td>Disabled tools</td><td id="info-disabled">—</td></tr>
      <tr><td>Rate-limited tools</td><td id="info-rate-limited">—</td></tr>
      <tr><td>Credential storage</td><td id="info-credential-storage">—</td></tr>
    </table>
  </div>

  <div class="card">
    <div class="card-title">MCP Config Snippet</div>
    <div class="card-desc">Paste this into your MCP host's config under <code>mcpServers</code>.</div>
    <pre class="code-block" id="claude-snippet">Loading…</pre>
    <div class="copy-row">
      <button class="btn btn-ghost btn-sm" data-action="copySnippet">Copy</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Connection Check</div>
    <div class="card-desc">Checks whether SMTP and IMAP are reachable <em>and</em> that the saved credentials actually authenticate — a port that's open but failing auth (e.g. a Bridge 454) is flagged, not shown as connected.</div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-ghost" data-action="runStatusCheck" id="status-check-btn">Check Now</button>
      <div id="status-check-result" style="font-size:13px;color:var(--muted)"></div>
    </div>
    <div id="connectivity-results" style="margin-top:14px;display:none">
      <div style="display:flex;gap:20px;flex-wrap:wrap">
        <div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:4px">SMTP</div>
          <div id="smtp-check-status" style="font-weight:600">—</div>
        </div>
        <div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:4px">IMAP</div>
          <div id="imap-check-status" style="font-weight:600">—</div>
        </div>
      </div>
    </div>
  </div>

  <div class="card" id="update-card">
    <div class="card-title">Updates</div>
    <div class="card-desc">Check npm for a newer version of this package and install it.</div>
    <table class="info-table" style="margin-bottom:14px">
      <tr><td>Installed version</td><td><code id="update-current">—</code></td></tr>
      <tr><td>Latest version</td><td><code id="update-latest">—</code></td></tr>
      <tr><td>Status</td><td id="update-status" style="color:var(--muted)">Not checked</td></tr>
    </table>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-ghost" id="check-update-btn" data-action="checkForUpdates">Check for Updates</button>
      <button class="btn btn-primary" id="install-update-btn" data-action="installUpdate" style="display:none">Install Update</button>
      <span id="update-action-status" style="font-size:13px;color:var(--muted)"></span>
    </div>
    <pre id="update-output" style="display:none;margin-top:14px;background:var(--surface2);padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;white-space:pre-wrap;max-height:200px;overflow-y:auto"></pre>
  </div>

  <div class="card">
    <div class="card-title">Reset</div>
    <div class="card-desc">Delete the config file and clear all saved settings.</div>
    <div class="actions" style="margin-top:0">
      <button class="btn btn-danger" data-action="resetConfig">Reset to Defaults</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Escalation Audit Log</div>
    <div class="card-desc">Record of all permission escalation requests and their outcomes.</div>
    <div id="audit-log-wrap">
      <table class="audit-table">
        <thead>
          <tr><th>Time</th><th>Event</th><th>From</th><th>To</th><th>Via</th><th>Reason</th></tr>
        </thead>
        <tbody id="audit-log-body">
          <tr><td colspan="6" style="color:var(--muted);padding:12px 10px">Loading…</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  `;
}
