/**
 * Exponential Backoff Polling Utilities
 *
 * Provides polling with exponential backoff for more efficient resource usage
 * and better handling of failures.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { logger } from './logger';

export interface PollingOptions {
  /** Starting interval in milliseconds */
  initialInterval: number;
  /** Maximum interval in milliseconds */
  maxInterval: number;
  /** Backoff multiplier (default 2) */
  multiplier?: number;
  /** Optional max retry count before stopping */
  maxRetries?: number;
  /** Reset interval on success (default true) */
  resetOnSuccess?: boolean;
  /** Add randomness to prevent thundering herd (default false) */
  jitter?: boolean;
  /** Name for logging purposes */
  name?: string;
}

export interface PollingResult<T> {
  data: T | null;
  error: Error | null;
  attempt: number;
  nextInterval: number;
}

/**
 * Exponential backoff poller class
 */
export class ExponentialPoller<T> {
  private interval: number;
  private attempt = 0;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private options: Required<PollingOptions>;

  constructor(
    private fetcher: () => Promise<T>,
    private onResult: (result: PollingResult<T>) => void,
    options: PollingOptions
  ) {
    this.options = {
      multiplier: 2,
      resetOnSuccess: true,
      jitter: false,
      name: 'poller',
      maxRetries: Infinity,
      ...options,
    };
    this.interval = options.initialInterval;
  }

  /**
   * Start polling
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.debug(`${this.options.name}: Starting polling`, {
      interval: this.interval,
    });
    void this.poll();
  }

  /**
   * Stop polling
   */
  stop() {
    this.isRunning = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    logger.debug(`${this.options.name}: Stopped polling`);
  }

  /**
   * Reset interval to initial value
   */
  reset() {
    this.interval = this.options.initialInterval;
    this.attempt = 0;
    logger.debug(`${this.options.name}: Reset interval`, {
      interval: this.interval,
    });
  }

  /**
   * Get current state
   */
  getState() {
    return {
      isRunning: this.isRunning,
      interval: this.interval,
      attempt: this.attempt,
    };
  }

  private async poll() {
    if (!this.isRunning) return;

    this.attempt++;

    try {
      const data = await this.fetcher();

      // Success - optionally reset interval
      if (this.options.resetOnSuccess) {
        this.interval = this.options.initialInterval;
      }

      this.onResult({
        data,
        error: null,
        attempt: this.attempt,
        nextInterval: this.interval,
      });
    } catch (error) {
      // Failure - apply exponential backoff
      const prevInterval = this.interval;
      this.interval = Math.min(this.interval * this.options.multiplier, this.options.maxInterval);

      logger.debug(`${this.options.name}: Backing off`, {
        attempt: this.attempt,
        prevInterval,
        newInterval: this.interval,
        error: error instanceof Error ? error.message : String(error),
      });

      this.onResult({
        data: null,
        error: error instanceof Error ? error : new Error(String(error)),
        attempt: this.attempt,
        nextInterval: this.interval,
      });

      // Check max retries
      if (this.attempt >= this.options.maxRetries) {
        logger.warn(`${this.options.name}: Max retries reached, stopping`, {
          maxRetries: this.options.maxRetries,
        });
        this.stop();
        return;
      }
    }

    // Schedule next poll with optional jitter
    let delay = this.interval;
    if (this.options.jitter) {
      // Add ±25% jitter
      delay = delay * (0.75 + Math.random() * 0.5);
    }

    this.timeoutId = setTimeout(() => {
      void this.poll();
    }, delay);
  }
}

/**
 * React hook for exponential backoff polling
 */
export function useExponentialPolling<T>(
  fetcher: () => Promise<T>,
  options: PollingOptions,
  enabled: boolean = true
): {
  data: T | null;
  error: Error | null;
  isPolling: boolean;
  attempt: number;
  reset: () => void;
  stop: () => void;
  start: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pollerRef = useRef<ExponentialPoller<T> | null>(null);

  // Create poller on mount
  useEffect(() => {
    const poller = new ExponentialPoller(
      fetcher,
      (result) => {
        setData(result.data);
        setError(result.error);
        setAttempt(result.attempt);
      },
      options
    );

    pollerRef.current = poller;

    if (enabled) {
      setIsPolling(true);
      poller.start();
    }

    return () => {
      poller.stop();
      setIsPolling(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const reset = useCallback(() => {
    pollerRef.current?.reset();
  }, []);

  const stop = useCallback(() => {
    pollerRef.current?.stop();
    setIsPolling(false);
  }, []);

  const start = useCallback(() => {
    pollerRef.current?.start();
    setIsPolling(true);
  }, []);

  return { data, error, isPolling, attempt, reset, stop, start };
}

/**
 * Simple polling hook with exponential backoff on errors
 *
 * This is a drop-in replacement for setInterval-based polling
 * that automatically backs off on errors.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled: boolean = true,
  options?: {
    maxInterval?: number;
    onError?: (error: Error) => void;
    onSuccess?: (data: T) => void;
    name?: string;
  }
): {
  data: T | null;
  error: Error | null;
  isPolling: boolean;
  refetch: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const pollerRef = useRef<ExponentialPoller<T> | null>(null);

  useEffect(() => {
    if (!enabled) {
      pollerRef.current?.stop();
      setIsPolling(false);
      return;
    }

    const poller = new ExponentialPoller(
      fetcher,
      (result) => {
        setData(result.data);
        setError(result.error);
        if (result.data !== null) {
          options?.onSuccess?.(result.data);
        }
        if (result.error !== null) {
          options?.onError?.(result.error);
        }
      },
      {
        initialInterval: intervalMs,
        maxInterval: options?.maxInterval ?? intervalMs * 4,
        multiplier: 1.5,
        resetOnSuccess: true,
        jitter: true,
        name: options?.name ?? 'polling',
      }
    );

    pollerRef.current = poller;
    setIsPolling(true);
    poller.start();

    return () => {
      poller.stop();
      setIsPolling(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs]);

  const refetch = useCallback(() => {
    pollerRef.current?.reset();
  }, []);

  return { data, error, isPolling, refetch };
}

/**
 * Create a one-time retry with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    multiplier?: number;
  } = {}
): Promise<T> {
  const { maxRetries = 3, initialDelay = 1000, maxDelay = 30000, multiplier = 2 } = options;

  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }

      logger.debug('Retry with backoff', {
        attempt,
        delay,
        error: error instanceof Error ? error.message : String(error),
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * multiplier, maxDelay);
    }
  }

  // This should never be reached
  throw new Error('Retry failed');
}
