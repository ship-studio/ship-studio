# Ship Studio Improvement Plan

This document outlines a comprehensive plan for improving Ship Studio's reliability, observability, and maintainability.

---

## Completed Improvements

### Telemetry/Logging (P1)

**Status: Implemented**

**Rust Backend:**
- Added `tracing`, `tracing-subscriber`, `tracing-appender` dependencies
- Created [logging.rs](src-tauri/src/logging.rs) with daily rotating log files
- Logs stored at `~/Library/Logs/ShipStudio/` (macOS)
- Added structured logging to git commands: `check_prerequisites`, `init_git_repo`, `switch_branch`, `list_branches`, `create_branch`, `delete_branch`
- Added structured logging to publishing commands: `publish_to_github`, `publish_to_staging`, `publish_to_production`, `publish_branch`
- Replaced all `eprintln!` calls with proper `tracing::*` calls

**React Frontend:**
- Created [logger.ts](src/lib/logger.ts) with structured logging service
- Console output in development, backend persistence for important events
- Child logger pattern for component-scoped context
- Automatic error flushing to backend
- Logger initialized in [App.tsx](src/App.tsx)

### Exponential Backoff (P2)

**Status: Implemented**

- Created [polling.ts](src/lib/polling.ts) with `ExponentialPoller` class
- React hooks: `useExponentialPolling`, `usePolling`
- Utility function: `retryWithBackoff`
- Features: configurable backoff multiplier, jitter, max retries, named logging
- Migrated deployment status polling in [PublishBranchDropdown.tsx](src/components/PublishBranchDropdown.tsx):
  - Start at 2s intervals
  - Back off to 15s max
  - 1.5x multiplier with jitter

---

## Executive Summary

| Improvement | Effort | Impact | Priority | Status |
|-------------|--------|--------|----------|--------|
| 1. Automated Tests | High | High | P1 | Pending |
| 2. Telemetry/Logging | Medium | High | P1 | **Done** |
| 3. Exponential Backoff | Low | Medium | P2 | **Done** |
| 4. Git Command Caching | Medium | Medium | P2 | Pending |
| 5. git2-rs Library | High | Medium | P3 | Pending |

---

## 1. Automated Tests

### Current State
- **Zero test coverage** - no test files, no test frameworks configured
- Manual testing only
- No CI/CD test gates

### Proposed Implementation

#### 1.1 Frontend Testing (React/TypeScript)

**Framework: Vitest + React Testing Library**

Vitest is the natural choice given the Vite build system already in use.

```bash
# Dependencies to add
npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom @vitest/coverage-v8
```

**Configuration (`vitest.config.ts`):**
```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/test/']
    }
  }
})
```

**Test Categories:**

| Category | Files to Test | Priority |
|----------|---------------|----------|
| Component Unit Tests | All components in `src/components/` | High |
| Hook Tests | Custom hooks (branch management, polling) | High |
| Integration Tests | Tauri invoke mocking | Medium |
| E2E Tests | Full user flows | Low (defer) |

**Key Test Files to Create:**

1. **`src/test/setup.ts`** - Global test setup, mock Tauri invoke
2. **`src/components/__tests__/PublishBranchDropdown.test.tsx`** - Deployment flow, polling logic
3. **`src/components/__tests__/BranchesTab.test.tsx`** - Branch operations
4. **`src/components/__tests__/Terminal.test.tsx`** - Terminal interactions
5. **`src/lib/__tests__/branches.test.ts`** - Branch API wrapper
6. **`src/lib/__tests__/vercel.test.ts`** - Vercel API wrapper

**Mocking Tauri:**
```typescript
// src/test/setup.ts
import { vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => () => {}),
  emit: vi.fn()
}))
```

#### 1.2 Backend Testing (Rust)

**Framework: Built-in Rust testing + mockall**

```toml
# Cargo.toml additions
[dev-dependencies]
mockall = "0.13"
tempfile = "3.15"
tokio-test = "0.4"
```

**Test Organization:**
```
src-tauri/src/
├── commands/
│   ├── git.rs
│   └── git_tests.rs       # Unit tests for git operations
├── test_utils.rs          # Shared test helpers
└── integration_tests/     # Full command integration tests
```

**Key Test Files to Create:**

1. **`src-tauri/src/commands/git_tests.rs`** - Git command parsing, error handling
2. **`src-tauri/src/commands/vercel_tests.rs`** - Vercel response parsing
3. **`src-tauri/src/commands/publishing_tests.rs`** - Publish workflow
4. **`src-tauri/src/test_utils.rs`** - Mock project setup, temp directories

**Testing Strategy for CLI Commands:**
```rust
// Create trait for command execution to allow mocking
pub trait CommandExecutor {
    fn execute(&self, command: &str, args: &[&str], cwd: &Path) -> Result<Output, String>;
}

// Real implementation
pub struct RealExecutor;
impl CommandExecutor for RealExecutor {
    fn execute(&self, command: &str, args: &[&str], cwd: &Path) -> Result<Output, String> {
        Command::new(command)
            .args(args)
            .current_dir(cwd)
            .output()
            .map_err(|e| e.to_string())
    }
}

// Test mock
#[cfg(test)]
pub struct MockExecutor {
    responses: HashMap<String, Output>,
}
```

#### 1.3 CI/CD Integration

**GitHub Actions Workflow (`.github/workflows/test.yml`):**
```yaml
name: Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  frontend-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v4

  backend-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - run: cargo test --manifest-path src-tauri/Cargo.toml
```

### Effort Estimate

| Task | Effort |
|------|--------|
| Setup Vitest + React Testing Library | 2-3 hours |
| Mock Tauri invoke layer | 3-4 hours |
| Write 10-15 component tests | 8-12 hours |
| Setup Rust test infrastructure | 2-3 hours |
| Create command executor trait + mocks | 4-6 hours |
| Write 10-15 Rust unit tests | 8-12 hours |
| CI/CD workflow setup | 2-3 hours |
| **Total** | **30-45 hours** |

### Success Criteria
- [ ] 60%+ frontend code coverage
- [ ] 40%+ backend code coverage
- [ ] All tests pass in CI before merge
- [ ] No regressions in existing functionality

---

## 2. Telemetry & Logging

### Current State
- **Rust backend**: 9 `eprintln!()` calls, no structured logging
- **React frontend**: 3 `console.log/error` calls, no error tracking
- **No telemetry**: Cannot measure feature usage, success rates, or performance

### Proposed Implementation

#### 2.1 Structured Logging (Rust Backend)

**Framework: `tracing` + `tracing-subscriber`**

The `tracing` crate is the Rust ecosystem standard for structured, async-aware logging.

```toml
# Cargo.toml additions
[dependencies]
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["json", "env-filter"] }
tracing-appender = "0.2"
```

**Implementation:**

```rust
// src-tauri/src/logging.rs
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use std::path::PathBuf;

pub fn init_logging(log_dir: PathBuf) -> Result<(), String> {
    let file_appender = RollingFileAppender::new(
        Rotation::DAILY,
        log_dir,
        "ship-studio.log"
    );

    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("ship_studio=info")))
        .with(tracing_subscriber::fmt::layer()
            .json()
            .with_writer(non_blocking))
        .init();

    Ok(())
}
```

**Usage Pattern:**
```rust
use tracing::{info, warn, error, instrument, span, Level};

#[instrument(skip(project_path), fields(project = %project_path.display()))]
pub async fn git_status(project_path: PathBuf) -> Result<GitStatus, String> {
    info!("Checking git status");

    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&project_path)
        .output();

    match output {
        Ok(out) => {
            info!(exit_code = out.status.code(), "Git status completed");
            // ...
        }
        Err(e) => {
            error!(error = %e, "Git status failed");
            Err(e.to_string())
        }
    }
}
```

**Log Levels by Category:**

| Category | Level | Example |
|----------|-------|---------|
| User actions | INFO | "Publishing to staging" |
| Operation results | INFO | "Git push completed" |
| Performance metrics | DEBUG | "Command took 1.2s" |
| Expected errors | WARN | "Auth token expired" |
| Unexpected errors | ERROR | "Command execution failed" |
| Internal details | TRACE | "Parsing git output" |

#### 2.2 Frontend Logging

**Framework: Custom logging service + optional Sentry**

```typescript
// src/lib/logger.ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

class Logger {
  private buffer: LogEntry[] = [];
  private maxBuffer = 100;

  private log(level: LogLevel, message: string, context?: Record<string, unknown>) {
    const entry: LogEntry = {
      level,
      message,
      context,
      timestamp: new Date().toISOString()
    };

    // Console output in development
    if (import.meta.env.DEV) {
      const fn = level === 'error' ? console.error :
                 level === 'warn' ? console.warn : console.log;
      fn(`[${level.toUpperCase()}]`, message, context || '');
    }

    // Buffer for potential transmission
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.shift();
    }
  }

  debug(message: string, context?: Record<string, unknown>) {
    this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>) {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.log('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>) {
    this.log('error', message, context);
  }

  // Send buffered logs to backend for persistence
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const logs = [...this.buffer];
    this.buffer = [];
    await invoke('save_frontend_logs', { logs });
  }
}

export const logger = new Logger();
```

**Usage:**
```typescript
// In components
import { logger } from '@/lib/logger';

const handlePublish = async () => {
  logger.info('Starting publish', { branch, environment });
  try {
    await publish(branch);
    logger.info('Publish completed', { branch, environment });
  } catch (error) {
    logger.error('Publish failed', { branch, error: String(error) });
    throw error;
  }
};
```

#### 2.3 Telemetry (Optional, Opt-in)

**Privacy-Respecting Approach:**
- Opt-in only (default off)
- No PII collection
- Local aggregation before transmission
- Clear documentation of what's collected

**Metrics to Track:**

| Metric | Type | Purpose |
|--------|------|---------|
| `publish.count` | Counter | Feature usage |
| `publish.success_rate` | Ratio | Reliability tracking |
| `git.command_duration_ms` | Histogram | Performance baseline |
| `app.session_duration_s` | Gauge | Engagement |
| `error.count` | Counter | Error tracking |

**Implementation (Rust):**
```rust
// src-tauri/src/telemetry.rs
use std::collections::HashMap;
use std::sync::Mutex;
use once_cell::sync::Lazy;

static METRICS: Lazy<Mutex<HashMap<String, i64>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub fn increment(metric: &str) {
    if let Ok(mut metrics) = METRICS.lock() {
        *metrics.entry(metric.to_string()).or_insert(0) += 1;
    }
}

pub fn record_duration(metric: &str, duration_ms: u64) {
    // Store in histogram buckets locally
}

// Tauri command to get metrics (for debugging/display)
#[tauri::command]
pub fn get_metrics() -> HashMap<String, i64> {
    METRICS.lock().map(|m| m.clone()).unwrap_or_default()
}
```

### File Locations

| Purpose | Location |
|---------|----------|
| Application logs | `~/Library/Logs/ShipStudio/` (macOS) |
| Metrics data | `~/.shipstudio/metrics.json` |
| User preferences | `~/.shipstudio/preferences.json` |

### Effort Estimate

| Task | Effort |
|------|--------|
| Setup tracing + tracing-subscriber | 2-3 hours |
| Add logging to all Rust commands | 6-8 hours |
| Create frontend logger service | 2-3 hours |
| Add logging to React components | 4-6 hours |
| Telemetry infrastructure (optional) | 4-6 hours |
| Log viewer UI (optional) | 4-6 hours |
| **Total** | **18-32 hours** |

### Success Criteria
- [ ] All Rust commands emit structured logs
- [ ] Logs persist to file with daily rotation
- [ ] Frontend errors captured with context
- [ ] Can diagnose issues from logs alone

---

## 3. Exponential Backoff for Polling

### Current State

Five polling locations with **fixed intervals**:

| Location | Interval | Purpose |
|----------|----------|---------|
| `PublishBranchDropdown.tsx:119` | 3s | Deployment status |
| `Preview.tsx:171` | 5s | Page list refresh |
| `Preview.tsx:183` | 5s | Sanity detection |
| `Preview.tsx:241` | 10s | Dev server health |
| `App.tsx:268` | 5min | Screenshot capture |

**Problems:**
- Fixed intervals waste resources when things are stable
- No backoff on failures (hammers failing endpoints)
- No adaptive behavior based on rate limits or network state

### Proposed Implementation

#### 3.1 Create Polling Utilities

```typescript
// src/lib/polling.ts

interface PollingOptions {
  initialInterval: number;    // Starting interval in ms
  maxInterval: number;        // Maximum interval in ms
  multiplier: number;         // Backoff multiplier (default 2)
  maxRetries?: number;        // Optional max retry count
  resetOnSuccess?: boolean;   // Reset interval on success (default true)
  jitter?: boolean;           // Add randomness to prevent thundering herd
}

interface PollingResult<T> {
  data: T | null;
  error: Error | null;
  attempt: number;
  nextInterval: number;
}

class ExponentialPoller<T> {
  private interval: number;
  private attempt = 0;
  private timeoutId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private fetcher: () => Promise<T>,
    private onResult: (result: PollingResult<T>) => void,
    private options: PollingOptions
  ) {
    this.interval = options.initialInterval;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.poll();
  }

  stop() {
    this.isRunning = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  reset() {
    this.interval = this.options.initialInterval;
    this.attempt = 0;
  }

  private async poll() {
    if (!this.isRunning) return;

    this.attempt++;

    try {
      const data = await this.fetcher();

      // Success - optionally reset interval
      if (this.options.resetOnSuccess !== false) {
        this.interval = this.options.initialInterval;
      }

      this.onResult({
        data,
        error: null,
        attempt: this.attempt,
        nextInterval: this.interval
      });
    } catch (error) {
      // Failure - apply exponential backoff
      this.interval = Math.min(
        this.interval * this.options.multiplier,
        this.options.maxInterval
      );

      this.onResult({
        data: null,
        error: error as Error,
        attempt: this.attempt,
        nextInterval: this.interval
      });

      // Check max retries
      if (this.options.maxRetries && this.attempt >= this.options.maxRetries) {
        this.stop();
        return;
      }
    }

    // Schedule next poll with optional jitter
    let delay = this.interval;
    if (this.options.jitter) {
      delay = delay * (0.5 + Math.random()); // ±50% jitter
    }

    this.timeoutId = setTimeout(() => this.poll(), delay);
  }
}

// React hook wrapper
export function useExponentialPolling<T>(
  fetcher: () => Promise<T>,
  options: PollingOptions,
  deps: React.DependencyList = []
): { data: T | null; error: Error | null; isPolling: boolean; reset: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const pollerRef = useRef<ExponentialPoller<T> | null>(null);

  useEffect(() => {
    const poller = new ExponentialPoller(fetcher, (result) => {
      setData(result.data);
      setError(result.error);
    }, options);

    pollerRef.current = poller;
    setIsPolling(true);
    poller.start();

    return () => {
      poller.stop();
      setIsPolling(false);
    };
  }, deps);

  const reset = useCallback(() => {
    pollerRef.current?.reset();
  }, []);

  return { data, error, isPolling, reset };
}
```

#### 3.2 Migration Plan

**Deployment Status Polling (`PublishBranchDropdown.tsx`):**
```typescript
// Before
const intervalId = setInterval(async () => {
  const deployments = await listVercelDeployments(projectId);
  // ...
}, 3000);

// After
const { data: deployments, error } = useExponentialPolling(
  () => listVercelDeployments(projectId!),
  {
    initialInterval: 2000,   // Start faster
    maxInterval: 15000,      // Back off to 15s max
    multiplier: 1.5,         // Gradual backoff
    jitter: true,            // Prevent thundering herd
  },
  [projectId, isDeploying]
);
```

**Page List Refresh (`Preview.tsx`):**
```typescript
// Before
const intervalId = setInterval(() => listPages(), 5000);

// After - Adaptive polling based on stability
const { data: pages } = useExponentialPolling(
  () => listPages(project.path),
  {
    initialInterval: 2000,    // Check quickly at first
    maxInterval: 30000,       // Slow to 30s when stable
    multiplier: 1.3,          // Gradual slowdown
    resetOnSuccess: false,    // Don't reset on every success
  },
  [project.path]
);

// Reset interval when user makes changes
useEffect(() => {
  if (hasUnsavedChanges) {
    resetPolling();
  }
}, [hasUnsavedChanges]);
```

**Dev Server Health (`Preview.tsx`):**
```typescript
const { error: healthError, reset: resetHealthCheck } = useExponentialPolling(
  () => checkDevServerHealth(port),
  {
    initialInterval: 1000,    // Check quickly at first
    maxInterval: 10000,       // Max 10s between checks
    multiplier: 2,            // Standard exponential
    maxRetries: 60,           // Give up after ~5 minutes
  },
  [port, devServerState]
);
```

### Effort Estimate

| Task | Effort |
|------|--------|
| Create polling utility + hook | 3-4 hours |
| Migrate deployment polling | 2-3 hours |
| Migrate page list polling | 1-2 hours |
| Migrate health check polling | 1-2 hours |
| Migrate Sanity detection | 1 hour |
| Testing and edge cases | 2-3 hours |
| **Total** | **10-15 hours** |

### Success Criteria
- [ ] All polling uses exponential backoff
- [ ] Network failures don't cause request storms
- [ ] Resource usage drops when app is idle
- [ ] Polling resets appropriately on user action

---

## 4. Git Command Result Caching

### Current State

Git commands are executed fresh every time, even for data that changes infrequently:
- `git status` called on every render cycle
- Branch list fetched repeatedly
- Remote URL checked multiple times

### Proposed Implementation

#### 4.1 Caching Strategy

**Cache Categories:**

| Category | TTL | Invalidation |
|----------|-----|--------------|
| Branch list | 30s | On branch create/delete/checkout |
| Remote URLs | 5min | On remote add/remove |
| Git status | 2s | On any file change |
| Commit history | 1min | On commit/push/pull |

#### 4.2 Rust-Side Caching

```rust
// src-tauri/src/cache.rs
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};
use once_cell::sync::Lazy;

struct CacheEntry<T> {
    value: T,
    created_at: Instant,
    ttl: Duration,
}

impl<T> CacheEntry<T> {
    fn is_valid(&self) -> bool {
        self.created_at.elapsed() < self.ttl
    }
}

pub struct GitCache {
    branches: RwLock<HashMap<String, CacheEntry<Vec<BranchInfo>>>>,
    status: RwLock<HashMap<String, CacheEntry<GitStatus>>>,
    remotes: RwLock<HashMap<String, CacheEntry<Vec<String>>>>,
}

static GIT_CACHE: Lazy<GitCache> = Lazy::new(|| GitCache {
    branches: RwLock::new(HashMap::new()),
    status: RwLock::new(HashMap::new()),
    remotes: RwLock::new(HashMap::new()),
});

impl GitCache {
    pub fn get_branches(&self, project_path: &str) -> Option<Vec<BranchInfo>> {
        let cache = self.branches.read().ok()?;
        let entry = cache.get(project_path)?;
        if entry.is_valid() {
            Some(entry.value.clone())
        } else {
            None
        }
    }

    pub fn set_branches(&self, project_path: &str, branches: Vec<BranchInfo>, ttl: Duration) {
        if let Ok(mut cache) = self.branches.write() {
            cache.insert(project_path.to_string(), CacheEntry {
                value: branches,
                created_at: Instant::now(),
                ttl,
            });
        }
    }

    pub fn invalidate_branches(&self, project_path: &str) {
        if let Ok(mut cache) = self.branches.write() {
            cache.remove(project_path);
        }
    }

    pub fn invalidate_all(&self, project_path: &str) {
        self.invalidate_branches(project_path);
        self.invalidate_status(project_path);
        self.invalidate_remotes(project_path);
    }
}

// Usage in commands
#[tauri::command]
pub async fn list_branches(project_path: PathBuf) -> Result<Vec<BranchInfo>, String> {
    let path_str = project_path.to_string_lossy().to_string();

    // Check cache first
    if let Some(cached) = GIT_CACHE.get_branches(&path_str) {
        return Ok(cached);
    }

    // Fetch fresh data
    let branches = fetch_branches_from_git(&project_path)?;

    // Cache for 30 seconds
    GIT_CACHE.set_branches(&path_str, branches.clone(), Duration::from_secs(30));

    Ok(branches)
}

// Invalidation on mutations
#[tauri::command]
pub async fn checkout_branch(project_path: PathBuf, branch: String) -> Result<(), String> {
    let path_str = project_path.to_string_lossy().to_string();

    // Perform checkout
    execute_git_checkout(&project_path, &branch)?;

    // Invalidate relevant caches
    GIT_CACHE.invalidate_branches(&path_str);
    GIT_CACHE.invalidate_status(&path_str);

    Ok(())
}
```

#### 4.3 File System Watcher for Smart Invalidation

```rust
// src-tauri/src/watcher.rs
use notify::{Watcher, RecursiveMode, watcher, DebouncedEvent};
use std::sync::mpsc::channel;
use std::time::Duration;

pub fn watch_project(project_path: PathBuf) -> Result<(), String> {
    let (tx, rx) = channel();

    let mut watcher = watcher(tx, Duration::from_millis(500))
        .map_err(|e| e.to_string())?;

    // Watch .git directory for branch/commit changes
    watcher.watch(project_path.join(".git"), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // Watch project files for status changes
    watcher.watch(&project_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        loop {
            match rx.recv() {
                Ok(event) => handle_fs_event(event, &project_path),
                Err(_) => break,
            }
        }
    });

    Ok(())
}

fn handle_fs_event(event: DebouncedEvent, project_path: &Path) {
    let path_str = project_path.to_string_lossy().to_string();

    match event {
        DebouncedEvent::Write(path) | DebouncedEvent::Create(path) | DebouncedEvent::Remove(path) => {
            if path.starts_with(project_path.join(".git/refs")) {
                // Branch/tag change
                GIT_CACHE.invalidate_branches(&path_str);
            } else if path.starts_with(project_path.join(".git/index")) {
                // Staging area change
                GIT_CACHE.invalidate_status(&path_str);
            } else if !path.starts_with(project_path.join(".git")) {
                // Working directory change
                GIT_CACHE.invalidate_status(&path_str);
            }
        }
        _ => {}
    }
}
```

#### 4.4 Frontend Cache Layer

```typescript
// src/lib/cache.ts
interface CacheEntry<T> {
  value: T;
  timestamp: number;
  ttl: number;
}

class QueryCache {
  private cache = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set<T>(key: string, value: T, ttl: number) {
    this.cache.set(key, { value, timestamp: Date.now(), ttl });
  }

  invalidate(pattern: string | RegExp) {
    for (const key of this.cache.keys()) {
      if (typeof pattern === 'string' ? key.includes(pattern) : pattern.test(key)) {
        this.cache.delete(key);
      }
    }
  }
}

export const queryCache = new QueryCache();

// Usage in lib functions
export async function listBranches(projectPath: string): Promise<BranchInfo[]> {
  const cacheKey = `branches:${projectPath}`;

  const cached = queryCache.get<BranchInfo[]>(cacheKey);
  if (cached) return cached;

  const branches = await invoke<BranchInfo[]>('list_branches', { projectPath });
  queryCache.set(cacheKey, branches, 30000); // 30s TTL

  return branches;
}
```

### Effort Estimate

| Task | Effort |
|------|--------|
| Design cache architecture | 2-3 hours |
| Implement Rust cache module | 4-6 hours |
| Add file system watcher | 4-6 hours |
| Integrate caching into git commands | 4-6 hours |
| Frontend cache layer | 2-3 hours |
| Testing cache invalidation | 3-4 hours |
| **Total** | **20-28 hours** |

### Success Criteria
- [ ] Repeated git operations hit cache >80% of time
- [ ] Cache invalidates correctly on mutations
- [ ] No stale data shown to users
- [ ] Measurable reduction in git subprocess spawning

---

## 5. git2-rs Library Migration

### Current State

All git operations use subprocess calls to the `git` CLI:
```rust
Command::new("git")
    .args(["status", "--porcelain"])
    .current_dir(&project_path)
    .output()
```

**Problems:**
- Subprocess overhead for every operation
- Brittle string parsing of git output
- Difficult to handle edge cases
- No compile-time guarantees on git semantics

### Proposed Approach: Hybrid Migration

**Recommendation: Keep CLI for complex operations, use git2-rs for simple queries**

The `git2` library (Rust bindings to libgit2) is excellent for read operations but has limitations for some workflows that the CLI handles better.

#### 5.1 Candidates for git2-rs

**Good candidates (read-only, well-supported by libgit2):**

| Operation | Current | git2-rs |
|-----------|---------|---------|
| Get current branch | `git rev-parse --abbrev-ref HEAD` | `repo.head()?.shorthand()` |
| List local branches | `git branch --format=...` | `repo.branches(Some(BranchType::Local))` |
| Check if dirty | `git status --porcelain` | `repo.statuses(None)` |
| Get commit info | `git log --oneline -1` | `repo.head()?.peel_to_commit()` |
| Check remote URL | `git remote get-url origin` | `repo.find_remote("origin")?.url()` |

**Keep using CLI:**

| Operation | Reason |
|-----------|--------|
| `git fetch` | Network operations, auth handling |
| `git push/pull` | Complex merge/rebase scenarios |
| `git stash` | libgit2 stash API is limited |
| `git checkout` | Branch switching with worktree handling |
| Merge conflict resolution | CLI handles this better |

#### 5.2 Implementation

```toml
# Cargo.toml addition
[dependencies]
git2 = "0.19"
```

```rust
// src-tauri/src/commands/git2_ops.rs
use git2::{Repository, StatusOptions, BranchType, ErrorCode};
use std::path::Path;

/// Get the current branch name using git2
pub fn current_branch(project_path: &Path) -> Result<String, String> {
    let repo = Repository::open(project_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let head = repo.head()
        .map_err(|e| format!("Failed to get HEAD: {}", e))?;

    head.shorthand()
        .map(|s| s.to_string())
        .ok_or_else(|| "HEAD is not a branch".to_string())
}

/// Check if repository has uncommitted changes
pub fn has_changes(project_path: &Path) -> Result<bool, String> {
    let repo = Repository::open(project_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true);

    let statuses = repo.statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to get status: {}", e))?;

    Ok(!statuses.is_empty())
}

/// List all local branches with metadata
pub fn list_local_branches(project_path: &Path) -> Result<Vec<LocalBranch>, String> {
    let repo = Repository::open(project_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let branches = repo.branches(Some(BranchType::Local))
        .map_err(|e| format!("Failed to list branches: {}", e))?;

    let current = current_branch(project_path).ok();

    branches
        .filter_map(|b| b.ok())
        .map(|(branch, _)| {
            let name = branch.name()?.unwrap_or("").to_string();
            let is_current = current.as_ref() == Some(&name);

            let commit = branch.get().peel_to_commit().ok()?;
            let message = commit.summary().unwrap_or("").to_string();
            let timestamp = commit.time().seconds();

            Some(LocalBranch {
                name,
                is_current,
                last_commit_message: message,
                last_commit_timestamp: timestamp,
            })
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| "Failed to collect branches".to_string())
}

/// Get detailed status of working directory
pub fn detailed_status(project_path: &Path) -> Result<WorkingDirectoryStatus, String> {
    let repo = Repository::open(project_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to get status: {}", e))?;

    let mut staged = Vec::new();
    let mut modified = Vec::new();
    let mut untracked = Vec::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let status = entry.status();

        if status.is_index_new() || status.is_index_modified() || status.is_index_deleted() {
            staged.push(path.clone());
        }
        if status.is_wt_modified() || status.is_wt_deleted() {
            modified.push(path.clone());
        }
        if status.is_wt_new() {
            untracked.push(path);
        }
    }

    Ok(WorkingDirectoryStatus {
        staged,
        modified,
        untracked,
        has_changes: !staged.is_empty() || !modified.is_empty() || !untracked.is_empty(),
    })
}
```

#### 5.3 Migration Strategy

**Phase 1: Add git2 alongside CLI (Low Risk)**
- Keep all existing CLI commands working
- Add git2 versions of read-only operations
- Feature flag to switch between implementations
- Compare outputs to verify correctness

**Phase 2: Gradual Migration**
- Replace CLI calls one-by-one after verification
- Start with simplest operations (current_branch, has_changes)
- Keep CLI for complex operations indefinitely

**Phase 3: Optimization**
- Use git2's caching (Repository object reuse)
- Batch operations where possible
- Remove subprocess overhead for hot paths

### Trade-offs

| Aspect | CLI | git2-rs |
|--------|-----|---------|
| **Startup cost** | Fork subprocess each call | Open repo object (can cache) |
| **Correctness** | Battle-tested | Needs verification |
| **Features** | Full git functionality | ~80% coverage |
| **Error handling** | Parse stderr strings | Typed errors |
| **Auth** | Uses git config/credential helpers | Requires custom callback setup |
| **Binary size** | None (system git) | +2-3MB for libgit2 |

### Effort Estimate

| Task | Effort |
|------|--------|
| Add git2 dependency, basic setup | 1-2 hours |
| Implement read-only operations | 6-8 hours |
| Add feature flag infrastructure | 2-3 hours |
| Verification testing (compare CLI vs git2) | 4-6 hours |
| Migrate hot-path operations | 4-6 hours |
| Documentation | 2-3 hours |
| **Total** | **20-28 hours** |

### Success Criteria
- [ ] git2 operations produce identical results to CLI
- [ ] No increase in error rates
- [ ] Measurable performance improvement for read operations
- [ ] Binary size increase acceptable (<5MB)

### Recommendation

**Start with caching (Improvement #4) before git2-rs migration.**

Caching provides 80% of the performance benefit with 20% of the risk. The git2-rs migration is a "nice to have" that can be deferred until caching proves insufficient.

---

## Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2)
1. **Telemetry/Logging** - Essential for debugging all other work
2. **Exponential Backoff** - Quick win, immediate reliability improvement

### Phase 2: Quality (Weeks 3-5)
3. **Automated Tests** - Enable confident refactoring
4. **Git Caching** - Performance optimization

### Phase 3: Optimization (Week 6+)
5. **git2-rs** - Only if performance still insufficient

### Dependency Graph

```
                    ┌─────────────────────┐
                    │  Telemetry/Logging  │
                    └──────────┬──────────┘
                               │
           ┌───────────────────┼───────────────────┐
           │                   │                   │
           ▼                   ▼                   ▼
    ┌──────────────┐  ┌───────────────┐  ┌────────────────┐
    │ Exp. Backoff │  │ Automated     │  │ Git Caching    │
    └──────────────┘  │ Tests         │  └───────┬────────┘
                      └───────────────┘          │
                                                 │
                                                 ▼
                                        ┌────────────────┐
                                        │ git2-rs       │
                                        │ (optional)    │
                                        └────────────────┘
```

---

## Appendix: Quick Reference

### Commands to Add (package.json)

```json
{
  "scripts": {
    "test": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:ui": "vitest --ui"
  }
}
```

### Dependencies to Add

**Frontend (package.json):**
```json
{
  "devDependencies": {
    "vitest": "^2.0.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.0.0",
    "@testing-library/user-event": "^14.0.0",
    "@vitest/coverage-v8": "^2.0.0",
    "jsdom": "^25.0.0"
  }
}
```

**Backend (Cargo.toml):**
```toml
[dependencies]
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["json", "env-filter"] }
tracing-appender = "0.2"
git2 = "0.19"  # Optional, for Phase 3

[dev-dependencies]
mockall = "0.13"
tempfile = "3.15"
```

### File Structure After Improvements

```
src-tauri/src/
├── lib.rs
├── logging.rs           # NEW: Tracing setup
├── cache.rs             # NEW: Git result caching
├── telemetry.rs         # NEW: Metrics collection
├── commands/
│   ├── git.rs
│   ├── git_tests.rs     # NEW: Git command tests
│   ├── git2_ops.rs      # NEW: git2-rs operations
│   └── ...
└── test_utils.rs        # NEW: Shared test helpers

src/
├── lib/
│   ├── polling.ts       # NEW: Exponential backoff utilities
│   ├── logger.ts        # NEW: Frontend logging
│   ├── cache.ts         # NEW: Query caching
│   └── ...
├── test/
│   └── setup.ts         # NEW: Test configuration
└── components/
    └── __tests__/       # NEW: Component tests
```
