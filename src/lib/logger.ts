/**
 * Frontend Logging Service
 *
 * Provides structured logging for the React frontend that:
 * - Logs to console in development
 * - Sends logs to the Rust backend for persistence
 * - Buffers logs to avoid overwhelming the backend
 */

import { invoke } from "@tauri-apps/api/core";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

class Logger {
  private buffer: LogEntry[] = [];
  private maxBuffer = 50;
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private isInitialized = false;

  /**
   * Initialize the logger and start periodic flushing
   */
  init() {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // Flush logs to backend every 10 seconds
    this.flushInterval = setInterval(() => {
      this.flush();
    }, 10000);

    // Flush on page unload
    window.addEventListener("beforeunload", () => {
      this.flush();
    });

    this.info("Frontend logger initialized");
  }

  /**
   * Clean up the logger
   */
  destroy() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flush();
    this.isInitialized = false;
  }

  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>
  ) {
    const entry: LogEntry = {
      level,
      message,
      context,
      timestamp: new Date().toISOString(),
    };

    // Console output in development
    if (import.meta.env.DEV) {
      const fn =
        level === "error"
          ? console.error
          : level === "warn"
            ? console.warn
            : level === "debug"
              ? console.debug
              : console.log;
      const prefix = `[${level.toUpperCase()}]`;
      if (context && Object.keys(context).length > 0) {
        fn(prefix, message, context);
      } else {
        fn(prefix, message);
      }
    }

    // Buffer for backend transmission
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.shift();
    }

    // Immediately send errors to backend
    if (level === "error") {
      this.sendToBackend(entry);
    }
  }

  private async sendToBackend(entry: LogEntry) {
    try {
      await invoke("log_frontend_event", {
        level: entry.level,
        message: entry.message,
        context: entry.context ? JSON.stringify(entry.context) : null,
      });
    } catch {
      // Silently fail - don't create infinite loops
    }
  }

  /**
   * Send buffered logs to backend
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const logs = [...this.buffer];
    this.buffer = [];

    // Send important logs to backend
    const importantLogs = logs.filter(
      (l) => l.level === "error" || l.level === "warn" || l.level === "info"
    );

    for (const log of importantLogs) {
      await this.sendToBackend(log);
    }
  }

  /**
   * Log debug message (verbose, development only)
   */
  debug(message: string, context?: Record<string, unknown>) {
    this.log("debug", message, context);
  }

  /**
   * Log info message (normal operations)
   */
  info(message: string, context?: Record<string, unknown>) {
    this.log("info", message, context);
  }

  /**
   * Log warning message (potential issues)
   */
  warn(message: string, context?: Record<string, unknown>) {
    this.log("warn", message, context);
  }

  /**
   * Log error message (failures)
   */
  error(message: string, context?: Record<string, unknown>) {
    this.log("error", message, context);
  }

  /**
   * Log an Error object with stack trace
   */
  logError(error: Error, context?: Record<string, unknown>) {
    this.error(error.message, {
      ...context,
      stack: error.stack,
      name: error.name,
    });
  }

  /**
   * Create a child logger with preset context
   */
  child(defaultContext: Record<string, unknown>): ChildLogger {
    return new ChildLogger(this, defaultContext);
  }
}

/**
 * Child logger with preset context
 */
class ChildLogger {
  constructor(
    private parent: Logger,
    private defaultContext: Record<string, unknown>
  ) {}

  private mergeContext(context?: Record<string, unknown>) {
    return { ...this.defaultContext, ...context };
  }

  debug(message: string, context?: Record<string, unknown>) {
    this.parent.debug(message, this.mergeContext(context));
  }

  info(message: string, context?: Record<string, unknown>) {
    this.parent.info(message, this.mergeContext(context));
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.parent.warn(message, this.mergeContext(context));
  }

  error(message: string, context?: Record<string, unknown>) {
    this.parent.error(message, this.mergeContext(context));
  }

  logError(error: Error, context?: Record<string, unknown>) {
    this.parent.logError(error, this.mergeContext(context));
  }
}

// Export singleton instance
export const logger = new Logger();

// Export types
export type { LogLevel, LogEntry, ChildLogger };
