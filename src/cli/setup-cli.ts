/**
 * `mailpouch setup …` — write Bridge credentials non-interactively. This is the
 * agent/CI path; the browser/TUI wizard (`mailpouch-settings`) remains the
 * default for humans.
 *
 *   mailpouch setup --username you@proton.me --password-stdin
 *   mailpouch setup --username you@proton.me --password-file ./pw.txt
 *   mailpouch setup --username you@proton.me --password 'hunter2' \
 *                   [--imap-host 127.0.0.1 --imap-port 1143 --smtp-host 127.0.0.1 --smtp-port 1025] \
 *                   [--bridge-cert /path/cert.pem | --insecure] [--tls starttls|ssl]
 *
 * Writes through the SAME account registry the settings UI uses
 * (`writeRegistry`), so the password lands on the authoritative per-account
 * keychain key (`bridge-password:<id>`) and the active account's connection
 * fields are mirrored to the legacy top-level block. Updates the ACTIVE account
 * (synthesizing a "primary" Bridge account on a fresh install). Runs offline;
 * no Bridge connection is attempted.
 */

import { readFileSync } from "fs";
import {
  readRegistry as readRegistryDefault,
  writeRegistry as writeRegistryDefault,
} from "../accounts/registry.js";
import { loadConfig as loadConfigDefault } from "../config/loader.js";
import type { AccountRegistry } from "../accounts/types.js";
import type { ServerConfig } from "../config/schema.js";

export interface SetupCliDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Read the Bridge password from stdin (for --password-stdin). Injectable for tests. */
  readStdin?: () => Promise<string>;
  readRegistry?: () => AccountRegistry;
  writeRegistry?: (reg: AccountRegistry) => Promise<void>;
  /** Read back the storage backend for the success message. */
  loadConfig?: () => ServerConfig | null;
}

const USAGE = `Usage:
  mailpouch setup --username <addr> (--password-stdin | --password-file <path> | --password <pw>)
                  [--imap-host <h>] [--imap-port <n>] [--smtp-host <h>] [--smtp-port <n>]
                  [--bridge-cert <path> | --insecure] [--tls starttls|ssl]

  Use the Proton BRIDGE password (Bridge app -> Settings -> IMAP/SMTP -> Password),
  NOT your Proton login password. --password-stdin keeps the secret out of the process list.
  For a value that begins with '--', use the --flag=value form.`;

const VALUE_FLAGS = new Set([
  "username", "password", "password-file",
  "imap-host", "imap-port", "smtp-host", "smtp-port",
  "bridge-cert", "tls",
]);
const SWITCH_FLAGS = new Set(["password-stdin", "insecure"]);

/** Parse `--flag value` / `--flag=value` pairs and bare `--flag` switches. */
function parseFlags(args: string[]): {
  flags: Record<string, string>;
  switches: Set<string>;
  unknown: string[];
  missing: string[];
} {
  const flags: Record<string, string> = {};
  const switches = new Set<string>();
  const unknown: string[] = [];
  const missing: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { unknown.push(a); continue; }
    const eq = a.indexOf("=");
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (SWITCH_FLAGS.has(key)) {
      switches.add(key);
    } else if (VALUE_FLAGS.has(key)) {
      if (eq >= 0) {
        flags[key] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        // Don't swallow the following flag as this one's value — `--password
        // --insecure` must error, not set password to "--insecure". Use the
        // `--flag=value` form for a value that legitimately starts with '--'.
        if (next === undefined || next.startsWith("--")) {
          missing.push(key);
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      unknown.push(a);
    }
  }
  return { flags, switches, unknown, missing };
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parsePort(raw: string, label: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`--${label} must be a decimal port (1-65535), got '${raw}'.`);
  }
  const n = Number(trimmed);
  if (n < 1 || n > 65535) {
    throw new Error(`--${label} must be a port in 1-65535, got '${raw}'.`);
  }
  return n;
}

export async function runSetupCli(argv: string[], deps: SetupCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(l + "\n"));
  const err = deps.err ?? ((l: string) => process.stderr.write(l + "\n"));
  const readRegistry = deps.readRegistry ?? readRegistryDefault;
  const writeRegistry = deps.writeRegistry ?? writeRegistryDefault;
  const loadConfig = deps.loadConfig ?? loadConfigDefault;
  const readStdin = deps.readStdin ?? readAllStdin;

  const { flags, switches, unknown, missing } = parseFlags(argv);
  if (unknown.length) { err(`error: unrecognized argument(s): ${unknown.join(" ")}`); err(USAGE); return 2; }
  if (missing.length) { err(`error: missing value for: ${missing.map((m) => `--${m}`).join(", ")}`); err(USAGE); return 2; }

  const username = flags.username?.trim();
  if (!username) { err("error: --username is required."); err(USAGE); return 2; }
  if (!username.includes("@")) { err(`error: --username '${username}' does not look like an email address.`); return 2; }

  // Exactly one password source.
  const pwSources = [
    flags.password !== undefined ? "password" : null,
    switches.has("password-stdin") ? "password-stdin" : null,
    flags["password-file"] !== undefined ? "password-file" : null,
  ].filter(Boolean) as string[];
  if (pwSources.length === 0) {
    err("error: a password is required — use --password-stdin, --password-file <path>, or --password <pw>.");
    err(USAGE); return 2;
  }
  if (pwSources.length > 1) {
    err(`error: provide only one password source (got ${pwSources.join(", ")}).`); return 2;
  }

  let password: string;
  try {
    if (switches.has("password-stdin")) {
      password = (await readStdin()).replace(/[\r\n]+$/, "");
    } else if (flags["password-file"] !== undefined) {
      password = readFileSync(flags["password-file"], "utf-8").replace(/[\r\n]+$/, "");
    } else {
      password = flags.password ?? "";
    }
  } catch (e: unknown) {
    err(`error: could not read password: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!password) { err("error: the supplied password is empty."); return 2; }

  if (switches.has("insecure") && flags["bridge-cert"] !== undefined) {
    err("error: --insecure and --bridge-cert are mutually exclusive."); return 2;
  }
  const tls = flags.tls;
  if (tls !== undefined && tls !== "starttls" && tls !== "ssl") {
    err("error: --tls must be 'starttls' or 'ssl'."); return 2;
  }

  let imapPort: number, smtpPort: number;
  try {
    imapPort = flags["imap-port"] !== undefined ? parsePort(flags["imap-port"], "imap-port") : 1143;
    smtpPort = flags["smtp-port"] !== undefined ? parsePort(flags["smtp-port"], "smtp-port") : 1025;
  } catch (e: unknown) {
    err(`error: ${e instanceof Error ? e.message : String(e)}`); return 2;
  }

  // Update the ACTIVE account (readRegistry synthesizes a "primary" Bridge
  // account from the legacy connection block on a fresh install), then persist
  // via writeRegistry so the secret lands on the authoritative per-account
  // keychain key — not the legacy key that a per-account install would shadow.
  const reg = readRegistry();
  const active = reg.accounts.find((a) => a.id === reg.activeAccountId) ?? reg.accounts[0];
  if (!active) { err("error: could not resolve an account to update."); return 1; }

  active.username = username;
  active.password = password;
  active.imapHost = (flags["imap-host"] || "127.0.0.1").trim();
  active.imapPort = imapPort;
  active.smtpHost = (flags["smtp-host"] || "127.0.0.1").trim();
  active.smtpPort = smtpPort;
  if (tls !== undefined) active.tlsMode = tls;
  if (flags["bridge-cert"] !== undefined) {
    active.bridgeCertPath = flags["bridge-cert"];
    active.allowInsecureBridge = false;
  }
  if (switches.has("insecure")) active.allowInsecureBridge = true;

  try {
    await writeRegistry(reg);
  } catch (e: unknown) {
    err(`error: failed to save config: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const storage = loadConfig()?.credentialStorage ?? "keychain";
  out(`Saved credentials for ${username} → account '${active.id}' (stored in ${storage}).`);
  out(`  IMAP: ${active.imapHost}:${active.imapPort}`);
  out(`  SMTP: ${active.smtpHost}:${active.smtpPort}`);
  if (active.allowInsecureBridge && !active.bridgeCertPath) {
    out("  TLS:  INSECURE (no pinned Bridge cert) — fine for a loopback-only install.");
  }
  if (reg.accounts.length > 1) {
    out(`  (Updated the active account; ${reg.accounts.length - 1} other account(s) untouched — manage them with mailpouch-settings.)`);
  }
  out("");
  out("Next: start Proton Bridge (signed in), then run `mailpouch doctor` to verify the connection.");
  out("Your MCP client must also be approved once — see `setup_status` / the Agents tab.");
  return 0;
}
