/**
 * Permission Manager — enforces per-tool access control and rate limiting.
 *
 * Reads the config file every CONFIG_CACHE_MS (default 15 s) so changes
 * made via the settings UI take effect without restarting the MCP server.
 *
 * Rate limiting uses an in-memory rolling 1-hour window.
 * If no config file exists the read-only preset is enforced (safe default).
 */

import { loadConfig, defaultConfig } from "../config/loader.js";
import type { ToolName } from "../config/schema.js";
import { logger } from "../utils/logger.js";

interface RateBucket {
  /** Timestamps (ms) of calls within the current rolling window */
  timestamps: number[];
}

export interface PermissionResult {
  allowed: boolean;
  /** Human-readable reason, present only when allowed === false */
  reason?: string;
}

const CONFIG_CACHE_MS = 15_000;

export class PermissionManager {
  private rateBuckets = new Map<string, RateBucket>();
  private cachedConfig = loadConfig();
  private lastConfigLoad = Date.now();

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Check whether a tool may be called right now.
   *
   * When no config file exists the read-only preset is enforced — agents may
   * read, search, and view analytics, but cannot send, move, delete, tag, or
   * modify any email state. Users must explicitly grant broader access via
   * the settings UI (`npm run settings`) and save a config file.
   */
  check(tool: ToolName): PermissionResult {
    this.refreshConfigIfStale();

    // Fall back to read-only defaults when no config file is present.
    const config = this.cachedConfig ?? defaultConfig();

    const perm = config.permissions?.tools?.[tool];
    if (!perm) return { allowed: true };

    if (!perm.enabled) {
      return {
        allowed: false,
        reason: `'${tool}' is disabled in server settings. Enable it in the settings UI to allow agentic access.`,
      };
    }

    const limit = perm.rateLimit;
    if (limit !== null && limit !== undefined && limit > 0) {
      if (!this.consumeRateSlot(tool, limit)) {
        logger.warn(`Rate limit reached for tool '${tool}' (limit: ${limit}/hour)`, "PermissionManager");
        return {
          allowed: false,
          reason: `'${tool}' rate limit of ${limit} calls/hour has been reached. Try again later or raise the limit in settings.`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Return current call counts for each rate-limited tool (for the status UI).
   */
  rateLimitStatus(): Record<string, { used: number; limit: number }> {
    this.refreshConfigIfStale();
    const config = this.cachedConfig;
    if (!config) return {};

    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    const out: Record<string, { used: number; limit: number }> = {};

    for (const [tool, perm] of Object.entries(config.permissions?.tools ?? {})) {
      if (perm.rateLimit !== null && perm.rateLimit !== undefined) {
        const bucket = this.rateBuckets.get(tool);
        const used = bucket
          ? bucket.timestamps.filter((ts) => ts > windowStart).length
          : 0;
        out[tool] = { used, limit: perm.rateLimit };
      }
    }
    return out;
  }

  /** Force an immediate config reload (e.g., after the settings UI saves). */
  invalidate(): void {
    this.cachedConfig = loadConfig();
    this.lastConfigLoad = Date.now();
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private refreshConfigIfStale(): void {
    if (Date.now() - this.lastConfigLoad > CONFIG_CACHE_MS) {
      this.cachedConfig = loadConfig();
      this.lastConfigLoad = Date.now();
    }
  }

  private consumeRateSlot(tool: string, limitPerHour: number): boolean {
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;

    let bucket = this.rateBuckets.get(tool);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.rateBuckets.set(tool, bucket);
    }

    // Evict timestamps outside the rolling window
    bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);

    if (bucket.timestamps.length >= limitPerHour) return false;

    bucket.timestamps.push(now);
    return true;
  }
}

/** Singleton shared across the MCP server process */
export const permissions = new PermissionManager();
