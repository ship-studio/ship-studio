//! Project metadata read/write commands.
//!
//! Generic read/write of `.shipstudio/project.json`. Per-topic metadata
//! accessors live in sibling modules (`ui_state`, `dev_server`).

use crate::errors::CommandError;
use crate::types::ProjectMetadata;
use crate::utils::validate_project_path;

/// Persist `metadata` to `<project>/.shipstudio/project.json`, creating the
/// `.shipstudio` directory as needed.
///
/// Shared by every project.json writer (metadata, ui_state, dev_server,
/// shopify, thumbnail) so filesystem failures classify identically through
/// `classify_fs_error`: macOS TCC EPERM, Windows access-denied, and read-only
/// volumes become actionable `Expected` errors instead of a bare "Operation
/// not permitted (os error 1)" reaching telemetry (issue #625).
pub(crate) fn save_project_metadata(
    project: &std::path::Path,
    metadata: &ProjectMetadata,
) -> Result<(), CommandError> {
    let shipstudio_dir = project.join(".shipstudio");
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir).map_err(|e| {
            crate::utils::classify_fs_error(
                "create this project's .shipstudio folder",
                &shipstudio_dir,
                &e,
            )
        })?;
    }

    let metadata_path = shipstudio_dir.join("project.json");
    let contents = serde_json::to_string_pretty(metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| crate::utils::classify_fs_error("write project metadata", &metadata_path, &e))
}

/// Read `.shipstudio/project.json`, migrating it in place if the schema moved.
///
/// The synchronous half of [`read_project_metadata`], so non-command callers
/// (hosting link resolution, for one) share the same parse-and-migrate path
/// rather than re-implementing it and drifting.
pub(crate) fn read_project_metadata_sync(
    project: &std::path::Path,
) -> Result<Option<ProjectMetadata>, CommandError> {
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    let contents = std::fs::read_to_string(&metadata_path).map_err(|e| {
        crate::utils::classify_fs_error("read project metadata", &metadata_path, &e)
    })?;

    let mut metadata: ProjectMetadata = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse project metadata: {e}"))?;

    // Apply migrations if needed and save the updated metadata
    if metadata.migrate() {
        save_project_metadata(project, &metadata)?;
    }

    Ok(Some(metadata))
}

/// Reads project metadata from .shipstudio/project.json with automatic schema migration
#[ship_studio_macros::ship_command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn read_project_metadata(
    project_path: String,
) -> Result<Option<ProjectMetadata>, CommandError> {
    let project = validate_project_path(&project_path)?;
    read_project_metadata_sync(&project)
}

#[cfg(test)]
mod save_project_metadata_tests {
    use super::*;
    use crate::types::PROJECT_METADATA_SCHEMA_VERSION;

    #[test]
    fn roundtrips_metadata_and_creates_shipstudio_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let metadata = ProjectMetadata {
            custom_dev_command: Some("bun dev".to_string()),
            ..Default::default()
        };
        save_project_metadata(tmp.path(), &metadata).unwrap();

        let written = tmp.path().join(".shipstudio").join("project.json");
        let parsed: ProjectMetadata =
            serde_json::from_str(&std::fs::read_to_string(&written).unwrap()).unwrap();
        assert_eq!(parsed.custom_dev_command.as_deref(), Some("bun dev"));
    }

    /// The upgrade path every existing user takes on this release: a
    /// `.shipstudio/project.json` written by v3, carrying the `publish` block
    /// that schema v4 removed.
    ///
    /// This is the single most likely way the hosting rewrite breaks for
    /// someone who already has projects, so it is pinned against a real
    /// v3-shaped file rather than a constructed struct — the failure modes
    /// worth catching (a parse error on the removed key, a migration that
    /// resets sibling fields to defaults, a stale deployment URL surviving
    /// into something that reads it) all live in the bytes on disk.
    #[test]
    fn migrating_a_real_v3_file_keeps_everything_and_invents_nothing() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join(".shipstudio");
        std::fs::create_dir_all(&dir).unwrap();

        // Verbatim v3 shape, including the removed block with its stale URLs.
        let v3 = r#"{
  "_description": "Harbr project metadata. Auto-generated - safe to delete if needed, will be recreated.",
  "schema_version": 3,
  "last_opened": 1755000000000,
  "custom_dev_command": "pnpm dev",
  "dev_server_port": 3001,
  "account_id": "acct_work",
  "default_base_branch": "develop",
  "publish": {
    "staging": {
      "url": "https://acme-staging.vercel.app",
      "state": "READY",
      "publishedAt": 1754000000000
    },
    "production": {
      "url": "https://acme.com",
      "state": "READY",
      "publishedAt": 1754100000000
    }
  }
}"#;
        std::fs::write(dir.join("project.json"), v3).unwrap();

        // 1. It reads at all. A removed field must not be a parse error.
        let metadata = read_project_metadata_sync(tmp.path())
            .expect("a v3 file must not fail to parse")
            .expect("the file exists, so this is Some");

        // 2. It is stamped as current.
        assert_eq!(metadata.schema_version, PROJECT_METADATA_SCHEMA_VERSION);

        // 3. Nothing else was reset to a default on the way through. A
        //    migration that quietly dropped the user's dev command or their
        //    workspace would be a worse bug than the one it fixes.
        assert_eq!(metadata.custom_dev_command.as_deref(), Some("pnpm dev"));
        assert_eq!(metadata.dev_server_port, Some(3001));
        assert_eq!(metadata.account_id.as_deref(), Some("acct_work"));
        assert_eq!(metadata.default_base_branch.as_deref(), Some("develop"));
        assert_eq!(metadata.last_opened, Some(1_755_000_000_000));

        // 4. The upgrade invents no hosting state. v4 caches no deployment in
        //    the repo, and the v3 block's URL and "READY" must not be
        //    resurrected as one — it named no commit, so it cannot describe
        //    the push the user is looking at.
        assert!(
            metadata.hosting.is_none(),
            "a v3 publish block must not become a v4 hosting link or snapshot"
        );

        // 5. The migration was persisted, not just applied in memory.
        let on_disk = std::fs::read_to_string(dir.join("project.json")).unwrap();
        let reread: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
        assert_eq!(reread["schema_version"], 4);
        assert_eq!(reread["custom_dev_command"], "pnpm dev");

        // 6. What actually happens to `publish`: the `extra` catch-all keeps
        //    it, so it is written straight back rather than dropped. Pinned
        //    because the behaviour is the opposite of what the removal comment
        //    used to claim, and because it is why the key must never be reused.
        assert_eq!(
            reread["publish"]["production"]["url"], "https://acme.com",
            "unknown keys are preserved verbatim, including this dead one"
        );
        assert!(
            metadata.extra.contains_key("publish"),
            "the removed block lands in `extra`, which is what preserves it"
        );
    }

    /// A file already at the current version must not be rewritten on every
    /// read — `migrate()` returning true triggers a disk write, and doing that
    /// on each open would touch every project's metadata file continuously.
    #[test]
    fn a_current_file_is_not_rewritten_on_read() {
        let mut metadata = ProjectMetadata {
            schema_version: PROJECT_METADATA_SCHEMA_VERSION,
            ..Default::default()
        };
        assert!(!metadata.migrate());
    }

    // The #625 shape: a write failure must route through classify_fs_error
    // (labeled with action + path), never a bare OS string.
    #[test]
    #[cfg(unix)]
    fn write_failure_is_labeled() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::TempDir::new().unwrap();
        // Pre-create .shipstudio, then make it unwritable so fs::write fails.
        let dir = tmp.path().join(".shipstudio");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let err = save_project_metadata(tmp.path(), &ProjectMetadata::default()).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("project metadata"), "got: {msg}");
        assert!(msg.contains("project.json"), "got: {msg}");

        // Restore so TempDir cleanup can delete it.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}
