/**
 * Vitest Test Setup
 *
 * Configures the test environment with:
 * - Jest DOM matchers for React Testing Library
 * - Official Tauri API mocks
 * - Global test utilities
 */

import '@testing-library/jest-dom/vitest';
import { vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';

// Store for mock invoke responses
type InvokeResponse = unknown;
const invokeResponses = new Map<string, InvokeResponse>();
const invokeErrors = new Map<string, Error>();

/**
 * Set a mock response for a Tauri invoke command
 */
export function mockInvokeResponse(command: string, response: InvokeResponse) {
  invokeResponses.set(command, response);
  invokeErrors.delete(command);
}

/**
 * Set a mock error for a Tauri invoke command
 */
export function mockInvokeError(command: string, error: Error) {
  invokeErrors.set(command, error);
  invokeResponses.delete(command);
}

/**
 * Clear all mock responses
 */
export function clearInvokeMocks() {
  invokeResponses.clear();
  invokeErrors.clear();
}

// Set up Tauri mocks before all tests
beforeAll(() => {
  // Mock windows
  mockWindows('main');

  // Set up IPC mock handler
  mockIPC((cmd, args) => {
    // Check for error first
    const error = invokeErrors.get(cmd);
    if (error) {
      throw error;
    }

    // Check for custom response
    if (invokeResponses.has(cmd)) {
      const response = invokeResponses.get(cmd);
      // If response is a function, call it with args
      if (typeof response === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        return response(args);
      }
      return response;
    }

    // Default responses for common commands
    switch (cmd) {
      case 'get_shipstudio_dir':
        return '/Users/test/ShipStudio';
      case 'check_prerequisites':
        return [
          { name: 'node', available: true, path: '/usr/local/bin/node' },
          { name: 'npm', available: true, path: '/usr/local/bin/npm' },
          { name: 'git', available: true, path: '/usr/bin/git' },
          { name: 'gh', available: true, path: '/usr/local/bin/gh' },
          { name: 'vercel', available: true, path: '/usr/local/bin/vercel' },
          { name: 'claude', available: true, path: '/usr/local/bin/claude' },
        ];
      case 'get_current_branch':
        return 'main';
      case 'list_branches':
        return [
          {
            name: 'main',
            is_current: true,
            is_remote: false,
            is_default: true,
            last_commit_date: Date.now(),
            last_commit_author: 'Test User',
            ahead_of_main: 0,
            behind_main: 0,
          },
        ];
      case 'check_git_has_changes':
        return false;
      case 'get_log_path':
        return '/Users/test/Library/Logs/ShipStudio';
      case 'log_frontend_event':
        return undefined;
      default:
        console.warn(`[Test] No mock for invoke command: ${cmd}`, args);
        return undefined;
    }
  });
});

// Mock tauri-pty (native module)
vi.mock('tauri-pty', () => ({
  spawn: vi.fn(),
}));

// Mock tauri-plugin-screenshots-api
vi.mock('tauri-plugin-screenshots-api', () => ({
  screenshot: () => Promise.resolve(new Uint8Array()),
  default: { screenshot: () => Promise.resolve(new Uint8Array()) },
}));

// Mock Tauri opener plugin
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}));

// Mock Tauri updater plugin
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn().mockResolvedValue(null),
}));

// Mock Tauri process plugin
vi.mock('@tauri-apps/plugin-process', () => ({
  exit: vi.fn(),
  relaunch: vi.fn(),
}));

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
  clearInvokeMocks();
});

// Cleanup after each test
afterEach(() => {
  vi.restoreAllMocks();
  clearMocks();
});
