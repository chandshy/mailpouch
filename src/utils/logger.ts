/**
 * Logging utility for pm-bridge-mcp
 */

import { appendFile, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { LogEntry } from "../types/index.js";

/**
 * Keys whose values must be redacted before being stored in log entries.
 * Matched as a substring so compound names like `remoteBearerToken`,
 * `passAccessToken`, `simpleloginApiKey`, `codeVerifier`, `access_token`,
 * `client_secret` are all covered. The first group is "values we never
 * want on disk"; the second is "email body-like fields" that might carry
 * user content we don't need in a debug log.
 */
const SENSITIVE_KEYS = /(password|token|secret|apikey|api_key|verifier|credential|authorization|bridgecertpath|attachments|content|^body$)/i;

export function getLogFilePath(): string {
  // Accept either the new PM_BRIDGE_MCP name or the legacy PROTONMAIL name.
  // New wins; legacy is silently honored for one release to avoid breaking
  // existing installs. Remove the PROTONMAIL_LOG_FILE alias in v2.2.
  const envPath = process.env.PM_BRIDGE_MCP_LOG_FILE || process.env.PROTONMAIL_LOG_FILE;
  if (envPath) return envPath;
  // Read-old/write-new: if a legacy ~/.protonmail-mcp.log exists and the new
  // one doesn't, keep appending to the legacy file so existing tail/grep
  // workflows don't suddenly go silent. Otherwise, write to the new path.
  const preferred = join(homedir(), ".pm-bridge-mcp.log");
  const legacy = join(homedir(), ".protonmail-mcp.log");
  if (!existsSync(preferred) && existsSync(legacy)) return legacy;
  return preferred;
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
   */
  private sanitizeData(data: unknown, seen?: WeakSet<object>): unknown {
    if (data === null || data === undefined) return data;
    if (typeof data === "string") {
      const truncated = data.length > 200 ? data.substring(0, 200) + "…" : data;
      return truncated.replace(/[\x00-\x1f\x7f]/g, " ");
    }
    if (typeof data !== "object") return data;

    // Prevent infinite recursion on circular references (e.g. socket/TLS error objects)
    const tracker = seen ?? new WeakSet();
    if (tracker.has(data as object)) return "[circular]";
    tracker.add(data as object);

    if (Array.isArray(data)) {
      return data.map((item) => this.sanitizeData(item, tracker));
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEYS.test(key) ? "[redacted]" : this.sanitizeData(value, tracker);
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
      console.error(`${this.ts()} [DEBUG] [${context}] ${message}`, data || "");
    }
  }

  info(message: string, context: string = "System", data?: unknown): void {
    this.log("info", message, context, data);
    console.error(`${this.ts()} [INFO] [${context}] ${message}`, data || "");
  }

  warn(message: string, context: string = "System", data?: unknown): void {
    this.log("warn", message, context, data);
    console.error(`${this.ts()} [WARN] [${context}] ${message}`, data || "");
  }

  error(message: string, context: string = "System", error?: unknown): void {
    this.log("error", message, context, error);
    console.error(`${this.ts()} [ERROR] [${context}] ${message}`, error || "");
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
      appendFile(getLogFilePath(), JSON.stringify(entry) + "\n", "utf8", () => {
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
