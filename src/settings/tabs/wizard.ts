// src/settings/tabs/wizard.ts
import { ALL_TOOLS } from "../../config/schema.js";

export interface WizardParams {
  certBrowsePlaceholderAttr: string;
  certPlatformHint: string;
}

export function buildWizardHtml(p: WizardParams): string {
  return `<div class="wiz-shell">

    <!-- Progress bar -->
    <div class="wiz-progress" id="wiz-progress" role="progressbar" aria-label="Setup progress">
      <div class="wiz-progress-fill" id="wiz-progress-fill" style="width:0%"></div>
      <div class="wiz-step-node active" id="wnode-0">
        <div class="wiz-step-circle">1</div>
        <div class="wiz-step-label">Welcome</div>
      </div>
      <div class="wiz-step-node" id="wnode-1">
        <div class="wiz-step-circle">2</div>
        <div class="wiz-step-label">Bridge</div>
      </div>
      <div class="wiz-step-node" id="wnode-2">
        <div class="wiz-step-circle">3</div>
        <div class="wiz-step-label">Account</div>
      </div>
      <div class="wiz-step-node" id="wnode-3">
        <div class="wiz-step-circle">4</div>
        <div class="wiz-step-label">Permissions</div>
      </div>
      <div class="wiz-step-node" id="wnode-4">
        <div class="wiz-step-circle">5</div>
        <div class="wiz-step-label">Review</div>
      </div>
      <div class="wiz-step-node" id="wnode-5">
        <div class="wiz-step-circle">6</div>
        <div class="wiz-step-label">Done</div>
      </div>
    </div>

    <div class="wiz-card">

      <!-- ══ Step 1: Welcome ══ -->
      <div class="wiz-panel active" id="wpanel-0" role="tabpanel" aria-label="Welcome">
        <div class="wiz-title">Welcome to mailpouch</div>
        <div class="wiz-subtitle">
          Give your Agent secure, permission-controlled access to your Proton Mail inbox
          via Proton Bridge. Setup takes about 3 minutes.
        </div>

        <div class="wiz-feature-grid">
          <div class="wiz-feature-card">
            <div class="wiz-feature-icon">📖</div>
            <div>
              <div class="wiz-feature-title">Read &amp; Search</div>
              <div class="wiz-feature-desc">Search emails, get summaries, analyse patterns</div>
            </div>
          </div>
          <div class="wiz-feature-card">
            <div class="wiz-feature-icon">✉</div>
            <div>
              <div class="wiz-feature-title">Send &amp; Reply</div>
              <div class="wiz-feature-desc">Draft, send, and reply to emails on your behalf</div>
            </div>
          </div>
          <div class="wiz-feature-card">
            <div class="wiz-feature-icon">📁</div>
            <div>
              <div class="wiz-feature-title">Organise</div>
              <div class="wiz-feature-desc">Move, label, archive, and manage folders</div>
            </div>
          </div>
          <div class="wiz-feature-card">
            <div class="wiz-feature-icon">🔒</div>
            <div>
              <div class="wiz-feature-title">Permission Controls</div>
              <div class="wiz-feature-desc">You choose exactly what Claude is allowed to do</div>
            </div>
          </div>
        </div>

        <div class="wiz-prereqs">
          <div class="wiz-prereqs-title">Before you begin</div>
          <div class="wiz-prereq">
            <div class="wiz-prereq-icon">🔒</div>
            <div>
              <div class="wiz-prereq-name">Proton Bridge</div>
              <div class="wiz-prereq-desc">Must be installed, running, and signed in.
                <a href="https://proton.me/mail/bridge" target="_blank" rel="noopener" style="color:var(--primary)">Download →</a>
              </div>
            </div>
          </div>
          <div class="wiz-prereq">
            <div class="wiz-prereq-icon">⬡</div>
            <div>
              <div class="wiz-prereq-name">Node.js 20+</div>
              <div class="wiz-prereq-desc">Check with <code style="background:var(--surface3);padding:1px 5px;border-radius:3px;font-size:11px">node --version</code></div>
            </div>
          </div>
          <div class="wiz-prereq">
            <div class="wiz-prereq-icon">🤖</div>
            <div>
              <div class="wiz-prereq-name">Claude Desktop</div>
              <div class="wiz-prereq-desc">Or another MCP-compatible host.
                <a href="https://claude.ai/download" target="_blank" rel="noopener" style="color:var(--primary)">Download →</a>
              </div>
            </div>
          </div>
        </div>

        <div class="wiz-actions">
          <button class="wiz-skip" id="wiz-skip-btn" data-action="openSettingsView" aria-label="Skip wizard and go to settings">Skip wizard</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" data-action="wizGo" data-step="1" aria-label="Start setup">Get Started →</button>
        </div>
      </div>

      <!-- ══ Step 2: Bridge ══ -->
      <div class="wiz-panel" id="wpanel-1" role="tabpanel" aria-label="Bridge connection">
        <div class="wiz-title">Proton Bridge</div>
        <div class="wiz-subtitle">
          Bridge creates a local SMTP port (1025) and IMAP port (1143) so this server
          can send and read your encrypted emails — entirely on your machine.<br><br>
          Make sure Bridge is <strong style="color:var(--text)">open and signed in</strong>, then click Test.
        </div>

        <div class="conn-test-grid" id="conn-test-grid">
          <div class="conn-row" id="smtp-row">
            <div class="conn-row-icon">📤</div>
            <div class="conn-row-label">
              <strong>SMTP</strong>
              <span id="smtp-host-label">localhost:1025</span>
            </div>
            <div class="conn-row-status idle" id="smtp-conn-status">—</div>
          </div>
          <div class="conn-row" id="imap-row">
            <div class="conn-row-icon">📥</div>
            <div class="conn-row-label">
              <strong>IMAP</strong>
              <span id="imap-host-label">localhost:1143</span>
            </div>
            <div class="conn-row-status idle" id="imap-conn-status">—</div>
          </div>
        </div>

        <div class="bridge-hint" id="bridge-hint">
          One or both ports are not reachable. Make sure Proton Bridge is running and signed in.
          <a href="https://proton.me/mail/bridge" target="_blank" rel="noopener">Download Bridge →</a>
        </div>

        <div style="margin-bottom:20px">
          <div class="field">
            <label>Path to the exported cert.pem file <span style="color:var(--muted);font-weight:400">(optional)</span></label>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="text" id="wiz-cert-path" placeholder="${p.certBrowsePlaceholderAttr}"
                aria-label="Path to the exported cert.pem file" style="flex:1">
              <button class="btn btn-ghost" type="button" data-action="wizDetectCert" style="white-space:nowrap" title="Scan home directory for cert.pem">Detect</button>
              <button class="btn btn-ghost" type="button" data-action="wizUploadCertClick" style="white-space:nowrap" title="Choose a cert.pem file from your disk">📁 Browse</button>
              <input type="file" id="wiz-cert-file" accept=".pem,.crt" style="display:none" data-change="wizUploadCertChange">
            </div>
            <div class="hint">
              Export from Bridge → Help → Export TLS Certificate, then enter the path to <code style="background:var(--surface3);padding:1px 5px;border-radius:3px;font-size:11px">cert.pem</code>.<br>
              ${p.certPlatformHint}
            </div>
          </div>
        </div>

        <div style="margin-bottom:20px">
          <div class="field">
            <label>Proton Bridge executable path <span style="color:var(--muted);font-weight:400">(optional — leave blank to auto-detect)</span></label>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="text" id="wiz-bridge-path" placeholder="Auto-detect" style="flex:1"
                aria-label="Path to the Proton Bridge executable">
              <button class="btn btn-ghost" type="button" id="wiz-search-bridge-btn" data-action="wizSearchBridgePath" style="white-space:nowrap">Search</button>
            </div>
            <div class="hint" id="wiz-bridge-path-hint">Click Search to auto-detect, or enter the path manually if not found.</div>
          </div>
        </div>

        <div class="field" style="margin-bottom:20px">
          <label class="toggle-wrap" style="width:fit-content">
            <span class="toggle"><input type="checkbox" id="wiz-auto-start-bridge"><span class="slider"></span></span>
            <span>Auto-start Proton Bridge on MCP server launch</span>
          </label>
          <div class="hint" style="margin-top:6px">
            When enabled, the MCP server will automatically launch Proton Bridge if it is not already running.
          </div>
        </div>

        <div class="wiz-actions">
          <button class="btn btn-ghost" data-action="wizGo" data-step="0" aria-label="Back to Welcome">← Back</button>
          <div class="spacer"></div>
          <button class="btn btn-ghost" id="wiz-test-bridge-btn" data-action="wizTestBridge" aria-label="Test bridge connection">
            Test Connection
          </button>
          <button class="btn btn-primary" id="wiz-bridge-next" data-action="wizGo" data-step="2" aria-label="Continue to Account">
            Continue →
          </button>
        </div>
      </div>

      <!-- ══ Step 3: Account ══ -->
      <div class="wiz-panel" id="wpanel-2" role="tabpanel" aria-label="Account credentials">
        <div class="wiz-title">Connect Your Account</div>
        <div class="wiz-subtitle">
          Enter your Proton Mail address and your <strong style="color:var(--text)">Bridge password</strong>
          — this is shown inside the Proton Bridge app, not your Proton Mail login password.
        </div>

        <div class="field">
          <label for="wiz-username">Proton Mail email address</label>
          <input type="email" id="wiz-username" placeholder="you@proton.me"
            autocomplete="username" aria-required="true"
            data-input="wizClearErrorUsername">
          <div class="hint">Use your full Proton address (e.g. user@proton.me or user@protonmail.com). The @proton.me and @protonmail.com forms are not interchangeable — use the exact primary address shown in your Proton account.</div>
          <div class="hint" style="margin-top:4px">
            &#9432; Bridge runs in <strong>combined mode</strong> — all your Proton addresses share one inbox and one set of credentials.
            Split mode (separate credentials per address) is not currently supported.
          </div>
          <div class="err-msg" id="err-wiz-username">Please enter your email address.</div>
        </div>

        <div class="field">
          <label for="wiz-password">
            Bridge password
            <span style="color:var(--muted);font-weight:400">(from the Bridge app)</span>
          </label>
          <div class="pw-wrap">
            <input type="password" id="wiz-password" placeholder="Bridge password"
              autocomplete="current-password" aria-required="true"
              data-input="wizClearErrorPassword">
            <button type="button" class="eye-btn" data-action="togglePw" data-target="wiz-password" aria-label="Show password" tabindex="-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
          </div>
          <div class="hint">Bridge app → Settings → IMAP/SMTP → Password</div>
          <div class="err-msg" id="err-wiz-password">Please enter your Bridge password.</div>
        </div>

        <div class="field" id="smtp-token-field" style="display:none">
          <label for="wiz-smtp-token">SMTP token <span style="color:var(--muted);font-weight:400">(required for direct smtp.protonmail.ch)</span></label>
          <div class="pw-wrap">
            <input type="password" id="wiz-smtp-token" placeholder="SMTP token from Bridge settings"
              autocomplete="off" aria-label="SMTP token">
            <button type="button" class="eye-btn" data-action="togglePw" data-target="wiz-smtp-token" aria-label="Show token" tabindex="-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
          </div>
          <div class="hint">Required for paid plans using direct smtp.protonmail.ch. Leave blank for Bridge.</div>
        </div>

        <div class="field" style="margin-top:8px">
          <label class="toggle-wrap" style="width:fit-content">
            <span class="toggle">
              <input type="checkbox" id="wiz-debug">
              <span class="slider"></span>
            </span>
            <span>Enable debug logging</span>
          </label>
        </div>

        <div class="wiz-actions">
          <button class="btn btn-ghost" data-action="wizGo" data-step="1" aria-label="Back to Bridge">← Back</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" data-action="wizSaveCreds" id="wiz-save-creds-btn"
            aria-label="Save credentials and continue">
            Save &amp; Continue →
          </button>
        </div>
      </div>

      <!-- ══ Step 4: Permissions ══ -->
      <div class="wiz-panel" id="wpanel-3" role="tabpanel" aria-label="Permissions">
        <div class="wiz-title">Set AI Permissions</div>
        <div class="wiz-subtitle">
          Choose how much Claude is allowed to do. You can fine-tune individual tools
          from the Permissions tab after setup.
        </div>

        <div class="perm-preset-grid" role="radiogroup" aria-label="Permission preset">
          <label class="perm-preset-opt">
            <input type="radio" name="wiz-preset" value="read_only" checked aria-label="Read-Only preset">
            <div class="perm-preset-badge" style="background:#1cc47e22">📖</div>
            <div>
              <div class="perm-preset-name">
                Read-Only
                <span class="perm-preset-tag tag-safe">Recommended</span>
              </div>
              <div class="perm-preset-desc">Reading, searching, analytics, and connection status only. Cannot send, move, delete, or modify anything. Safest starting point.</div>
            </div>
          </label>

          <label class="perm-preset-opt">
            <input type="radio" name="wiz-preset" value="supervised" aria-label="Supervised preset">
            <div class="perm-preset-badge" style="background:#f5a62322">👁</div>
            <div>
              <div class="perm-preset-name">
                Supervised
                <span class="perm-preset-tag tag-mod">Rate limited</span>
              </div>
              <div class="perm-preset-desc">All tools enabled. High limits on sending and bulk ops; stricter caps on deletion and destructive actions. Reading unlimited.</div>
            </div>
          </label>

          <label class="perm-preset-opt">
            <input type="radio" name="wiz-preset" value="send_only" aria-label="Send-Only preset">
            <div class="perm-preset-badge" style="background:#6d4aff22">📤</div>
            <div>
              <div class="perm-preset-name">Send-Only</div>
              <div class="perm-preset-desc">Reading unlimited. Send operations rate-limited. Actions, deletion, folder writes, and bulk ops disabled.</div>
            </div>
          </label>

          <label class="perm-preset-opt">
            <input type="radio" name="wiz-preset" value="full" aria-label="Full Access preset">
            <div class="perm-preset-badge" style="background:#e8464622">⚡</div>
            <div>
              <div class="perm-preset-name">
                Full Access
                <span class="perm-preset-tag tag-high">No limits</span>
              </div>
              <div class="perm-preset-desc">All ${ALL_TOOLS.length} tools, no rate limits. Grant only when you fully trust the agent to act autonomously.</div>
            </div>
          </label>
        </div>

        <div class="wiz-actions">
          <button class="btn btn-ghost" data-action="wizGo" data-step="2" aria-label="Back to Account">← Back</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" data-action="wizSavePreset" id="wiz-apply-preset-btn"
            aria-label="Apply preset and continue to review">
            Apply &amp; Continue →
          </button>
        </div>
      </div>

      <!-- ══ Step 5: Review & Save ══ -->
      <div class="wiz-panel" id="wpanel-4" role="tabpanel" aria-label="Review and save">
        <div class="wiz-title">Review &amp; Save</div>
        <div class="wiz-subtitle">
          Confirm your settings before saving. You can edit any value by going back.
        </div>

        <div class="review-grid">
          <div class="review-row">
            <div class="review-icon">🌉</div>
            <div>
              <div class="review-label">Connection</div>
              <div class="review-value" id="review-connection">—</div>
            </div>
          </div>
          <div class="review-row">
            <div class="review-icon">👤</div>
            <div>
              <div class="review-label">Account</div>
              <div class="review-value" id="review-account">—</div>
            </div>
          </div>
          <div class="review-row">
            <div class="review-icon">🔒</div>
            <div>
              <div class="review-label">Permission Preset</div>
              <div class="review-value" id="review-preset">—</div>
            </div>
          </div>
          <div class="review-row">
            <div class="review-icon">🛡</div>
            <div>
              <div class="review-label">Credential Storage</div>
              <div class="review-value" id="review-storage">Config file (0600)</div>
            </div>
          </div>
        </div>

        <div class="wiz-actions">
          <button class="btn btn-ghost" data-action="wizGo" data-step="3" aria-label="Back to Permissions">← Back</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" data-action="wizFinalSave" id="wiz-final-save-btn"
            aria-label="Save configuration">
            Save Configuration
          </button>
        </div>
      </div>

      <!-- ══ Step 6: Done ══ -->
      <div class="wiz-panel" id="wpanel-5" role="tabpanel" aria-label="Setup complete">
        <div class="done-hero">
          <div class="done-check">✓</div>
          <h2>You're all set!</h2>
          <p>mailpouch is configured. The last step is registering it with your MCP host.</p>
        </div>

        <div id="done-write-section">
          <div class="done-step-row">
            <div class="done-step-num">1</div>
            <div class="done-step-body">
              <div class="done-step-title">Connect your app</div>
              <div class="done-step-desc">Choose how the app should connect, then set it up below (or copy the text into your app's settings).</div>
              <div style="margin:8px 0">
                <label style="display:block;margin-bottom:6px"><input type="radio" name="wiz-cc-transport" value="stdio" checked data-change="wizSetTransport"> <strong>Just this computer</strong> <span style="color:var(--muted)">(recommended — simplest)</span></label>
                <label style="display:block"><input type="radio" name="wiz-cc-transport" value="http" data-change="wizSetTransport"> <strong>Share one connection</strong> <span style="color:var(--muted)">(for several apps or devices; needs remote access on)</span></label>
              </div>
              <pre class="code-block" id="done-snippet" style="margin-top:10px;font-size:12px">Loading…</pre>
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
                <button class="btn btn-primary btn-sm" data-action="wizWriteClaudeCode" aria-label="Set up Claude Code">Set up Claude Code</button>
                <button class="btn btn-ghost btn-sm" data-action="wizCopySnippet" aria-label="Copy setup text">Copy</button>
              </div>
              <div id="wiz-cc-result" style="display:none"></div>
              <div id="copy-result" style="display:none"></div>
            </div>
          </div>

          <div class="done-step-row" id="claude-write-row" style="display:none">
            <div class="done-step-num">2</div>
            <div class="done-step-body">
              <div class="done-step-title">Claude Desktop detected</div>
              <div class="done-step-desc">Claude Desktop was found on this machine. You can write the config directly — won't affect any other MCP servers.</div>
              <button class="btn btn-primary" id="btn-write-claude" data-action="wizWriteClaudeDesktop" aria-label="Write Claude Desktop config">
                Write to Claude Desktop →
              </button>
              <div id="write-result" style="display:none"></div>
            </div>
          </div>

          <div class="done-step-row" id="restart-row" style="display:none">
            <div class="done-step-num" id="restart-step-num">3</div>
            <div class="done-step-body">
              <div class="done-step-title">Restart Claude Desktop</div>
              <div class="done-step-desc">Claude Desktop loads MCP servers at startup. A restart picks up the new config.</div>
              <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
                <button class="btn btn-primary" id="btn-restart-claude" data-action="wizRestartClaude" aria-label="Restart Claude Desktop">
                  Restart Claude Desktop
                </button>
                <button class="btn btn-ghost" data-action="wizSkipRestart" aria-label="I will restart manually">
                  I'll restart manually
                </button>
              </div>
              <div id="restart-result" style="display:none"></div>
            </div>
          </div>
        </div>

        <div id="done-complete" style="display:none" class="done-complete-msg">
          <div class="done-check-small">✓</div>
          <strong>Done!</strong> Claude Desktop is restarting. Open it in a few seconds and Proton Mail tools will be available.
        </div>

        <div class="wiz-actions" style="margin-top:24px">
          <button class="btn btn-ghost" data-action="wizGo" data-step="4" aria-label="Back to Review">← Back</button>
          <div class="spacer"></div>
          <button class="btn btn-ghost" data-action="openSettingsView" aria-label="Open full settings">Open Settings</button>
        </div>
      </div>

    </div><!-- /.wiz-card -->
  </div><!-- /.wiz-shell -->`;
}
