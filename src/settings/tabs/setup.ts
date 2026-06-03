// src/settings/tabs/setup.ts
export interface SetupParams {
  safeConfigPath: string;
  certBrowsePlaceholderAttr: string;
  certPlatformHint: string;
  runningPort: number;
}

export function buildSetupHtml(p: SetupParams): string {
  return `
  <div class="section-heading">Connection Settings</div>
  <div class="section-subheading">Configure your Proton Bridge SMTP and IMAP endpoints.</div>

  <div class="alert alert-info">
    <span>ℹ</span>
    <span>Settings are saved to <code id="config-path-setup">${p.safeConfigPath}</code>. Credentials are stored in the OS keychain.</span>
  </div>

  <div class="card">
    <div class="card-title">Connection Mode</div>
    <div class="card-desc">Most users run via Proton Bridge (localhost). Direct SMTP requires a paid plan and SMTP token.</div>
    <div class="mode-btns">
      <button class="mode-btn active" id="mode-bridge" data-action="setMode" data-mode="bridge">Proton Bridge (localhost)</button>
      <button class="mode-btn" id="mode-direct" data-action="setMode" data-mode="direct">Direct smtp.protonmail.ch</button>
    </div>
  </div>

  <form id="setup-form" data-submit="noop">
    <div class="card">
      <fieldset>
        <legend>Account</legend>
        <div class="row-2">
          <div class="field">
            <label for="username">Proton Mail username / email</label>
            <input type="email" id="username" placeholder="user@proton.me" autocomplete="username">
            <div class="hint">Use your full Proton address (e.g. user@proton.me or user@protonmail.com). The @proton.me and @protonmail.com forms are not interchangeable — use the exact primary address shown in your Proton account.</div>
            <div class="hint" style="margin-top:4px">
              &#9432; Bridge runs in <strong>combined mode</strong> — all your Proton addresses share one inbox and one set of credentials.
              Split mode (separate credentials per address) is not currently supported.
            </div>
          </div>
          <div class="field">
            <label for="password">Bridge password <span style="color:var(--muted);font-weight:400">(from Bridge app)</span></label>
            <div class="pw-wrap">
              <input type="password" id="password" placeholder="Enter new password" autocomplete="current-password">
              <button type="button" class="eye-btn" data-action="togglePw" data-target="password" aria-label="Show password" tabindex="-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
            </div>
            <div class="hint">Leave blank to keep the saved value.</div>
          </div>
        </div>
      </fieldset>
    </div>

    <div class="card">
      <fieldset>
        <legend>SMTP</legend>
        <div class="row-3">
          <div class="field">
            <label for="smtp-host">Host</label>
            <input type="text" id="smtp-host" placeholder="localhost" data-input="updateSmtpTokenVisibility">
          </div>
          <div class="field">
            <label for="smtp-port" style="display:flex;justify-content:space-between;align-items:center">SMTP Port <a href="#" style="font-size:0.75em;font-weight:normal;color:var(--primary)" data-action="resetPort" data-field="smtp-port" data-value="1025">Reset to 1025</a></label>
            <input type="number" id="smtp-port" min="1" max="65535" placeholder="1025">
          </div>
        </div>
        <div class="field">
          <label for="tls-mode">TLS Mode</label>
          <select id="tls-mode" style="width:100%;padding:10px 14px;background:var(--surface2);border:1.5px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:14px;outline:none">
            <option value="starttls">STARTTLS (default — Proton Bridge)</option>
            <option value="ssl">SSL / Implicit TLS (port 993 / 465)</option>
          </select>
          <div class="hint">Use STARTTLS with Proton Bridge. Switch to SSL only if you changed Bridge's TLS settings.</div>
        </div>
        <div id="smtp-token-row">
          <div class="field" id="setup-smtp-token-field" style="display:none">
            <label for="smtp-token">SMTP token <span style="color:var(--muted);font-weight:400">(required for direct)</span></label>
            <div class="pw-wrap">
              <input type="password" id="smtp-token" placeholder="Generated in Bridge Settings → IMAP/SMTP">
              <button type="button" class="eye-btn" data-action="togglePw" data-target="smtp-token" aria-label="Show token" tabindex="-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
            </div>
            <div class="hint">Leave blank to keep the saved value.</div>
          </div>
        </div>
      </fieldset>
    </div>

    <div class="card">
      <fieldset>
        <legend>IMAP</legend>
        <div class="row-3">
          <div class="field">
            <label for="imap-host">Host</label>
            <input type="text" id="imap-host" placeholder="localhost">
          </div>
          <div class="field">
            <label for="imap-port" style="display:flex;justify-content:space-between;align-items:center">IMAP Port <a href="#" style="font-size:0.75em;font-weight:normal;color:var(--primary)" data-action="resetPort" data-field="imap-port" data-value="1143">Reset to 1143</a></label>
            <input type="number" id="imap-port" min="1" max="65535" placeholder="1143">
          </div>
          <div class="field"></div>
        </div>
      </fieldset>
    </div>

    <div class="card">
      <fieldset>
        <legend>Bridge TLS Certificate (optional but recommended)</legend>
        <div class="field">
          <label for="bridge-cert">Path to the exported cert.pem file</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="bridge-cert" placeholder="${p.certBrowsePlaceholderAttr}" style="flex:1">
            <button class="btn btn-ghost" type="button" data-action="detectCertPath" style="white-space:nowrap" title="Scan home directory for cert.pem">Detect</button>
            <button class="btn btn-ghost" type="button" data-action="uploadCertBridge" style="white-space:nowrap" title="Choose a cert.pem file from your disk">📁 Browse</button>
            <input type="file" id="bridge-cert-file" accept=".pem,.crt" style="display:none" data-change="uploadCertChange" data-target="bridge-cert">
          </div>
          <div class="hint">
            Export from Bridge → Help → Export TLS Certificate, then click Browse to pick the file (or Detect to auto-scan your home directory).<br>
            ${p.certPlatformHint}
          </div>
        </div>
        <div class="field" style="margin-top:12px">
          <label for="bridge-path">Proton Bridge executable path <span style="color:var(--muted);font-weight:400">(optional — leave blank to auto-detect)</span></label>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="bridge-path" placeholder="Auto-detect" style="flex:1">
            <button class="btn btn-ghost" type="button" id="search-bridge-btn" data-action="searchBridgePath" style="white-space:nowrap">Search</button>
          </div>
          <div class="hint" id="bridge-path-hint">Used when auto-start is enabled. Click Search to detect automatically, or enter the path manually.</div>
        </div>
        <div class="field" style="margin-top:6px">
          <label class="toggle-wrap" style="width:fit-content">
            <span class="toggle"><input type="checkbox" id="debug-mode"><span class="slider"></span></span>
            <span>Enable debug logging</span>
          </label>
        </div>
        <div class="field" style="margin-top:6px">
          <label class="toggle-wrap" style="width:fit-content">
            <span class="toggle"><input type="checkbox" id="auto-start-bridge"><span class="slider"></span></span>
            <span>Auto-start Proton Bridge on MCP server launch</span>
          </label>
          <div class="hint" style="margin-top:4px">Automatically launches Bridge if it is not reachable when the MCP server starts.</div>
        </div>
        <div class="field" style="margin-top:6px">
          <label class="toggle-wrap" style="width:fit-content">
            <span class="toggle"><input type="checkbox" id="allow-insecure-bridge"><span class="slider"></span></span>
            <span>Allow insecure Bridge connection (skip TLS validation)</span>
          </label>
          <div class="hint" style="margin-top:4px">
            Only enable if you cannot set a Bridge certificate path above. With this off (the default),
            the server refuses to connect to a localhost Bridge without a pinned cert — matching Proton
            Bridge 3.21+ hardening.
          </div>
        </div>
        <div class="field" style="margin-top:6px">
          <label class="toggle-wrap" style="width:fit-content">
            <span class="toggle"><input type="checkbox" id="require-destructive-confirm" checked><span class="slider"></span></span>
            <span>Require <code>{ confirmed: true }</code> on destructive tool calls</span>
          </label>
          <div class="hint" style="margin-top:4px">
            When on (the default), every delete / move-to-trash / move-to-spam call must carry an
            explicit <code>confirmed: true</code> argument. The agent has to surface the destructive
            intent to you through the tool-call UI before it executes — the cornerstone of keeping
            the workflow user-initiated per Proton ToS §2.10.
          </div>
        </div>
        <div class="field" style="margin-top:6px">
          <label class="toggle-wrap" style="width:fit-content">
            <span class="toggle"><input type="checkbox" id="desktop-notifications" checked><span class="slider"></span></span>
            <span>Desktop notifications for agent permission requests</span>
          </label>
          <div class="hint" style="margin-top:4px">
            Show a native OS notification when an agent requests elevated permissions. On by default.
            Disable if you prefer to check the Agents tab manually.
          </div>
        </div>
        <div class="field" style="margin-top:6px">
          <label class="toggle-wrap" style="width:fit-content">
            <span class="toggle"><input type="checkbox" id="auto-open-approval" checked><span class="slider"></span></span>
            <span>Auto-open the approval window when an agent connects</span>
          </label>
          <div class="hint" style="margin-top:4px">
            When a new remote agent registers, automatically open this Settings UI to the Agents tab so you can
            approve or deny the connection right away. On by default; skipped on headless hosts. Turn off on a
            remote/headless deployment.
          </div>
        </div>
        <div class="field" style="margin-top:14px">
          <label for="settings-port">Settings UI port</label>
          <input type="number" id="settings-port" min="1" max="65535" placeholder="8766" style="width:120px"
            data-input="checkPortMismatch">
          <div class="hint">Port the settings web UI listens on. Takes effect on the next launch. Default: 8766.</div>
          <div id="port-mismatch-warn" style="display:none;margin-top:4px;font-size:12px;color:var(--warn,#f59e0b)">
            ⚠ Currently running on port ${p.runningPort}. Save and restart settings for the new port to take effect.
          </div>
        </div>
      </fieldset>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">Optional Integrations</div>
      <div class="card-desc">Configure SimpleLogin alias management and Proton Pass credential access. Leave blank to disable.</div>
      <fieldset style="border:none;padding:0;margin:0">
        <legend style="font-size:13px;font-weight:600;color:var(--muted);margin-bottom:8px">SimpleLogin</legend>
        <div class="field">
          <label for="sl-api-key">API Key</label>
          <input type="password" id="sl-api-key" placeholder="sl.*****" autocomplete="off">
          <div class="hint">Generate in SimpleLogin → Settings → API Keys. Required for alias_* tools.</div>
        </div>
        <div class="field" style="margin-top:8px">
          <label for="sl-base-url">Base URL <span style="color:var(--muted);font-weight:400">(optional — leave blank for app.simplelogin.io)</span></label>
          <input type="text" id="sl-base-url" placeholder="https://app.simplelogin.io">
        </div>
      </fieldset>
      <fieldset style="border:none;padding:0;margin:16px 0 0">
        <legend style="font-size:13px;font-weight:600;color:var(--muted);margin-bottom:8px">Proton Pass</legend>
        <div class="field">
          <label for="pass-access-token">Personal Access Token</label>
          <input type="password" id="pass-access-token" placeholder="••••••••" autocomplete="off">
          <div class="hint">Generate in Proton Pass web app → Settings → Developer → Personal Access Tokens. Required for pass_* tools.</div>
        </div>
        <div class="field" style="margin-top:8px">
          <label for="pass-cli-path">pass-cli path <span style="color:var(--muted);font-weight:400">(optional — leave blank to use PATH)</span></label>
          <input type="text" id="pass-cli-path" placeholder="/usr/local/bin/pass-cli">
          <div class="hint">Only set if pass-cli is not on your PATH. <a href="https://github.com/protonpass/pass-cli" target="_blank" rel="noopener" style="color:var(--primary)">Install pass-cli ↗</a></div>
        </div>
      </fieldset>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">Connect an app</div>
      <div class="card-desc">Add mailpouch to an app like Claude Code or Claude Desktop. Pick how it should connect, then click a button to set it up for you.</div>
      <div id="cc-daemon-note" style="display:none;margin:0 0 10px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;font-size:13px;color:var(--muted)">A shared mailpouch is running, so apps connect to it. The "just this computer" option is off because it would conflict with the shared one.</div>
      <fieldset style="border:none;padding:0;margin:0">
        <label id="cc-stdio-label" style="display:block;margin-bottom:8px">
          <input type="radio" name="cc-transport" value="stdio" id="cc-radio-stdio" checked data-change="setClientTransport">
          <strong>Just this computer</strong> <span style="color:var(--muted)">(recommended)</span><br>
          <span style="color:var(--muted);font-size:13px">The app starts mailpouch on its own when it needs it. Simplest — nothing else to run.</span>
        </label>
        <label style="display:block">
          <input type="radio" name="cc-transport" value="http" id="cc-radio-http" data-change="setClientTransport">
          <strong>Share one connection</strong><br>
          <span style="color:var(--muted);font-size:13px">Connect to a mailpouch that's already running, so several apps or devices can share it. You'll approve the app the first time it connects. (Requires remote access turned on.)</span>
        </label>
      </fieldset>
      <pre id="cc-snippet" style="margin-top:12px;padding:10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;font-size:12px;overflow:auto"></pre>
      <div class="actions" style="margin-top:8px">
        <button class="btn btn-primary" data-action="writeClaudeCode">Set up Claude Code</button>
        <button class="btn btn-ghost"   data-action="writeClaudeDesktopFromSetup">Set up Claude Desktop</button>
        <button class="btn btn-ghost"   data-action="copyClientSnippet">Copy setup text</button>
        <span id="cc-result" style="align-self:center;font-size:13px;color:var(--muted)"></span>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-primary" data-action="saveSetup" id="save-btn">Save Configuration</button>
      <button class="btn btn-ghost"   data-action="testConnections" id="test-btn">Test Connections</button>
      <span id="test-result" style="align-self:center;font-size:13px;color:var(--muted)"></span>
    </div>
  </form>
  `;
}
