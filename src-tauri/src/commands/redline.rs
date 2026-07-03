//! # Redline export + command installer
//!
//! Backend for the "Redline + direct edit" feature. Two commands:
//!
//! - [`write_redline_export`] persists one annotated-page export — a markdown
//!   changelog and (optionally) its annotated PNG — under `<project>/.redline/`,
//!   sharing a slug. The `/redline` agent command later reads these back and
//!   applies each numbered change to source.
//! - [`install_redline_command`] writes the Ship-Studio port of the `/redline`
//!   slash command into `<project>/.claude/commands/redline.md` so the project's
//!   agent can run it. Idempotent — overwriting an existing copy is fine.
//!
//! Both follow the four command rules: `Result<_, CommandError>`, path
//! validation via [`validate_project_path`], `#[tracing::instrument]`, and a
//! canonicalize-inside-root guard before any write. The slug is additionally
//! rejected if it contains `/` or `..` so it can never escape `.redline/`.

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use serde::Serialize;
use std::path::Path;

/// Paths of the two files written for one Redline export. Returned to the
/// frontend so it can surface where the export landed.
#[derive(Debug, Serialize, PartialEq)]
pub struct RedlineExport {
    /// Absolute path to the written `.md` changelog.
    pub md_path: String,
    /// Absolute path to the written `.png`, or empty if no screenshot was given.
    pub png_path: String,
}

/// The Ship-Studio port of the `/redline` slash-command body, written verbatim
/// into `<project>/.claude/commands/redline.md`. Mirrors the upstream apply-each
/// logic but adds the `Source: file:line` authority note (step 2.0) — Ship
/// Studio resolves the live element to a real source location via the dev
/// server, which is far stronger than any selector heuristic.
const REDLINE_COMMAND_BODY: &str = r#"---
description: Apply every pending Redline change request in this project to the codebase.
argument-hint: "[path to a .redline folder or a specific export .md]"
---

You are applying change requests produced by Ship Studio's Redline mode. Each
Redline export is a pair of files that share a slug: an annotated screenshot
(`*_redline.png`) and a markdown changelog (`*_redline.md`). A project may hold
several exports at once, one per annotated page. Apply all of them.

## 1. Locate the exports

- If `$ARGUMENTS` names a specific `.md` file, use only that file.
- If `$ARGUMENTS` names a folder, use that folder.
- Otherwise search the project for the export folder, in this order:
  1. a `.redline/` directory
  2. a `redline/` directory
  3. the repository root
- Collect every `*_redline.md` file directly in that folder, not in its
  subfolders. An `applied/` subfolder holds exports a previous run already
  handled; leave it alone.
- Sort the files by name. The slug starts with an ISO date, so this applies
  the oldest page first.
- If no `*_redline.md` file exists anywhere, stop and ask the user where the
  export is.
- State how many exports you found and the order you will apply them in.

## 2. Apply each export

Work through the exports one at a time. For each one:

- Read the `.md` file in full. It has a metadata table, a "How to apply"
  contract, and a numbered list of changes.
- Read the matching `.png` (the same slug) with the Read tool. The numbered
  markers in the image correspond to the numbered changes. Use it for the
  visual intent (spacing, alignment, color, hierarchy) that text cannot
  convey.
- For each numbered change:
  0. When an item has a `Source: file:line` line, that is the authoritative
     location resolved from the running dev server — open it directly and
     trust it first. The selector/locator/Current text below are fallbacks for
     when no `Source:` is present or it no longer matches.
  1. Find the target element in the source code, not just the rendered DOM.
     The changelog gives several locators; use them together:
     - the CSS `Selector` and `Selector path`
     - the `XPath` fallback
     - the `Element` line: grep the codebase for the id, the distinctive
       class names, or any `data-*` attributes
     - the `Current text`: grep for it. On a component framework it may be a
       prop or a string literal.
     - the `Nearby landmark`: it narrows down which section renders it
  2. If the item is a text replacement (`Change type: text replacement`),
     search the source for the exact `Old text` string and replace it with
     the `New text`. Exact string search beats a selector here. Fall back to
     the selector only when the `Old text` is not found verbatim, for example
     when it is interpolated, split across lines, or a localization key. When
     the item says `Contains inline markup: yes`, keep the element's child
     markup and change only the text.
  3. Make the change. Keep it minimal and scoped. Do not refactor surrounding
     code or restyle unrelated elements.
  4. If you cannot confidently identify the element, do not guess. Mark the
     item "Needs clarification" and say what you searched for.

## 3. Mark each export done

After you finish an export, move its `.md` and `.png` into an `applied/`
subfolder of the export folder, creating the subfolder if needed. This keeps
the next `/redline` run from repeating finished work. Move the files; do not
delete them.

## 4. Report

Print one combined summary, grouped by export, that mirrors the requests:

```
acme-com_home_redline  (3 changes)
  1. Done: src/Header.tsx:42, made the heading bold
  2. Skipped: reason
  3. Needs clarification: what is ambiguous

acme-com_pricing_redline  (2 changes)
  1. Done: src/Pricing.tsx:18, raised the contrast
  2. Done: src/Pricing.tsx:30, aligned the cards
```

Do not commit. Leave the changes staged for the user to review.

## Notes

- Modern sites hash their class names (Tailwind, CSS modules,
  styled-components), so a rendered-DOM selector may not appear verbatim in
  the source. Trust the `Source:` line, then the numbered intent and the
  element context, over an exact selector match.
- The page may have changed since the screenshot was captured. Treat the
  screenshot as the source of truth for what the user wants to see.
- A "Visual emphasis" section, if present, lists non-numbered marks (boxes,
  arrows, highlights). Those are context only. Do not treat them as change
  requests.
"#;

/// Rejects a slug that could escape the `.redline/` directory. The slug becomes
/// a filename (`<slug>.md` / `<slug>.png`), so a path separator or `..` segment
/// would let it write outside the intended folder.
fn validate_slug(slug: &str) -> Result<(), CommandError> {
    if slug.is_empty() {
        return Err(CommandError::Validation {
            field: "slug".into(),
            reason: "slug must not be empty".into(),
        });
    }
    if slug.contains('/') || slug.contains('\\') || slug.contains("..") {
        return Err(CommandError::Validation {
            field: "slug".into(),
            reason: "slug must not contain path separators or '..'".into(),
        });
    }
    Ok(())
}

/// Core of [`write_redline_export`], split out so tests can exercise it against
/// a tempdir (the command layer adds `validate_project_path`, which requires the
/// path to live inside the ShipStudio root and so can't run under a tempdir).
///
/// `root` must already be a validated, canonicalizable project directory.
fn write_export_into(
    root: &Path,
    slug: &str,
    markdown: &str,
    png: &[u8],
) -> Result<RedlineExport, CommandError> {
    validate_slug(slug)?;

    let redline_dir = root.join(".redline");
    std::fs::create_dir_all(&redline_dir).map_err(CommandError::from)?;

    // Defense in depth: the created `.redline` dir must resolve to a location
    // inside the (canonical) project root — no symlink/`..` escape.
    let canon_root = root.canonicalize().map_err(CommandError::from)?;
    let canon_redline = redline_dir.canonicalize().map_err(CommandError::from)?;
    if !canon_redline.starts_with(&canon_root) {
        return Err(CommandError::Validation {
            field: "project_path".into(),
            reason: ".redline directory resolves outside the project".into(),
        });
    }

    let md_path = canon_redline.join(format!("{slug}.md"));
    std::fs::write(&md_path, markdown).map_err(CommandError::from)?;

    let png_path = if png.is_empty() {
        String::new()
    } else {
        let p = canon_redline.join(format!("{slug}.png"));
        std::fs::write(&p, png).map_err(CommandError::from)?;
        p.to_string_lossy().into_owned()
    };

    Ok(RedlineExport {
        md_path: md_path.to_string_lossy().into_owned(),
        png_path,
    })
}

/// Persist one Redline export under `<project>/.redline/`: always the markdown
/// changelog `<slug>.md`, plus the annotated `<slug>.png` when `png` is
/// non-empty. Creates `.redline/` if missing. Returns the absolute paths.
#[tauri::command]
#[tracing::instrument(skip(markdown, png), fields(project = %project_path, slug = %slug, png_bytes = png.len()))]
pub fn write_redline_export(
    project_path: String,
    slug: String,
    markdown: String,
    png: Vec<u8>,
) -> Result<RedlineExport, CommandError> {
    // Reject a bad slug before touching the filesystem.
    validate_slug(&slug)?;
    let root = validate_project_path(&project_path)?;
    write_export_into(&root, &slug, &markdown, &png)
}

/// Core of [`install_redline_command`], split out for the same tempdir-test
/// reason as [`write_export_into`]. Writes the command body and guards the
/// target against escaping `root`.
fn install_command_into(root: &Path) -> Result<bool, CommandError> {
    let commands_dir = root.join(".claude").join("commands");
    std::fs::create_dir_all(&commands_dir).map_err(CommandError::from)?;

    let canon_root = root.canonicalize().map_err(CommandError::from)?;
    let canon_commands = commands_dir.canonicalize().map_err(CommandError::from)?;
    if !canon_commands.starts_with(&canon_root) {
        return Err(CommandError::Validation {
            field: "project_path".into(),
            reason: ".claude/commands resolves outside the project".into(),
        });
    }

    let target = canon_commands.join("redline.md");
    std::fs::write(&target, REDLINE_COMMAND_BODY).map_err(CommandError::from)?;
    Ok(true)
}

/// Install the Ship-Studio port of the `/redline` slash command into
/// `<project>/.claude/commands/redline.md`, creating the directories as needed.
/// Idempotent: an existing file is overwritten. Returns `true` on success.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn install_redline_command(project_path: String) -> Result<bool, CommandError> {
    let root = validate_project_path(&project_path)?;
    install_command_into(&root)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Make a unique, existing tempdir for one test (validate_* style helpers
    /// canonicalize, so the directory must really exist).
    fn unique_tempdir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ss-redline-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_slug_with_parent_traversal() {
        assert!(validate_slug("../evil").is_err());
        assert!(validate_slug("a/../b").is_err());
    }

    #[test]
    fn rejects_slug_with_leading_slash() {
        assert!(validate_slug("/etc/passwd").is_err());
        assert!(validate_slug("sub/dir").is_err());
    }

    #[test]
    fn accepts_a_normal_slug() {
        assert!(validate_slug("2026-06-13_acme-com_home_redline").is_ok());
    }

    #[test]
    fn write_export_rejects_escaping_slug() {
        let dir = unique_tempdir("escape");
        let err = write_export_into(&dir, "../escape", "# md", &[]).unwrap_err();
        match err {
            CommandError::Validation { field, .. } => assert_eq!(field, "slug"),
            other => panic!("expected slug Validation, got {other:?}"),
        }
        // Leading-slash slug is rejected too.
        assert!(write_export_into(&dir, "/abs", "# md", &[]).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_export_writes_both_files_for_valid_slug() {
        let dir = unique_tempdir("ok");
        let slug = "2026-06-13_acme-com_home_redline";
        let png_bytes: &[u8] = &[0x89, 0x50, 0x4e, 0x47]; // PNG magic, enough to be non-empty

        let out = write_export_into(&dir, slug, "# changelog\n", png_bytes).unwrap();

        let md = dir.join(".redline").join(format!("{slug}.md"));
        let png = dir.join(".redline").join(format!("{slug}.png"));
        assert!(md.exists(), "md file should exist");
        assert!(png.exists(), "png file should exist");
        assert_eq!(std::fs::read_to_string(&md).unwrap(), "# changelog\n");
        assert_eq!(std::fs::read(&png).unwrap(), png_bytes);
        // Returned paths are non-empty and point at the written files.
        assert!(out.md_path.ends_with(&format!("{slug}.md")));
        assert!(out.png_path.ends_with(&format!("{slug}.png")));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_export_skips_png_when_empty() {
        let dir = unique_tempdir("nopng");
        let slug = "2026-06-13_page_redline";

        let out = write_export_into(&dir, slug, "# md\n", &[]).unwrap();

        assert!(dir.join(".redline").join(format!("{slug}.md")).exists());
        assert!(!dir.join(".redline").join(format!("{slug}.png")).exists());
        assert_eq!(out.png_path, "");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn install_command_writes_and_is_idempotent() {
        let dir = unique_tempdir("install");

        assert!(install_command_into(&dir).unwrap());
        let target = dir.join(".claude").join("commands").join("redline.md");
        assert!(target.exists());
        let body = std::fs::read_to_string(&target).unwrap();
        assert!(body.contains("Source: file:line"));
        assert!(body.contains("Apply every pending Redline change request"));

        // Second call overwrites without error (idempotent).
        assert!(install_command_into(&dir).unwrap());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), body);

        std::fs::remove_dir_all(&dir).ok();
    }
}
