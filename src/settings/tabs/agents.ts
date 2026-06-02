// src/settings/tabs/agents.ts
export function buildAgentsHtml(): string {
  return `
  <div class="section-heading">Connected agents</div>
  <div class="section-subheading">
    Every agent authenticates as its own client and is gated independently —
    including local (stdio) callers. Interactive agents register via OAuth and
    you Approve/Deny them here. Headless agents (cron, CI) use a pre-approved
    <strong>service account</strong> — create one below.
  </div>

  <div class="card" style="margin-top:10px">
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
      <button class="btn btn-ghost" id="ag-filter-pending"  data-action="switchAgentFilter" data-filter="pending"  style="font-weight:600">🔴 Pending <span id="ag-count-pending">0</span></button>
      <button class="btn btn-ghost" id="ag-filter-active"   data-action="switchAgentFilter" data-filter="active">🟢 Active <span id="ag-count-active">0</span></button>
      <button class="btn btn-ghost" id="ag-filter-revoked"  data-action="switchAgentFilter" data-filter="revoked">⚪ Revoked <span id="ag-count-revoked">0</span></button>
      <button class="btn btn-ghost" id="ag-filter-audit"    data-action="switchAgentFilter" data-filter="audit">📋 Audit log</button>
      <span style="flex:1"></span>
      <button class="btn btn-primary" data-action="openServiceAccountModal">+ Service account</button>
    </div>
    <div id="agents-list" style="display:flex;flex-direction:column;gap:10px">
      <div class="hint" style="text-align:center;padding:30px">Loading…</div>
    </div>
    <div id="agents-audit" style="display:none">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr>
          <th style="text-align:left;padding:6px;border-bottom:1px solid #333">Time (ET)</th>
          <th style="text-align:left;padding:6px;border-bottom:1px solid #333">Agent</th>
          <th style="text-align:left;padding:6px;border-bottom:1px solid #333">Tool</th>
          <th style="text-align:left;padding:6px;border-bottom:1px solid #333">Outcome</th>
          <th style="text-align:right;padding:6px;border-bottom:1px solid #333">ms</th>
        </tr></thead>
        <tbody id="agents-audit-body"></tbody>
      </table>
    </div>
  </div>
  `;
}
