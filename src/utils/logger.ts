/**
 * Logging utility for ProtonMail MCP Server
 */

import { LogEntry } from "../types/index.js";

/** Keys whose values must be redacted before being stored in log entries */
const SENSITIVE_KEYS = /^(password|body|content|attachments|smtpToken|bridgeCertPath)$/i;

export class Logger {
  private debugMode: boolean = false;
  private logs: LogEntry[] = [];
  private maxLogs: number = 1000;

  /**
   * Recursively sanitize data before storing in logs.
   * Redacts sensitive keys and truncates long strings.
   */
  private sanitizeData(data: unknown): unknown {
    if (data === null || data === undefined) return data;
    if (typeof data === "string") {
      const truncated = data.length > 200 ? data.substring(0, 200) + "…" : data;
      return truncated.replace(/[\x00-\x1f\x7f]/g, " ");
    }
    if (Array.isArray(data)) {
      return data.map((item) => this.sanitizeData(item));
    }
    if (typeof data === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        result[key] = SENSITIVE_KEYS.test(key) ? "[redacted]" : this.sanitizeData(value);
      }
      return result;
    }
    return data;
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  debug(message: string, context: string = "System", data?: any): void {
    if (this.debugMode) {
      this.log("debug", message, context, data);
      console.error(`[DEBUG] [${context}] ${message}`, data || "");
    }
  }

  info(message: string, context: string = "System", data?: any): void {
    this.log("info", message, context, data);
    console.error(`[INFO] [${context}] ${message}`, data || "");
  }

  warn(message: string, context: string = "System", data?: any): void {
    this.log("warn", message, context, data);
    console.error(`[WARN] [${context}] ${message}`, data || "");
  }

  error(message: string, context: string = "System", error?: any): void {
    this.log("error", message, context, error);
    console.error(`[ERROR] [${context}] ${message}`, error || "");
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
