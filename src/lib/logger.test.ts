/**
 * Tests for the logger service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock the Tauri invoke before importing the logger
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocking
import { logger } from "./logger";
import { invoke } from "@tauri-apps/api/core";

describe("Logger", () => {
  const mockInvoke = vi.mocked(invoke);

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock console methods
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("logging methods", () => {
    it("should log info messages in development", () => {
      logger.info("Test info message");

      // In dev mode, should log to console
      expect(console.log).toHaveBeenCalledWith(
        "[INFO]",
        "Test info message"
      );
    });

    it("should log warn messages", () => {
      logger.warn("Test warning");

      expect(console.warn).toHaveBeenCalledWith(
        "[WARN]",
        "Test warning"
      );
    });

    it("should log error messages and send to backend", async () => {
      logger.error("Test error");

      expect(console.error).toHaveBeenCalledWith(
        "[ERROR]",
        "Test error"
      );

      // Errors should be sent to backend immediately
      // Wait for async operations
      await vi.waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("log_frontend_event", {
          level: "error",
          message: "Test error",
          context: null,
        });
      });
    });

    it("should log debug messages", () => {
      logger.debug("Debug message");

      expect(console.debug).toHaveBeenCalledWith(
        "[DEBUG]",
        "Debug message"
      );
    });

    it("should include context in logs", () => {
      const context = { userId: "123", action: "test" };
      logger.info("Message with context", context);

      expect(console.log).toHaveBeenCalledWith(
        "[INFO]",
        "Message with context",
        context
      );
    });
  });

  describe("logError", () => {
    it("should log Error objects with stack trace", async () => {
      const error = new Error("Test error");
      error.stack = "Error: Test error\n    at test.ts:1:1";

      logger.logError(error);

      expect(console.error).toHaveBeenCalledWith(
        "[ERROR]",
        "Test error",
        expect.objectContaining({
          stack: expect.stringContaining("Error: Test error"),
          name: "Error",
        })
      );
    });

    it("should merge additional context with error info", () => {
      const error = new Error("Test error");
      const context = { component: "TestComponent" };

      logger.logError(error, context);

      expect(console.error).toHaveBeenCalledWith(
        "[ERROR]",
        "Test error",
        expect.objectContaining({
          component: "TestComponent",
          name: "Error",
        })
      );
    });
  });

  describe("child logger", () => {
    it("should create a child logger with default context", () => {
      const childLogger = logger.child({ component: "TestComponent" });

      childLogger.info("Child message");

      expect(console.log).toHaveBeenCalledWith(
        "[INFO]",
        "Child message",
        expect.objectContaining({
          component: "TestComponent",
        })
      );
    });

    it("should merge child context with additional context", () => {
      const childLogger = logger.child({ component: "TestComponent" });

      childLogger.info("Message", { action: "click" });

      expect(console.log).toHaveBeenCalledWith(
        "[INFO]",
        "Message",
        expect.objectContaining({
          component: "TestComponent",
          action: "click",
        })
      );
    });

    it("should allow additional context to override default context", () => {
      const childLogger = logger.child({ component: "Default" });

      childLogger.info("Message", { component: "Override" });

      expect(console.log).toHaveBeenCalledWith(
        "[INFO]",
        "Message",
        expect.objectContaining({
          component: "Override",
        })
      );
    });
  });

  describe("flush", () => {
    it("should send buffered logs to backend on flush", async () => {
      // Log some messages
      logger.info("Message 1");
      logger.warn("Message 2");

      // Flush
      await logger.flush();

      // Should have sent info and warn logs
      expect(mockInvoke).toHaveBeenCalledWith("log_frontend_event", {
        level: "info",
        message: "Message 1",
        context: null,
      });
      expect(mockInvoke).toHaveBeenCalledWith("log_frontend_event", {
        level: "warn",
        message: "Message 2",
        context: null,
      });
    });
  });
});
