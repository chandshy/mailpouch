/**
 * Exponential-backoff scheduler for abuse-signal responses.
 *
 * Proton does not publish explicit IMAP/SMTP rate-limit headers, but the
 * Bridge surfaces throttling through standard protocol-level codes:
 *
 *   - SMTP 421 — service not available / temporarily throttled
 *   - SMTP 454 — temporary authentication failure (often anti-abuse)
 *   - SMTP 450 — mailbox temporarily unavailable
 *   - IMAP BYE [ALERT] — server-initiated disconnect (Bridge human-verification path)
 *
 * This module translates those signals into a small amount of
 * well-behaved client-side backoff so the agentic workload does not
 * hammer Bridge / Proton and trip account-level blocks.
 */

const ABUSE_CODE_RE = /\b(4(?:21|50|54))\b/;
const TRANSIENT_KEYWORD_RE = /(?:throttl|rate.?limit|try again|temporarily|too many|anti.?abuse|human.?verification|\bBYE\b)/i;

/**
 * Classify an arbitrary error from a send/connect path as a transient
 * abuse-adjacent signal worth backing off on (vs. a terminal failure).
 *
 * Matches SMTP 4xx codes (421, 450, 454) and common Bridge/Proton throttle
 * keywords. Conservative — non-matching errors are treated as terminal.
 */
export function isTransientAbuseError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { responseCode?: number; code?: string | number }).responseCode
    ?? (err as { responseCode?: number; code?: string | number }).code;
  if (typeof code === "number" && (code === 421 || code === 450 || code === 454)) return true;
  if (typeof code === "string" && /4(21|50|54)/.test(code)) return true;
  if (ABUSE_CODE_RE.test(msg)) return true;
  if (TRANSIENT_KEYWORD_RE.test(msg)) return true;
  return false;
}

/**
 * Tracks consecutive failure attempts and emits a delay-until timestamp
 * with exponential growth + small jitter. Callers record each attempt's
 * outcome with {@link record} and ask {@link delayUntilMs} whether a
 * pending attempt should wait.
 */
export class BackoffTracker {
  /** Number of consecutive abuse-signal failures observed. Reset on success. */
  private failures = 0;
  /** Absolute ms timestamp before which no attempt should be made. */
  private blockedUntil = 0;

  constructor(
    private readonly baseDelayMs = 2_000,
    private readonly maxDelayMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
    private readonly jitter: () => number = Math.random,
  ) {}

  /**
   * Record the outcome of an attempt.
   *
   * - `"success"` — clears the backoff state.
   * - `"abuse"` — increments the failure counter and schedules the next
   *               allowed attempt with exponential growth + jitter.
   * - `"terminal"` — does not change the backoff state (leave untouched so
   *                  a permanent auth failure doesn't masquerade as throttling).
   */
  record(outcome: "success" | "abuse" | "terminal"): void {
    if (outcome === "success") {
      this.failures = 0;
      this.blockedUntil = 0;
      return;
    }
    if (outcome !== "abuse") return;

    this.failures += 1;
    const exp = Math.min(this.baseDelayMs * 2 ** (this.failures - 1), this.maxDelayMs);
    const jittered = exp * (0.75 + 0.5 * this.jitter()); // ±25% jitter
    this.blockedUntil = this.now() + Math.round(jittered);
  }

  /** Whether the tracker is currently holding back new attempts. */
  isBlocked(): boolean {
    return this.blockedUntil > this.now();
  }

  /** Milliseconds remaining on the current backoff window (0 if not blocked). */
  delayUntilMs(): number {
    const ms = this.blockedUntil - this.now();
    return ms > 0 ? ms : 0;
  }

  /** Current consecutive-failure count (0 after a successful attempt). */
  get failureCount(): number {
    return this.failures;
  }

  /** Absolute ms timestamp of the current backoff deadline (0 if unblocked). */
  get blockedUntilMs(): number {
    return this.blockedUntil;
  }

  /** Force-clear all state. Use when the user manually retries. */
  reset(): void {
    this.failures = 0;
    this.blockedUntil = 0;
  }
}
