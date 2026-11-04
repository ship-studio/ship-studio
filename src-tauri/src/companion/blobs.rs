//! Files between the phone and the Mac, kept off the socket.
//!
//! Two kinds of blob, both staged in one owner-only folder and both gone
//! after an hour:
//!
//! - **Uploads** (`PUT /v1/blobs`): a file the phone is about to attach. An
//!   `agents.send` naming it hands the staged copy to the desktop's own
//!   `attachments::save`, so the limits, name cleaning and prompt block are
//!   the desk's; the blob is consumed once the send succeeds.
//! - **Produced** (`agents.fetchPath`): a file on the Mac an agent's reply
//!   pointed at, copied here so the phone downloads a snapshot of it from
//!   `GET /v1/blobs/:id`.
//!
//! A blob belongs to the device that made it; no other device can read,
//! send or even learn of it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::agents::attachments::{self, MAX_FILE_BYTES};
use crate::errors::CommandError;

/// How long a staged blob lives.
pub const BLOB_TTL_MS: u64 = 60 * 60 * 1000;
/// Staged at once per device: a full message (10 files) twice over, plus a
/// few fetched files.
pub const MAX_BLOBS_PER_DEVICE: usize = 30;
/// Bytes staged at once per device.
pub const MAX_BYTES_PER_DEVICE: u64 = 300 * 1024 * 1024;

/// `BlobRef` in methods.ts.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlobRef {
    pub blob_id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct Blob {
    pub id: String,
    pub device_id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub path: PathBuf,
    pub created: u64,
}

impl Blob {
    pub fn as_ref(&self) -> BlobRef {
        BlobRef {
            blob_id: self.id.clone(),
            name: self.name.clone(),
            mime: self.mime.clone(),
            size: self.size,
        }
    }
}

pub struct Blobs {
    dir: PathBuf,
    /// Removed with the store (tests); the desktop's folder is kept.
    temporary: bool,
    map: Mutex<HashMap<String, Blob>>,
}

/// A user-facing refusal: too big, too many, not found.
fn expected(message: impl Into<String>) -> CommandError {
    CommandError::expected(message)
}

pub fn too_big_message(name: &str) -> String {
    format!(
        "{name} is over {} MB, the most a file can be.",
        MAX_FILE_BYTES / (1024 * 1024)
    )
}

impl Blobs {
    pub fn new(dir: PathBuf) -> Self {
        // Whatever an earlier run staged has expired with it.
        let _ = std::fs::remove_dir_all(&dir);
        Blobs {
            dir,
            temporary: false,
            map: Mutex::new(HashMap::new()),
        }
    }

    /// A store in its own temporary folder, removed on drop (tests).
    pub fn temporary() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "ss-companion-blobs-{}",
            uuid::Uuid::new_v4().simple()
        ));
        Blobs {
            dir,
            temporary: true,
            map: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Blob>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ensure_dir(&self) -> Result<(), CommandError> {
        std::fs::create_dir_all(&self.dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    /// Drop everything older than the TTL, files and all.
    pub fn sweep(&self, now: u64) {
        let expired: Vec<Blob> = {
            let mut map = self.lock();
            let ids: Vec<String> = map
                .values()
                .filter(|b| now.saturating_sub(b.created) >= BLOB_TTL_MS)
                .map(|b| b.id.clone())
                .collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        for b in expired {
            let _ = std::fs::remove_file(&b.path);
        }
    }

    /// Room for `size` more bytes for this device, or the sentence why not.
    fn admit(&self, device_id: &str, size: u64) -> Result<(), CommandError> {
        let map = self.lock();
        let mine = map.values().filter(|b| b.device_id == device_id);
        let (count, bytes) = mine.fold((0usize, 0u64), |(n, t), b| (n + 1, t + b.size));
        if count >= MAX_BLOBS_PER_DEVICE || bytes + size > MAX_BYTES_PER_DEVICE {
            return Err(expected(
                "Too many files are waiting to be sent from this phone. Send or wait an hour, then try again.",
            ));
        }
        Ok(())
    }

    fn insert(
        &self,
        device_id: &str,
        name: &str,
        mime: String,
        write: impl FnOnce(&Path) -> std::io::Result<u64>,
        now: u64,
    ) -> Result<Blob, CommandError> {
        self.ensure_dir()?;
        let id = format!("blob_{}", uuid::Uuid::new_v4().simple());
        let path = self.dir.join(&id);
        let size = match write(&path) {
            Ok(size) => size,
            Err(e) => {
                let _ = std::fs::remove_file(&path);
                return Err(e.into());
            }
        };
        let blob = Blob {
            id: id.clone(),
            device_id: device_id.to_string(),
            name: attachments::sanitize_name(name),
            mime,
            size,
            path,
            created: now,
        };
        self.lock().insert(id, blob.clone());
        Ok(blob)
    }

    /// Stage bytes the phone uploaded. `mime` is the upload's Content-Type,
    /// trusted only when it's a plain `type/subtype`.
    pub fn put(
        &self,
        device_id: &str,
        name: &str,
        mime: Option<&str>,
        bytes: &[u8],
        now: u64,
    ) -> Result<Blob, CommandError> {
        self.sweep(now);
        let name = attachments::sanitize_name(name);
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(expected(too_big_message(&name)));
        }
        self.admit(device_id, bytes.len() as u64)?;
        let mime = mime
            .map(|m| {
                m.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase()
            })
            .filter(|m| is_plain_mime(m) && m != "application/octet-stream")
            .unwrap_or_else(|| attachments::mime_for(&name).to_string());
        self.insert(
            device_id,
            &name,
            mime,
            |path| {
                write_private(path, bytes)?;
                Ok(bytes.len() as u64)
            },
            now,
        )
    }

    /// Copy a file on the Mac in for this device to download.
    pub fn produce(&self, device_id: &str, source: &Path, now: u64) -> Result<Blob, CommandError> {
        self.sweep(now);
        let name = source
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        let size = std::fs::metadata(source)?.len();
        if size > MAX_FILE_BYTES {
            return Err(expected(too_big_message(&name)));
        }
        self.admit(device_id, size)?;
        let mime = attachments::mime_for(&name).to_string();
        self.insert(
            device_id,
            &name,
            mime,
            |path| {
                let n = std::fs::copy(source, path)?;
                restrict(path)?;
                Ok(n)
            },
            now,
        )
    }

    /// This device's blob, if it has one by that id and it hasn't expired.
    pub fn get(&self, device_id: &str, id: &str, now: u64) -> Option<Blob> {
        self.sweep(now);
        self.lock()
            .get(id)
            .filter(|b| b.device_id == device_id)
            .cloned()
    }

    /// Forget blobs whose job is done (an upload after it was sent).
    pub fn consume(&self, ids: &[String]) {
        let gone: Vec<Blob> = {
            let mut map = self.lock();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        for b in gone {
            let _ = std::fs::remove_file(&b.path);
        }
    }

    /// Every blob a revoked device left behind.
    pub fn forget_device(&self, device_id: &str) {
        let ids: Vec<String> = self
            .lock()
            .values()
            .filter(|b| b.device_id == device_id)
            .map(|b| b.id.clone())
            .collect();
        self.consume(&ids);
    }
}

impl Drop for Blobs {
    fn drop(&mut self) {
        if self.temporary {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

fn is_plain_mime(m: &str) -> bool {
    let mut parts = m.split('/');
    let ok = |p: Option<&str>| {
        p.is_some_and(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
        })
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)?;
    restrict(path)
}

fn restrict(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blob_belongs_to_its_device_and_expires() {
        let b = Blobs::temporary();
        let blob = b
            .put("dev_a", "../photo.PNG", Some("image/png"), b"png", 0)
            .unwrap();
        assert_eq!(blob.name, "photo.PNG");
        assert_eq!(blob.mime, "image/png");
        assert!(b.get("dev_a", &blob.id, 1).is_some());
        assert!(
            b.get("dev_b", &blob.id, 1).is_none(),
            "another device's blob"
        );
        assert!(b.get("dev_a", &blob.id, BLOB_TTL_MS).is_none(), "expired");
        assert!(!blob.path.exists(), "its file goes with it");
    }

    #[test]
    fn mime_falls_back_to_the_name_and_ignores_junk() {
        let b = Blobs::temporary();
        let t = |mime: Option<&str>| b.put("d", "notes.md", mime, b"x", 0).unwrap().mime;
        assert_eq!(t(None), "text/markdown");
        assert_eq!(t(Some("application/octet-stream")), "text/markdown");
        assert_eq!(t(Some("text/plain; charset=utf-8")), "text/plain");
        assert_eq!(t(Some("text/html\r\nX: y")), "text/markdown");
    }

    #[test]
    fn a_device_has_a_staging_budget() {
        let b = Blobs::temporary();
        for _ in 0..MAX_BLOBS_PER_DEVICE {
            b.put("d", "a.txt", None, b"x", 0).unwrap();
        }
        assert!(b.put("d", "a.txt", None, b"x", 0).is_err());
        assert!(b.put("other", "a.txt", None, b"x", 0).is_ok());
        b.forget_device("d");
        assert!(b.put("d", "a.txt", None, b"x", 0).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn staged_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let b = Blobs::temporary();
        let blob = b.put("d", "a.txt", None, b"x", 0).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&blob.path), 0o600);
        assert_eq!(mode(blob.path.parent().unwrap()), 0o700);
    }
}
