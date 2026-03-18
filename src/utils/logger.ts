/**
 * Logging utility for ProtonMail MCP Server
 */

import { appendFile } from "fs";
import { join } from "path";
import { homedir } from "os";
import { LogEntry } from "../types/index.js";

/** Keys whose values must be redacted before being stored in log entries */
const SENSITIVE_KEYS = /^(password|body|content|attachments|smtpToken|bridgeCertPath)$/i;

export function getLogFilePath(): string {
  return process.env.PROTONMAIL_LOG_FILE || join(homedir(), ".protonmail-mcp.log");
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

  debug(message: string, context: string = "System", data?: any): void {
    if (this.debugMode) {
      this.log("debug", message, context, data);
      console.error(`${this.ts()} [DEBUG] [${context}] ${message}`, data || "");
    }
  }

  info(message: string, context: string = "System", data?: any): void {
    this.log("info", message, context, data);
    console.error(`${this.ts()} [INFO] [${context}] ${message}`, data || "");
  }

  warn(message: string, context: string = "System", data?: any): void {
    this.log("warn", message, context, data);
    console.error(`${this.ts()} [WARN] [${context}] ${message}`, data || "");
  }

  error(message: string, context: string = "System", error?: any): void {
    this.log("error", message, context, error);
    console.error(`${this.ts()} [ERROR] [${context}] ${message}`, error || "");
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context: string,
    data?: any
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
