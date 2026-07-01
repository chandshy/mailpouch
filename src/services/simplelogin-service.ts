/**
 * SimpleLogin REST client.
 *
 * SimpleLogin is the alias-management service owned by Proton (since 2022).
 * It exposes a public HTTP API documented at:
 *   https://github.com/simple-login/app/blob/master/docs/api.md
 *
 * Authentication uses a single `Authentication:` header (note the non-standard
 * spelling — that's how SimpleLogin designed it). API keys are scoped per
 * account and generated from the SimpleLogin dashboard.
 *
 * All requests are fire-and-forget from mailpouch's perspective; we do
 * not persist alias state locally — the agent always reads fresh from the API.
 */

import { logger } from "../utils/logger.js";

const DEFAULT_BASE_URL = "https://app.simplelogin.io";
const REQUEST_TIMEOUT_MS = 15_000;

export interface SimpleLoginAlias {
  id: number;
  email: string;
  enabled: boolean;
  creation_date?: string;
  creation_timestamp?: number;
  name?: string | null;
  note?: string | null;
  nb_block?: number;
  nb_forward?: number;
  nb_reply?: number;
}

export interface SimpleLoginActivity {
  action: "forward" | "block" | "reply" | "bounced";
  from: string;
  to: string;
  timestamp: number;
  reverse_alias?: string;
}

export interface SimpleLoginContact {
  id: number;
  /** The external email address this reverse-alias forwards to. */
  contact: string;
  /** Display form, e.g. "Name <ra+xxx@simplelogin.co>". */
  reverse_alias: string;
  /** The raw reverse-alias address to put in To: when sending as the alias. */
  reverse_alias_address: string;
  /** POST only: true when the contact already existed (idempotent create). */
  existed?: boolean;
  block_forward?: boolean;
  creation_date?: string;
  creation_timestamp?: number;
  last_email_sent_date?: string | null;
  last_email_sent_timestamp?: number | null;
}

export interface AliasCreateRandomOptions {
  /** "uuid" = long random hex; "word" = readable word-pairs. */
  mode?: "uuid" | "word";
  hostname?: string;
  note?: string;
}

export interface AliasCreateCustomOptions {
  /** Prefix portion of the alias email (before the suffix). Must match API constraints. */
  aliasPrefix: string;
  /** Signed suffix string returned by the /api/v5/alias/options endpoint. */
  signedSuffix: string;
  mailboxIds?: number[];
  hostname?: string;
  note?: string;
  name?: string;
}

export class SimpleLoginService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey: string, baseUrl: string = DEFAULT_BASE_URL) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** True when the service has been configured with a non-empty API key. */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * CRED-012: strip secret-shaped substrings from a server-controlled error
   * string. Replaces (a) the exact configured API key and (b) any long
   * opaque token (SimpleLogin keys are ~40+ char base62/hex blobs) with a
   * `[redacted]` placeholder so they never reach the log or the MCP response.
   */
  private redactSecrets(message: string): string {
    let out = message;
    if (this.apiKey) {
      out = out.split(this.apiKey).join("[redacted]");
    }
    // Generic catch-all for opaque tokens: 24+ chars of base62/_- with no
    // whitespace. Errs toward over-redaction; human-readable messages rarely
    // contain unbroken 24-char alphanumeric runs.
    out = out.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]");
    return out;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.apiKey) {
      throw new Error(
        "SimpleLogin: no API key configured. Set simpleloginApiKey in Settings → Aliases, " +
        "or obtain one at https://app.simplelogin.io/dashboard/api_key",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "Authentication": this.apiKey,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // SimpleLogin returns structured errors: { error: "message" }
        let message = `${res.status} ${res.statusText}`;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch { /* non-JSON body — use status text */ }
        // CRED-012: the upstream `error` body is server-controlled and reaches
        // the MCP response + the JSONL log, whose redaction is key-based (not
        // value-pattern). Defensively scrub our own API key and any
        // token-shaped substrings before raising so a hostile error string
        // can't smuggle a secret into ~/.mailpouch.log.
        message = this.redactSecrets(message);
        throw new Error(`SimpleLogin ${init.method ?? "GET"} ${path} → ${message}`);
      }
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * List all aliases on the account. Paginates transparently.
   * `pageSize` is a caller-enforced cap on total results (not a SimpleLogin parameter).
   */
  async listAliases(pageSize = 200): Promise<SimpleLoginAlias[]> {
    logger.debug("SimpleLogin: listing aliases", "SimpleLoginService", { pageSize });
    const collected: SimpleLoginAlias[] = [];
    let page = 0;
    // SimpleLogin returns { aliases: SimpleLoginAlias[] }. An empty array signals end.
    while (collected.length < pageSize) {
      const body = await this.request<{ aliases?: SimpleLoginAlias[] }>(
        `/api/v2/aliases?page_id=${page}`,
      );
      const batch = body.aliases ?? [];
      if (batch.length === 0) break;
      collected.push(...batch);
      if (collected.length >= pageSize) break;
      page += 1;
      // Safety: never fetch more than 50 pages — 20/page × 50 = 1000 aliases
      if (page >= 50) break;
    }
    return collected.slice(0, pageSize);
  }

  /** Create a random alias. Default mode is "uuid" (long, least guessable). */
  async createRandomAlias(opts: AliasCreateRandomOptions = {}): Promise<SimpleLoginAlias> {
    const params = new URLSearchParams();
    if (opts.hostname) params.set("hostname", opts.hostname);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.request<SimpleLoginAlias>(`/api/alias/random/new${qs}`, {
      method: "POST",
      body: JSON.stringify({
        mode: opts.mode ?? "uuid",
        note: opts.note ?? null,
      }),
    });
  }

  /**
   * Create a custom alias. Requires a `signedSuffix` obtained from
   * /api/v5/alias/options — we expose that via {@link getAliasOptions} for the
   * caller to populate the UI.
   */
  async createCustomAlias(opts: AliasCreateCustomOptions): Promise<SimpleLoginAlias> {
    const params = new URLSearchParams();
    if (opts.hostname) params.set("hostname", opts.hostname);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.request<SimpleLoginAlias>(`/api/v3/alias/custom/new${qs}`, {
      method: "POST",
      body: JSON.stringify({
        alias_prefix: opts.aliasPrefix,
        signed_suffix: opts.signedSuffix,
        mailbox_ids: opts.mailboxIds,
        note: opts.note,
        name: opts.name,
      }),
    });
  }

  /** Fetch the prefixes / suffixes available for custom-alias creation. */
  async getAliasOptions(hostname?: string): Promise<{
    can_create: boolean;
    suffixes: Array<{ suffix: string; signed_suffix: string; is_custom: boolean; is_premium?: boolean }>;
    prefix_suggestion?: string;
  }> {
    const params = new URLSearchParams();
    if (hostname) params.set("hostname", hostname);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.request(`/api/v5/alias/options${qs}`);
  }

  async toggleAlias(aliasId: number): Promise<{ enabled: boolean }> {
    return this.request(`/api/aliases/${aliasId}/toggle`, { method: "POST" });
  }

  async deleteAlias(aliasId: number): Promise<void> {
    await this.request(`/api/aliases/${aliasId}`, { method: "DELETE" });
  }

  async getAliasActivities(aliasId: number, pageSize = 50): Promise<SimpleLoginActivity[]> {
    const collected: SimpleLoginActivity[] = [];
    let page = 0;
    while (collected.length < pageSize) {
      const body = await this.request<{ activities?: SimpleLoginActivity[] }>(
        `/api/aliases/${aliasId}/activities?page_id=${page}`,
      );
      const batch = body.activities ?? [];
      if (batch.length === 0) break;
      collected.push(...batch);
      if (collected.length >= pageSize) break;
      page += 1;
      if (page >= 20) break;
    }
    return collected.slice(0, pageSize);
  }

  /**
   * Update an existing alias. SimpleLogin defines this as PATCH
   * /api/aliases/:id (not PUT) — see docs/api.md "Update alias info". Any
   * subset of the fields may be sent; omitted fields are left unchanged.
   */
  async updateAlias(
    aliasId: number,
    patch: { name?: string; note?: string; mailbox_ids?: number[]; disable_pgp?: boolean; pinned?: boolean },
  ): Promise<void> {
    await this.request(`/api/aliases/${aliasId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /**
   * List the reverse-alias contacts for an alias. Each contact is an external
   * address you can send *as* this alias to; `reverse_alias_address` is the
   * To: address that routes the reply out through SimpleLogin (and encrypts to
   * the recipient's PGP key when one is configured).
   */
  async listContacts(aliasId: number, pageSize = 100): Promise<SimpleLoginContact[]> {
    const collected: SimpleLoginContact[] = [];
    let page = 0;
    // SimpleLogin returns { contacts: SimpleLoginContact[] }; empty array = end.
    while (collected.length < pageSize) {
      const body = await this.request<{ contacts?: SimpleLoginContact[] }>(
        `/api/aliases/${aliasId}/contacts?page_id=${page}`,
      );
      const batch = body.contacts ?? [];
      if (batch.length === 0) break;
      collected.push(...batch);
      if (collected.length >= pageSize) break;
      page += 1;
      if (page >= 50) break;
    }
    return collected.slice(0, pageSize);
  }

  /**
   * Create (or fetch, if it already exists) a reverse-alias contact. `contact`
   * is the external recipient as "email@example.com" or "Name <email@…>".
   * Returns `reverse_alias_address` — the To: address to send to so the message
   * goes out from the alias. `existed: true` means the contact was already present.
   */
  async createContact(aliasId: number, contact: string): Promise<SimpleLoginContact> {
    return this.request<SimpleLoginContact>(`/api/aliases/${aliasId}/contacts`, {
      method: "POST",
      body: JSON.stringify({ contact }),
    });
  }

  async deleteContact(contactId: number): Promise<void> {
    await this.request(`/api/contacts/${contactId}`, { method: "DELETE" });
  }

  /** Block or unblock a contact from forwarding. Returns the new block state. */
  async toggleContact(contactId: number): Promise<{ block_forward: boolean }> {
    return this.request(`/api/contacts/${contactId}/toggle`, { method: "POST" });
  }
}
