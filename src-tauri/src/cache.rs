//! # Git Command Cache
//!
//! Provides caching for git command results to reduce subprocess calls.
//! Cache entries have a TTL and can be invalidated on write operations.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use once_cell::sync::Lazy;
use tracing::debug;

/// Cache entry with value and expiration time
#[derive(Clone)]
struct CacheEntry<T: Clone> {
    value: T,
    expires_at: Instant,
}

impl<T: Clone> CacheEntry<T> {
    fn new(value: T, ttl: Duration) -> Self {
        Self {
            value,
            expires_at: Instant::now() + ttl,
        }
    }

    fn is_expired(&self) -> bool {
        Instant::now() >= self.expires_at
    }
}

/// Git command cache with TTL support
pub struct GitCache {
    /// Cache for current branch per project
    current_branch: Mutex<HashMap<String, CacheEntry<String>>>,
    /// Cache for has-changes status per project
    has_changes: Mutex<HashMap<String, CacheEntry<bool>>>,
    /// Cache for changed files per project
    changed_files: Mutex<HashMap<String, CacheEntry<Vec<crate::types::ChangedFile>>>>,
    /// TTL for branch cache (longer, branch changes less frequently)
    branch_ttl: Duration,
    /// TTL for status cache (shorter, status changes more frequently)
    status_ttl: Duration,
}

impl GitCache {
    fn new() -> Self {
        Self {
            current_branch: Mutex::new(HashMap::new()),
            has_changes: Mutex::new(HashMap::new()),
            changed_files: Mutex::new(HashMap::new()),
            branch_ttl: Duration::from_secs(30),
            status_ttl: Duration::from_secs(5),
        }
    }

    /// Get cached current branch for a project
    pub fn get_current_branch(&self, project_path: &str) -> Option<String> {
        let cache = self.current_branch.lock().ok()?;
        let entry = cache.get(project_path)?;
        if entry.is_expired() {
            debug!(project = project_path, "Current branch cache expired");
            None
        } else {
            debug!(project = project_path, "Current branch cache hit");
            Some(entry.value.clone())
        }
    }

    /// Set cached current branch for a project
    pub fn set_current_branch(&self, project_path: &str, branch: String) {
        if let Ok(mut cache) = self.current_branch.lock() {
            debug!(project = project_path, branch = %branch, "Caching current branch");
            cache.insert(
                project_path.to_string(),
                CacheEntry::new(branch, self.branch_ttl),
            );
        }
    }

    /// Get cached has-changes status for a project
    pub fn get_has_changes(&self, project_path: &str) -> Option<bool> {
        let cache = self.has_changes.lock().ok()?;
        let entry = cache.get(project_path)?;
        if entry.is_expired() {
            debug!(project = project_path, "Has-changes cache expired");
            None
        } else {
            debug!(project = project_path, "Has-changes cache hit");
            Some(entry.value)
        }
    }

    /// Set cached has-changes status for a project
    pub fn set_has_changes(&self, project_path: &str, has_changes: bool) {
        if let Ok(mut cache) = self.has_changes.lock() {
            debug!(project = project_path, has_changes, "Caching has-changes status");
            cache.insert(
                project_path.to_string(),
                CacheEntry::new(has_changes, self.status_ttl),
            );
        }
    }

    /// Get cached changed files for a project
    pub fn get_changed_files(&self, project_path: &str) -> Option<Vec<crate::types::ChangedFile>> {
        let cache = self.changed_files.lock().ok()?;
        let entry = cache.get(project_path)?;
        if entry.is_expired() {
            debug!(project = project_path, "Changed files cache expired");
            None
        } else {
            debug!(project = project_path, "Changed files cache hit");
            Some(entry.value.clone())
        }
    }

    /// Set cached changed files for a project
    pub fn set_changed_files(&self, project_path: &str, files: Vec<crate::types::ChangedFile>) {
        if let Ok(mut cache) = self.changed_files.lock() {
            debug!(project = project_path, file_count = files.len(), "Caching changed files");
            cache.insert(
                project_path.to_string(),
                CacheEntry::new(files, self.status_ttl),
            );
        }
    }

    /// Invalidate all caches for a project (call after write operations)
    pub fn invalidate(&self, project_path: &str) {
        debug!(project = project_path, "Invalidating all caches");
        if let Ok(mut cache) = self.current_branch.lock() {
            cache.remove(project_path);
        }
        if let Ok(mut cache) = self.has_changes.lock() {
            cache.remove(project_path);
        }
        if let Ok(mut cache) = self.changed_files.lock() {
            cache.remove(project_path);
        }
    }

    /// Invalidate status caches (branch stays valid, but status changes)
    pub fn invalidate_status(&self, project_path: &str) {
        debug!(project = project_path, "Invalidating status caches");
        if let Ok(mut cache) = self.has_changes.lock() {
            cache.remove(project_path);
        }
        if let Ok(mut cache) = self.changed_files.lock() {
            cache.remove(project_path);
        }
    }

    /// Clean up expired entries from all caches
    pub fn cleanup_expired(&self) {
        if let Ok(mut cache) = self.current_branch.lock() {
            cache.retain(|_, entry| !entry.is_expired());
        }
        if let Ok(mut cache) = self.has_changes.lock() {
            cache.retain(|_, entry| !entry.is_expired());
        }
        if let Ok(mut cache) = self.changed_files.lock() {
            cache.retain(|_, entry| !entry.is_expired());
        }
    }
}

/// Global git cache instance
pub static GIT_CACHE: Lazy<GitCache> = Lazy::new(GitCache::new);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_set_and_get() {
        let cache = GitCache::new();

        cache.set_current_branch("/test/project", "main".to_string());
        let result = cache.get_current_branch("/test/project");
        assert_eq!(result, Some("main".to_string()));
    }

    #[test]
    fn test_cache_miss_for_unknown_project() {
        let cache = GitCache::new();

        let result = cache.get_current_branch("/unknown/project");
        assert_eq!(result, None);
    }

    #[test]
    fn test_cache_invalidation() {
        let cache = GitCache::new();

        cache.set_current_branch("/test/project", "main".to_string());
        cache.set_has_changes("/test/project", true);

        cache.invalidate("/test/project");

        assert_eq!(cache.get_current_branch("/test/project"), None);
        assert_eq!(cache.get_has_changes("/test/project"), None);
    }

    #[test]
    fn test_status_invalidation_preserves_branch() {
        let cache = GitCache::new();

        cache.set_current_branch("/test/project", "main".to_string());
        cache.set_has_changes("/test/project", true);

        cache.invalidate_status("/test/project");

        // Branch should still be cached
        assert_eq!(cache.get_current_branch("/test/project"), Some("main".to_string()));
        // Status should be invalidated
        assert_eq!(cache.get_has_changes("/test/project"), None);
    }

    #[test]
    fn test_has_changes_cache() {
        let cache = GitCache::new();

        cache.set_has_changes("/test/project", true);
        assert_eq!(cache.get_has_changes("/test/project"), Some(true));

        cache.set_has_changes("/test/project", false);
        assert_eq!(cache.get_has_changes("/test/project"), Some(false));
    }
}
