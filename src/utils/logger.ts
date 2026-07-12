/**
 * Logging utility for mailpouch
 */

import { appendFile, statSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { LogEntry } from "../types/index.js";

function statSyncSafe(p: string): import("fs").Stats | null {
  try { return statSync(p); } catch { return null; }
}
function chmodSyncSafe(p: string, m: number): void {
  try { chmodSync(p, m); } catch { /* ignore */ }
}

/**
 * Keys whose values must be redacted before being stored in log entries.
 * Matched as a substring so compound names like `remoteBearerToken`,
 * `passAccessToken`, `simpleloginApiKey`, `codeVerifier`, `access_token`,
 * `client_secret` are all covered. The first group is "values we never
 * want on disk"; the second is "email body-like fields" that might carry
 * user content we don't need in a debug log.
 */
const SENSITIVE_KEYS = /(password|token|secret|apikey|api_key|verifier|credential|authorization|cookie|oauth|bridgecertpath|attachments|content|^body$)/i;

export function getLogFilePath(): string {
  const envPath = process.env.MAILPOUCH_LOG_FILE;
  if (envPath) return envPath;
  return join(homedir(), ".mailpouch.log");
}

export class Logger {
  private debugMode: boolean = false;
  private logs: LogEntry[] = [];
  private maxLogs: number = 1000;
  // Becomes true on first setDebugMode() call (i.e. once config is loaded by the server).
  // Tests that never call setDebugMode will not write to the log file.
  private fileLogging: boolean = false;
  // Gates debug-level file writes specifically.
  private debugFileLogging: boolean = false;

  /**
   * Recursively sanitize data before storing in log entries.
   * Redacts sensitive keys and truncates long strings.
   *
   * Cap recursion at SANITIZE_MAX_DEPTH so adversary-supplied JSON nested
   * thousands of levels deep can't blow the stack or burn the CPU during
   * sanitisation.
   */
  private sanitizeData(data: unknown, seen?: WeakSet<object>, depth = 0): unknown {
    if (data === null || data === undefined) return data;
    if (typeof data === "string") {
      const truncated = data.length > 200 ? data.substring(0, 200) + "…" : data;
      return truncated.replace(/[\x00-\x1f\x7f]/g, " ");
    }
    if (typeof data !== "object") return data;
    if (depth > 100) return "[depth-limit]";

    // Prevent infinite recursion on circular references (e.g. socket/TLS error objects)
    const tracker = seen ?? new WeakSet();
    if (tracker.has(data as object)) return "[circular]";
    tracker.add(data as object);

    if (Array.isArray(data)) {
      return data.map((item) => this.sanitizeData(item, tracker, depth + 1));
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEYS.test(key) ? "[redacted]" : this.sanitizeData(value, tracker, depth + 1);
    }
    return result;
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
    // Activate file logging on first call so info/warn/error are always captured
    // once the server has loaded its config. Tests that never call setDebugMode
    // won't write to the log file.
    this.fileLogging = true;
    // debugFileLogging gates whether debug-level entries also go to file.
    this.debugFileLogging = enabled;
  }

  private ts(): string {
    return new Date().toISOString();
  }

  debug(message: string, context: string = "System", data?: unknown): void {
    if (this.debugMode) {
      this.log("debug", message, context, data);
      console.error("%s", `${this.ts()} [DEBUG] [${context}] ${message}`, data || "");
    }
  }

  info(message: string, context: string = "System", data?: unknown): void {
    this.log("info", message, context, data);
    console.error("%s", `${this.ts()} [INFO] [${context}] ${message}`, data || "");
  }

  warn(message: string, context: string = "System", data?: unknown): void {
    this.log("warn", message, context, data);
    console.error("%s", `${this.ts()} [WARN] [${context}] ${message}`, data || "");
  }

  error(message: string, context: string = "System", error?: unknown): void {
    this.log("error", message, context, error);
    console.error("%s", `${this.ts()} [ERROR] [${context}] ${message}`, error || "");
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context: string,
    data?: unknown
  ): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      context,
      message,
      data: this.sanitizeData(data),
    };

    this.logs.push(entry);

    // Keep only last N logs to prevent memory issues
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Append to log file:
    //   - info / warn / error always write once fileLogging is active (set after config loads)
    //   - debug entries only write when debugFileLogging is also enabled
    const shouldWriteFile = this.fileLogging &&
      (level !== "debug" || this.debugFileLogging);
    if (shouldWriteFile) {
      // Explicit mode 0o600 so debug entries (which may carry email-like
      // context, even after redaction) are owner-readable only.
      // appendFile creates the file if missing; otherwise the mode is
      // ignored, so we also chmodSync if the file already exists with
      // looser permissions (e.g. upgraded from an older mailpouch).
      const path = getLogFilePath();
      try {
        const st = statSyncSafe(path);
        if (st && (st.mode & 0o077) !== 0) chmodSyncSafe(path, 0o600);
      } catch { /* ignore */ }
      appendFile(path, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 }, () => {
        /* best-effort — never crash the server over a log write */
      });
    }
  }

  getLogs(
    level?: "debug" | "info" | "warn" | "error",
    limit: number = 100
  ): LogEntry[] {
    const safeLimit = Math.min(Math.max(1, limit), 500);
    let filteredLogs = this.logs;

    if (level) {
      filteredLogs = filteredLogs.filter((log) => log.level === level);
    }

    return filteredLogs.slice(-safeLimit);
  }

  clearLogs(): void {
    this.logs = [];
  }
}

// Export singleton instance
export const logger = new Logger();
