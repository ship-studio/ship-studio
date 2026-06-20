//! # Custom Classes (Webflow-style, Tailwind-native)
//!
//! Phase 0 of the visual editor's custom-class feature: detection + read-only
//! listing. A custom class is a named rule in the project's entry stylesheet,
//! composed from the same Tailwind tokens the editor's controls already emit:
//!
//! ```css
//! @layer components {
//!   .btn-primary { @apply px-4 py-2 bg-blue-500 text-white rounded; }
//! }
//! ```
//!
//! Editing such a rule's `@apply` list updates every element carrying the class
//! at once — Webflow's edit-once-update-all, expressed natively in CSS.
//!
//! These commands only READ. Parsing is conservative: a rule we can't faithfully
//! round-trip (raw declarations mixed in, nested rules, multi-selector) is
//! reported as `editable: false` rather than guessed at — mirroring the
//! "fail instead of guess" ethos of [`super::i18n`].

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Which Tailwind generation the project uses — decides where/how a custom
/// class is written (`@apply` is valid in both, but the entry file differs).
#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum TailwindVersion {
    /// v3: `tailwind.config.*` + `@tailwind base/components/utilities` directives.
    V3,
    /// v4: CSS-first, `@import "tailwindcss"`.
    V4,
    /// No recognizable Tailwind setup found.
    None,
}

/// Where and how custom classes can be managed in this project.
#[derive(Debug, Serialize, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TailwindSetup {
    pub version: TailwindVersion,
    /// POSIX-relative path to the stylesheet that imports Tailwind — the file an
    /// `@apply`-based class must live in (or `@reference`) to compile. `None`
    /// when no entry stylesheet could be located.
    pub entry_css: Option<String>,
    /// Whether `entry_css` already contains a writable `@layer components { … }`
    /// block (so Phase 1 appends to it rather than creating one).
    pub components_layer: bool,
}

/// One custom class parsed from the entry stylesheet.
#[derive(Debug, Serialize, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomClass {
    /// Class name without the leading dot (e.g. `btn-primary`).
    pub name: String,
    /// The utility tokens in its `@apply` list, in source order.
    pub tokens: Vec<String>,
    /// True when the rule is a pure `@apply` list we can round-trip safely.
    /// False when it mixes raw declarations or nested rules (Phase 2 / AI).
    pub editable: bool,
}

// ───────────────────────────── Commands ─────────────────────────────────────

/// Detect the project's Tailwind generation and locate the entry stylesheet
/// where custom classes should live.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn detect_tailwind_setup(project_path: String) -> Result<TailwindSetup, CommandError> {
    let root = validate_project_path(&project_path)?;
    Ok(detect_setup_at(&root))
}

/// List the custom classes defined in the project's entry stylesheet. Read-only:
/// returns `[]` when there's no entry stylesheet or it can't be read.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn list_custom_classes(project_path: String) -> Result<Vec<CustomClass>, CommandError> {
    let root = validate_project_path(&project_path)?;
    let setup = detect_setup_at(&root);
    let Some(entry) = setup.entry_css else {
        return Ok(vec![]);
    };
    let Ok(css) = std::fs::read_to_string(root.join(&entry)) else {
        return Ok(vec![]);
    };
    Ok(parse_custom_classes(&css))
}

// ───────────────────────── Setup detection ──────────────────────────────────

fn detect_setup_at(root: &Path) -> TailwindSetup {
    // Scan project CSS once, bucketing files by the entry signal they carry.
    // `@import "tailwindcss"` is the definitive v4 marker; `@tailwind` directives
    // are the v3 marker. The `ignore` walker skips node_modules/.next/.git.
    let mut v4_entries: Vec<PathBuf> = Vec::new();
    let mut v3_entries: Vec<PathBuf> = Vec::new();
    for entry in ignore::WalkBuilder::new(root)
        .standard_filters(true)
        .build()
        .flatten()
    {
        let path = entry.path();
        let is_css = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("css"))
            .unwrap_or(false);
        if !is_css {
            continue;
        }
        if let Ok(css) = std::fs::read_to_string(path) {
            if css_imports_tailwind(&css) {
                v4_entries.push(path.to_path_buf());
            } else if css_has_tailwind_directive(&css) {
                v3_entries.push(path.to_path_buf());
            }
        }
    }

    let has_v3_config = [
        "tailwind.config.js",
        "tailwind.config.ts",
        "tailwind.config.cjs",
        "tailwind.config.mjs",
    ]
    .iter()
    .any(|n| root.join(n).exists());

    // Prefer the shallowest, then lexicographically-first candidate — the global
    // entry stylesheet (e.g. `src/index.css`) over a deeply-nested component CSS.
    let pick = |mut v: Vec<PathBuf>| -> Option<PathBuf> {
        v.sort_by_key(|p| (p.components().count(), p.to_string_lossy().into_owned()));
        v.into_iter().next()
    };

    let (version, entry_abs) = if !v4_entries.is_empty() {
        (TailwindVersion::V4, pick(v4_entries))
    } else if !v3_entries.is_empty() {
        (TailwindVersion::V3, pick(v3_entries))
    } else if has_v3_config {
        // Config present but no parseable entry CSS — still v3, just can't locate
        // the entry stylesheet for write-back.
        (TailwindVersion::V3, None)
    } else {
        (TailwindVersion::None, None)
    };

    let components_layer = entry_abs
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|css| has_components_layer(&css))
        .unwrap_or(false);

    TailwindSetup {
        version,
        entry_css: entry_abs.map(|abs| rel_posix(root, &abs)),
        components_layer,
    }
}

fn rel_posix(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

/// The first quoted string literal in `s` (single or double quotes), if any.
fn first_quoted(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'"' || b[i] == b'\'' {
            let q = b[i];
            let start = i + 1;
            let mut j = start;
            while j < b.len() && b[j] != q {
                j += 1;
            }
            return Some(&s[start..j.min(b.len())]);
        }
        i += 1;
    }
    None
}

/// True if any code-level `@import` brings in Tailwind itself (the v4 entry
/// signal). Matches the import SPECIFIER exactly — `tailwindcss` or
/// `tailwindcss/...` — not a substring, so `@import "tailwindcss-animate"` (a
/// plugin) or `@import "./my-tailwindcss.css"` don't masquerade as the entry.
fn css_imports_tailwind(css: &str) -> bool {
    let kind = css_scan(css);
    let mut from = 0;
    while let Some(rel) = css[from..].find("@import") {
        let at = from + rel;
        from = at + "@import".len();
        if kind[at] != CssKind::Code {
            continue;
        }
        let end = css[at..].find(';').map(|e| at + e).unwrap_or(css.len());
        if let Some(spec) = first_quoted(&css[at..end]) {
            if spec == "tailwindcss" || spec.starts_with("tailwindcss/") {
                return true;
            }
        }
    }
    false
}

/// True if a code-level `@tailwind` directive is present (the v3 entry signal).
fn css_has_tailwind_directive(css: &str) -> bool {
    let kind = css_scan(css);
    let mut from = 0;
    while let Some(rel) = css[from..].find("@tailwind") {
        let at = from + rel;
        from = at + "@tailwind".len();
        if kind[at] == CssKind::Code {
            return true;
        }
    }
    false
}

/// True if the stylesheet contains a `@layer components { … }` BLOCK (not just a
/// `@layer a, components, b;` declaration list).
fn has_components_layer(css: &str) -> bool {
    components_layer_open(css, &css_scan(css)).is_some()
}

/// The index of the opening `{` of a `@layer components { … }` BLOCK (not a
/// `@layer a, components, b;` declaration list), if one exists.
fn components_layer_open(css: &str, kind: &[CssKind]) -> Option<usize> {
    let bytes = css.as_bytes();
    let mut from = 0;
    while let Some(rel) = css[from..].find("@layer") {
        let at = from + rel;
        from = at + "@layer".len();
        if kind[at] != CssKind::Code {
            continue;
        }
        // Walk to the statement terminator: `{` (a block) or `;` (a declaration).
        let mut j = at + "@layer".len();
        while j < bytes.len()
            && !(kind[j] == CssKind::Code && (bytes[j] == b'{' || bytes[j] == b';'))
        {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'{' {
            let names = &css[at + "@layer".len()..j];
            if names
                .split([',', ' ', '\t', '\n', '\r'])
                .any(|n| n.trim() == "components")
            {
                return Some(j);
            }
        }
    }
    None
}

// ───────────────────────── CSS scanning (pure) ──────────────────────────────

/// Byte classification for a comment/string-aware pass over CSS. CSS has only
/// block comments (`/* */`) and single/double-quoted strings — no line comments
/// or template literals — so this is simpler than the JS scanner in [`super::i18n`].
#[derive(Clone, Copy, PartialEq, Debug)]
enum CssKind {
    Code,
    Comment,
    Str,
}

fn css_scan(src: &str) -> Vec<CssKind> {
    let bytes = src.as_bytes();
    let mut kind = vec![CssKind::Code; bytes.len()];
    let mut i = 0;
    let mut in_str: Option<u8> = None;
    let mut in_comment = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_comment {
            kind[i] = CssKind::Comment;
            if c == b'*' && bytes.get(i + 1) == Some(&b'/') {
                kind[i + 1] = CssKind::Comment;
                in_comment = false;
                i += 2;
                continue;
            }
        } else if let Some(q) = in_str {
            kind[i] = CssKind::Str;
            if c == b'\\' {
                if i + 1 < bytes.len() {
                    kind[i + 1] = CssKind::Str;
                }
                i += 2;
                continue;
            }
            // CSS strings can't span unescaped newlines — recover so a stray
            // quote doesn't swallow the rest of the file.
            if c == q || c == b'\n' {
                in_str = None;
            }
        } else {
            match c {
                b'/' if bytes.get(i + 1) == Some(&b'*') => {
                    in_comment = true;
                    kind[i] = CssKind::Comment;
                }
                b'"' | b'\'' => {
                    in_str = Some(c);
                    kind[i] = CssKind::Str;
                }
                _ => {}
            }
        }
        i += 1;
    }
    kind
}

/// The innermost code-level `{` enclosing byte `pos`, or `None` at top level.
fn enclosing_open_brace(bytes: &[u8], kind: &[CssKind], pos: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut i = pos;
    while i > 0 {
        i -= 1;
        if kind[i] != CssKind::Code {
            continue;
        }
        match bytes[i] {
            b'}' => depth += 1,
            b'{' => {
                if depth == 0 {
                    return Some(i);
                }
                depth -= 1;
            }
            _ => {}
        }
    }
    None
}

/// The code-level `}` matching the `{` at `open`.
fn match_brace(bytes: &[u8], kind: &[CssKind], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut i = open;
    while i < bytes.len() {
        if kind[i] == CssKind::Code {
            match bytes[i] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// Bytes of `s` that aren't inside comments, as a lossy string. Used to read a
/// selector prelude or `@apply` value without comment noise.
fn code_text(s: &str, kind: &[CssKind]) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    for (i, &b) in bytes.iter().enumerate() {
        if kind[i] != CssKind::Comment {
            out.push(b);
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The start byte and (comment-stripped, trimmed) text of the selector prelude
/// preceding the rule body that opens at `open` — back to the previous
/// code-level `}`, `{`, or `;`.
fn prelude_bounds(css: &str, kind: &[CssKind], open: usize) -> (usize, String) {
    let bytes = css.as_bytes();
    let mut start = open;
    while start > 0 {
        let i = start - 1;
        if kind[i] == CssKind::Code && matches!(bytes[i], b'}' | b'{' | b';') {
            break;
        }
        start -= 1;
    }
    let text = code_text(&css[start..open], &kind[start..open])
        .trim()
        .to_string();
    (start, text)
}

/// The selector text immediately preceding the rule body that opens at `open`,
/// comments stripped.
fn selector_prelude(css: &str, kind: &[CssKind], open: usize) -> String {
    prelude_bounds(css, kind, open).1
}

/// If `prelude` is exactly one simple class selector (`.name`), return `name`.
/// Rejects combinators, commas, pseudo-classes, combos (`.a.b`), tag-qualified
/// (`div.a`) — anything we can't treat as a standalone managed class.
fn single_class_name(prelude: &str) -> Option<String> {
    let rest = prelude.trim().strip_prefix('.')?;
    let mut chars = rest.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_' || first == '-') {
        return None;
    }
    if !rest
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(rest.to_string())
}

/// Parse a rule body into its `@apply` tokens and whether it's a pure `@apply`
/// rule (editable) vs. one mixing raw declarations / nested rules (not).
fn parse_rule_body(body: &str, kind: &[CssKind]) -> (Vec<String>, bool) {
    let bytes = body.as_bytes();
    let mut tokens = Vec::new();
    let mut consumed = vec![false; bytes.len()];

    let mut from = 0;
    while let Some(rel) = body[from..].find("@apply") {
        let at = from + rel;
        from = at + "@apply".len();
        if kind[at] != CssKind::Code {
            continue;
        }
        // Value runs to the next code-level `;` outside any [] / () group
        // (arbitrary tokens like `[content:';']` keep their semicolons).
        let val_start = at + "@apply".len();
        let mut j = val_start;
        let mut group = 0i32;
        while j < bytes.len() {
            if kind[j] == CssKind::Code {
                match bytes[j] {
                    b'[' | b'(' => group += 1,
                    b']' | b')' => group -= 1,
                    b';' if group <= 0 => break,
                    _ => {}
                }
            }
            j += 1;
        }
        let value = code_text(&body[val_start..j], &kind[val_start..j]);
        tokens.extend(value.split_whitespace().map(|t| t.to_string()));
        let end = (j + 1).min(bytes.len()); // include the terminating ';'
        for c in consumed.iter_mut().take(end).skip(at) {
            *c = true;
        }
        from = end;
    }

    // Editable iff every code byte outside the @apply statements is insignificant
    // (whitespace or a stray semicolon). Any real declaration or nested `{` block
    // means we can't round-trip the rule safely.
    let editable = bytes.iter().enumerate().all(|(i, &b)| {
        consumed[i] || kind[i] != CssKind::Code || b.is_ascii_whitespace() || b == b';'
    });

    (tokens, editable)
}

/// Parse every simple `.class { … }` rule (at any nesting depth, e.g. inside
/// `@layer components`) that carries an `@apply`. First definition of a given
/// name wins; later redefinitions are ignored.
fn parse_custom_classes(css: &str) -> Vec<CustomClass> {
    let kind = css_scan(css);
    let bytes = css.as_bytes();
    let mut out: Vec<CustomClass> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut from = 0;
    while let Some(rel) = css[from..].find("@apply") {
        let at = from + rel;
        from = at + "@apply".len();
        if kind[at] != CssKind::Code {
            continue;
        }
        let Some(open) = enclosing_open_brace(bytes, &kind, at) else {
            continue;
        };
        let Some(name) = single_class_name(&selector_prelude(css, &kind, open)) else {
            continue;
        };
        let Some(close) = match_brace(bytes, &kind, open) else {
            continue;
        };
        let (tokens, editable) = parse_rule_body(&css[open + 1..close], &kind[open + 1..close]);
        if seen.insert(name.clone()) {
            out.push(CustomClass {
                name,
                tokens,
                editable,
            });
        }
        // Skip the rest of this rule so a second @apply inside it isn't reprocessed.
        from = close;
    }
    out
}

// ───────────────────────── Write commands ───────────────────────────────────

/// Create a new custom class from a list of Tailwind tokens. Inserted into the
/// existing `@layer components { … }` block, or a freshly-appended one. Returns
/// the project's updated class list. Fails (Validation) on a bad name, bad
/// tokens, a duplicate, or a project with no Tailwind entry stylesheet.
#[tauri::command]
#[tracing::instrument(skip(tokens), fields(project = %project_path, name = %name))]
pub fn create_custom_class(
    project_path: String,
    name: String,
    tokens: Vec<String>,
) -> Result<Vec<CustomClass>, CommandError> {
    let root = validate_project_path(&project_path)?;
    guard_project_apply_safety(&root, &tokens)?;
    write_entry_css(&project_path, |css| {
        create_class_in_css(css, &name, &tokens)
    })
}

/// Replace a custom class's `@apply` token list. Refuses (Validation) if the
/// class is missing or mixes raw declarations the editor can't safely rewrite.
#[tauri::command]
#[tracing::instrument(skip(tokens), fields(project = %project_path, name = %name))]
pub fn update_custom_class(
    project_path: String,
    name: String,
    tokens: Vec<String>,
) -> Result<Vec<CustomClass>, CommandError> {
    let root = validate_project_path(&project_path)?;
    guard_project_apply_safety(&root, &tokens)?;
    write_entry_css(&project_path, |css| {
        update_class_in_css(css, &name, &tokens)
    })
}

/// Remove a custom class rule from the entry stylesheet (cleaning up a
/// now-empty `@layer components` block). Markup still referencing the class is
/// left untouched — the caller warns the user, mirroring i18n removal.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, name = %name))]
pub fn delete_custom_class(
    project_path: String,
    name: String,
) -> Result<Vec<CustomClass>, CommandError> {
    write_entry_css(&project_path, |css| delete_class_in_css(css, &name))
}

/// Of the given tokens, return the ones that can't safely go in an `@apply`
/// (they're plain classes defined anywhere in the project's CSS, not Tailwind
/// utilities). Lets "create from styles" keep those on the element instead of
/// breaking the build.
#[tauri::command]
#[tracing::instrument(skip(tokens), fields(project = %project_path))]
pub fn classify_apply_tokens(
    project_path: String,
    tokens: Vec<String>,
) -> Result<Vec<String>, CommandError> {
    let root = validate_project_path(&project_path)?;
    let (plains, utils) = collect_project_class_index(&root);
    Ok(unsafe_tokens_against(&plains, &utils, &tokens))
}

/// Locate the project's entry stylesheet, apply a pure string transform to it,
/// write the result back, and return the fresh class list. Centralizes path
/// validation, the missing-entry error, and the string-error → Validation map.
fn write_entry_css(
    project_path: &str,
    edit: impl FnOnce(&str) -> Result<String, String>,
) -> Result<Vec<CustomClass>, CommandError> {
    let root = validate_project_path(project_path)?;
    let entry = detect_setup_at(&root)
        .entry_css
        .ok_or_else(|| CommandError::Validation {
            field: "entryCss".into(),
            reason: "No Tailwind entry stylesheet found in this project".into(),
        })?;
    let abs = root.join(&entry);

    // Defense in depth: the entry stylesheet must resolve inside the project.
    let canon_root = root.canonicalize().map_err(CommandError::from)?;
    let canon_abs = abs.canonicalize().map_err(CommandError::from)?;
    if !canon_abs.starts_with(&canon_root) {
        return Err(CommandError::Validation {
            field: "entryCss".into(),
            reason: "entry stylesheet is outside the project".into(),
        });
    }

    let css = std::fs::read_to_string(&abs).map_err(CommandError::from)?;
    let updated = edit(&css).map_err(|reason| CommandError::Validation {
        field: "customClass".into(),
        reason,
    })?;
    std::fs::write(&abs, &updated).map_err(CommandError::from)?;
    Ok(parse_custom_classes(&updated))
}

// ───────────────────────── Validation ───────────────────────────────────────

/// A class name we can write into a `.name { … }` selector — a CSS identifier
/// restricted to the same charset [`single_class_name`] accepts when reading.
fn validate_class_name(name: &str) -> Result<(), String> {
    let Some(first) = name.chars().next() else {
        return Err("Class name cannot be empty".into());
    };
    if name.len() > 64 {
        return Err("Class name is too long".into());
    }
    if !(first.is_ascii_alphabetic() || first == '_' || first == '-') {
        return Err(format!(
            "Class name `{name}` must start with a letter, dash, or underscore"
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!(
            "Class name `{name}` may only contain letters, numbers, dashes, and underscores"
        ));
    }
    Ok(())
}

/// Validate a token list destined for an `@apply` statement. Beyond emptiness,
/// this is an injection guard: tokens are interpolated into CSS, so anything
/// that could escape the statement, rule, or a comment is rejected. Tailwind's
/// own metacharacters (`/`, `:`, `[]`, `!`, `-`, `%`, `.`) all pass.
fn validate_tokens(tokens: &[String]) -> Result<(), String> {
    if tokens.is_empty() {
        return Err("Add at least one utility class".into());
    }
    if tokens.len() > 200 {
        return Err("Too many utilities (max 200)".into());
    }
    for t in tokens {
        if t.is_empty() {
            return Err("Empty utility token".into());
        }
        if t.chars().any(|c| c.is_whitespace()) {
            return Err(format!("Utility `{t}` contains whitespace"));
        }
        if t.contains([';', '{', '}', '"', '\'']) {
            return Err(format!("Utility `{t}` contains an illegal character"));
        }
        if t.contains("/*") || t.contains("*/") {
            return Err(format!("Utility `{t}` contains a comment marker"));
        }
    }
    Ok(())
}

// ─────────────────── @apply-safety (Tailwind v4 build guard) ────────────────
//
// Tailwind v4 `@apply` only accepts *utilities* — built-ins, arbitrary-value
// utilities, and `@utility`-defined ones. Applying a PLAIN class (a `.foo {}`
// rule, including another `@layer components` class) is a hard CssSyntaxError
// that breaks the whole stylesheet's build. We can't enumerate Tailwind's
// built-ins, but we CAN spot the dangerous case: a token that the project's CSS
// defines as a plain class and NOT as an `@utility`. Those we refuse to write.

/// Every simple `.name` selector defined anywhere in the stylesheet.
fn collect_plain_class_names(css: &str, kind: &[CssKind]) -> HashSet<String> {
    let bytes = css.as_bytes();
    let mut names = HashSet::new();
    for i in 0..bytes.len() {
        if kind[i] != CssKind::Code || bytes[i] != b'{' {
            continue;
        }
        if let Some(name) = single_class_name(&prelude_bounds(css, kind, i).1) {
            names.insert(name);
        }
    }
    names
}

/// Every name defined via `@utility <name>` — these ARE valid inside `@apply`.
fn collect_utility_names(css: &str, kind: &[CssKind]) -> HashSet<String> {
    let bytes = css.as_bytes();
    let mut names = HashSet::new();
    let mut from = 0;
    while let Some(rel) = css[from..].find("@utility") {
        let at = from + rel;
        from = at + "@utility".len();
        if kind[at] != CssKind::Code {
            continue;
        }
        let mut j = at + "@utility".len();
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        let start = j;
        while j < bytes.len()
            && (bytes[j].is_ascii_alphanumeric() || matches!(bytes[j], b'-' | b'_'))
        {
            j += 1;
        }
        if j > start {
            names.insert(css[start..j].to_string());
        }
    }
    names
}

/// Well-known Tailwind utilities whose names are ALSO commonly authored as plain
/// classes (resets like `.container {}`, `.flex {}`). They're always valid in
/// `@apply` (the utility exists), so exempt them from the plain-class block to
/// avoid false positives. Exempting a real utility is safe; the failure mode we
/// guard against is a NON-utility plain class.
const KNOWN_UTILITY_NAMES: &[&str] = &[
    "container",
    "flex",
    "grid",
    "block",
    "inline",
    "inline-block",
    "inline-flex",
    "inline-grid",
    "hidden",
    "table",
    "contents",
    "flow-root",
    "list-item",
    "sr-only",
    "not-sr-only",
    "truncate",
    "italic",
    "underline",
    "overline",
    "line-through",
    "no-underline",
    "uppercase",
    "lowercase",
    "capitalize",
    "normal-case",
    "isolate",
    "static",
    "fixed",
    "absolute",
    "relative",
    "sticky",
    "visible",
    "invisible",
    "collapse",
    "antialiased",
];

/// The bare class name a token would resolve to for `@apply` — strip any variant
/// prefixes (`sm:`, `hover:`) and the `!` important marker. Returns `None` for
/// arbitrary-value tokens (`text-[…]`), which never name a plain class.
fn apply_base_name(token: &str) -> Option<&str> {
    let name = token
        .rsplit(':')
        .next()
        .unwrap_or(token)
        .trim_start_matches('!');
    if name.is_empty() || name.contains(['[', ']', '(', ')']) {
        return None;
    }
    Some(name)
}

/// Tailwind marker classes that generate NO CSS — they only exist to be targeted
/// by variants (`group-hover:`, `peer-checked:`). `@apply group` / `@apply peer`
/// therefore errors with "cannot apply unknown utility class", so they're never
/// safe to fold into an `@apply` list (they belong on the element's markup). This
/// covers the bare markers and their named forms (`group/menu`, `peer/email`).
fn is_non_applicable_marker(name: &str) -> bool {
    matches!(name, "group" | "peer") || name.starts_with("group/") || name.starts_with("peer/")
}

/// Whether a single token would break `@apply`: it's a non-applicable marker, or
/// its base name is defined as a plain class, isn't also an `@utility`, and isn't
/// a known built-in utility.
fn token_is_unsafe(token: &str, plains: &HashSet<String>, utils: &HashSet<String>) -> bool {
    apply_base_name(token)
        .map(|n| {
            is_non_applicable_marker(n)
                || (plains.contains(n) && !utils.contains(n) && !KNOWN_UTILITY_NAMES.contains(&n))
        })
        .unwrap_or(false)
}

/// Tokens that would break `@apply`: defined as a plain class in this stylesheet
/// and not also an `@utility`.
fn unsafe_apply_tokens(css: &str, kind: &[CssKind], tokens: &[String]) -> Vec<String> {
    let plains = collect_plain_class_names(css, kind);
    let utils = collect_utility_names(css, kind);
    tokens
        .iter()
        .filter(|t| token_is_unsafe(t, &plains, &utils))
        .cloned()
        .collect()
}

/// A class can be defined as a plain rule in a stylesheet OTHER than the entry
/// one (a global, a component CSS, a vendored sheet) and still break `@apply`.
/// Build the index across ALL of the project's CSS (node_modules excluded) so
/// the guard isn't blind to those. Returns (plain-class names, `@utility` names).
fn collect_project_class_index(root: &Path) -> (HashSet<String>, HashSet<String>) {
    let mut plains = HashSet::new();
    let mut utils = HashSet::new();
    for entry in ignore::WalkBuilder::new(root)
        .standard_filters(true)
        .build()
        .flatten()
    {
        let path = entry.path();
        let is_css = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("css"))
            .unwrap_or(false);
        if !is_css {
            continue;
        }
        if let Ok(css) = std::fs::read_to_string(path) {
            let kind = css_scan(&css);
            plains.extend(collect_plain_class_names(&css, &kind));
            utils.extend(collect_utility_names(&css, &kind));
        }
    }
    (plains, utils)
}

/// Tokens unsafe to `@apply` against a prebuilt (plain, utility) index.
fn unsafe_tokens_against(
    plains: &HashSet<String>,
    utils: &HashSet<String>,
    tokens: &[String],
) -> Vec<String> {
    tokens
        .iter()
        .filter(|t| token_is_unsafe(t, plains, utils))
        .cloned()
        .collect()
}

fn apply_safety_message(bad: &[String]) -> String {
    format!(
        "Can't put {} in a class — {} a custom class, not a Tailwind utility, so @apply would break the build. Keep it on the element, or convert it to an @utility.",
        bad.iter().map(|t| format!("`{t}`")).collect::<Vec<_>>().join(", "),
        if bad.len() == 1 { "it's" } else { "they're" },
    )
}

/// Reject a token list that would break the Tailwind build via `@apply`, checking
/// against every CSS file in the project (not just the entry stylesheet).
fn guard_project_apply_safety(root: &Path, tokens: &[String]) -> Result<(), CommandError> {
    let (plains, utils) = collect_project_class_index(root);
    let bad = unsafe_tokens_against(&plains, &utils, tokens);
    if bad.is_empty() {
        return Ok(());
    }
    Err(CommandError::Validation {
        field: "customClass".into(),
        reason: apply_safety_message(&bad),
    })
}

/// Reject a token list that would break the Tailwind build via `@apply`. Entry-CSS
/// scope only — kept for the pure transforms' unit tests; commands additionally
/// run [`guard_project_apply_safety`] across the whole project.
fn guard_apply_safety(css: &str, kind: &[CssKind], tokens: &[String]) -> Result<(), String> {
    let bad = unsafe_apply_tokens(css, kind, tokens);
    if bad.is_empty() {
        return Ok(());
    }
    Err(apply_safety_message(&bad))
}

// ───────────────────────── Pure CSS transforms ──────────────────────────────

/// A `.name { … }` rule located in source.
struct ClassRule {
    /// Start byte of the selector prelude (for whole-rule removal).
    prelude_start: usize,
    /// The rule body's opening `{`.
    open: usize,
    /// The matching closing `}`.
    close: usize,
}

/// Find the first `.name { … }` rule (at any nesting depth).
fn find_class_rule(css: &str, kind: &[CssKind], name: &str) -> Option<ClassRule> {
    let bytes = css.as_bytes();
    // Every code-level `{` opens a block in CSS; descend through at-rule blocks
    // (`@layer`/`@media`) so nested class rules are reachable.
    for i in 0..bytes.len() {
        if kind[i] != CssKind::Code || bytes[i] != b'{' {
            continue;
        }
        let (prelude_start, prelude) = prelude_bounds(css, kind, i);
        if single_class_name(&prelude).as_deref() == Some(name) {
            if let Some(close) = match_brace(bytes, kind, i) {
                return Some(ClassRule {
                    prelude_start,
                    open: i,
                    close,
                });
            }
        }
    }
    None
}

fn rule_text(name: &str, tokens: &[String]) -> String {
    format!(".{} {{ @apply {}; }}", name, tokens.join(" "))
}

fn create_class_in_css(css: &str, name: &str, tokens: &[String]) -> Result<String, String> {
    validate_class_name(name)?;
    validate_tokens(tokens)?;
    let kind = css_scan(css);
    guard_apply_safety(css, &kind, tokens)?;
    if find_class_rule(css, &kind, name).is_some() {
        return Err(format!("A class named `.{name}` already exists"));
    }
    let rule = rule_text(name, tokens);

    if let Some(open) = components_layer_open(css, &kind) {
        // Insert as the first rule inside the existing components layer.
        let mut out = String::with_capacity(css.len() + rule.len() + 4);
        out.push_str(&css[..=open]);
        out.push_str("\n  ");
        out.push_str(&rule);
        out.push_str(&css[open + 1..]);
        Ok(out)
    } else {
        // Append a fresh components layer at the end of the file.
        let mut out = css.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("\n@layer components {{\n  {rule}\n}}\n"));
        Ok(out)
    }
}

fn update_class_in_css(css: &str, name: &str, tokens: &[String]) -> Result<String, String> {
    validate_tokens(tokens)?;
    let kind = css_scan(css);
    guard_apply_safety(css, &kind, tokens)?;
    let rule =
        find_class_rule(css, &kind, name).ok_or_else(|| format!("`.{name}` was not found"))?;

    let (_, editable) = parse_rule_body(
        &css[rule.open + 1..rule.close],
        &kind[rule.open + 1..rule.close],
    );
    if !editable {
        return Err(format!(
            "`.{name}` has custom CSS this editor can't safely rewrite"
        ));
    }

    let mut out = String::with_capacity(css.len());
    out.push_str(&css[..=rule.open]);
    out.push_str(&format!(" @apply {}; ", tokens.join(" ")));
    out.push_str(&css[rule.close..]);
    Ok(out)
}

fn delete_class_in_css(css: &str, name: &str) -> Result<String, String> {
    let kind = css_scan(css);
    let rule =
        find_class_rule(css, &kind, name).ok_or_else(|| format!("`.{name}` was not found"))?;
    let bytes = css.as_bytes();

    // Widen the removal to the whole line(s): trim leading indentation and a
    // single trailing newline so we don't leave a blank gap behind.
    let mut start = rule.prelude_start;
    while start > 0 && matches!(bytes[start - 1], b' ' | b'\t') {
        start -= 1;
    }
    let mut end = rule.close + 1;
    while end < bytes.len() && matches!(bytes[end], b' ' | b'\t') {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'\r' {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'\n' {
        end += 1;
    }

    let mut out = String::with_capacity(css.len());
    out.push_str(&css[..start]);
    out.push_str(&css[end..]);
    Ok(remove_empty_components_layer(&out))
}

/// If a `@layer components { … }` block is now whitespace-only, remove it (and
/// its surrounding blank line) so deleting the last class doesn't leave litter.
fn remove_empty_components_layer(css: &str) -> String {
    let kind = css_scan(css);
    let bytes = css.as_bytes();
    let Some(open) = components_layer_open(css, &kind) else {
        return css.to_string();
    };
    let Some(close) = match_brace(bytes, &kind, open) else {
        return css.to_string();
    };
    if !css[open + 1..close].trim().is_empty() {
        return css.to_string();
    }

    let (prelude_start, _) = prelude_bounds(css, &kind, open);
    let mut end = close + 1;
    while end < bytes.len() && matches!(bytes[end], b' ' | b'\t') {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'\r' {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'\n' {
        end += 1;
    }

    let mut out = String::with_capacity(css.len());
    out.push_str(css[..prelude_start].trim_end_matches([' ', '\t', '\n', '\r']));
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(&css[end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // ───────────── CSS class parsing ─────────────

    #[test]
    fn parses_a_pure_apply_rule_in_components_layer() {
        let css = r#"
@import "tailwindcss";
@layer components {
  .btn-primary { @apply px-4 py-2 bg-blue-500 text-white rounded; }
}
"#;
        let classes = parse_custom_classes(css);
        assert_eq!(classes.len(), 1);
        assert_eq!(classes[0].name, "btn-primary");
        assert_eq!(
            classes[0].tokens,
            vec!["px-4", "py-2", "bg-blue-500", "text-white", "rounded"]
        );
        assert!(classes[0].editable);
    }

    #[test]
    fn parses_top_level_rule_without_a_layer() {
        let css = ".card { @apply rounded-lg shadow p-6; }";
        let classes = parse_custom_classes(css);
        assert_eq!(classes.len(), 1);
        assert_eq!(classes[0].name, "card");
        assert_eq!(classes[0].tokens, vec!["rounded-lg", "shadow", "p-6"]);
        assert!(classes[0].editable);
    }

    #[test]
    fn parses_multiline_prettier_formatting() {
        let css = r#"
@layer components {
  .btn {
    @apply px-4
      py-2
      rounded;
  }
}
"#;
        let classes = parse_custom_classes(css);
        assert_eq!(classes.len(), 1);
        assert_eq!(classes[0].tokens, vec!["px-4", "py-2", "rounded"]);
        assert!(classes[0].editable);
    }

    #[test]
    fn keeps_arbitrary_value_tokens_intact() {
        // Arbitrary tokens carry colons/parens/brackets but no top-level `;`.
        let css = r#".hero { @apply bg-[#1a3c5e] [clip-path:circle(50%)] text-white; }"#;
        let classes = parse_custom_classes(css);
        assert_eq!(
            classes[0].tokens,
            vec!["bg-[#1a3c5e]", "[clip-path:circle(50%)]", "text-white"]
        );
        assert!(classes[0].editable);
    }

    #[test]
    fn flags_rule_with_raw_declarations_as_not_editable() {
        let css = r#".btn { @apply px-4 py-2; color: red; }"#;
        let classes = parse_custom_classes(css);
        assert_eq!(classes.len(), 1);
        assert_eq!(classes[0].name, "btn");
        // Tokens still surface for display, but it's not safe to round-trip.
        assert_eq!(classes[0].tokens, vec!["px-4", "py-2"]);
        assert!(!classes[0].editable);
    }

    #[test]
    fn ignores_multi_selector_and_qualified_rules() {
        let css = r#"
.a, .b { @apply p-2; }
div.card { @apply p-4; }
.parent .child { @apply p-1; }
.btn:hover { @apply underline; }
"#;
        // None of these is a standalone managed class.
        assert!(parse_custom_classes(css).is_empty());
    }

    #[test]
    fn ignores_apply_inside_comments() {
        let css = r#"
/* .old { @apply p-8; } */
.real { @apply p-2; }
"#;
        let classes = parse_custom_classes(css);
        assert_eq!(classes.len(), 1);
        assert_eq!(classes[0].name, "real");
    }

    #[test]
    fn first_definition_wins_on_duplicate_names() {
        let css = r#"
.btn { @apply p-2; }
.btn { @apply p-8 m-4; }
"#;
        let classes = parse_custom_classes(css);
        assert_eq!(classes.len(), 1);
        assert_eq!(classes[0].tokens, vec!["p-2"]);
    }

    #[test]
    fn handles_multiple_classes_and_a_nested_at_rule() {
        let css = r#"
@layer components {
  .btn { @apply px-4 py-2; }
  .card { @apply rounded shadow; }
}
@media (min-width: 768px) {
  .btn-lg { @apply px-8 py-4; }
}
"#;
        let classes = parse_custom_classes(css);
        let names: Vec<&str> = classes.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["btn", "card", "btn-lg"]);
    }

    #[test]
    fn empty_when_no_apply_rules() {
        let css = ".btn { color: red; padding: 1rem; }";
        assert!(parse_custom_classes(css).is_empty());
    }

    // ───────────── Entry-signal detection ─────────────

    #[test]
    fn detects_v4_import_and_v3_directive_signals() {
        assert!(css_imports_tailwind(r#"@import "tailwindcss";"#));
        assert!(css_imports_tailwind("@import 'tailwindcss';"));
        assert!(css_imports_tailwind(
            r#"@import "tailwindcss/preflight" layer(base);"#
        ));
        assert!(!css_imports_tailwind(r#"@import "./other.css";"#));
        assert!(!css_imports_tailwind(r#"/* @import "tailwindcss"; */"#));

        assert!(css_has_tailwind_directive(
            "@tailwind base;\n@tailwind utilities;"
        ));
        assert!(!css_has_tailwind_directive("/* @tailwind base; */"));
        assert!(!css_has_tailwind_directive(".btn { color: red; }"));
    }

    #[test]
    fn detects_components_layer_block_but_not_declaration() {
        assert!(has_components_layer(
            "@layer components { .a { @apply p-2; } }"
        ));
        assert!(has_components_layer(
            "@layer base, components, utilities { }"
        ));
        // A bare layer-order declaration is not a writable block.
        assert!(!has_components_layer(
            "@layer theme, base, components, utilities;"
        ));
        assert!(!has_components_layer(
            "@layer utilities { .x { @apply p-1; } }"
        ));
    }

    // ───────────── Setup detection (filesystem) ─────────────

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ss-cc-{}-{}-{}",
            name,
            std::process::id(),
            // Disambiguate parallel tests in the same process.
            name.len()
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn setup_detects_v4_entry_and_layer() {
        let dir = tmp("v4");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("src/index.css"),
            "@import \"tailwindcss\";\n@layer components { .btn { @apply p-2; } }",
        )
        .unwrap();
        let setup = detect_setup_at(&dir);
        assert_eq!(setup.version, TailwindVersion::V4);
        assert_eq!(setup.entry_css.as_deref(), Some("src/index.css"));
        assert!(setup.components_layer);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn setup_detects_v3_directive_entry() {
        let dir = tmp("v3");
        std::fs::write(dir.join("tailwind.config.js"), "module.exports = {}").unwrap();
        std::fs::write(
            dir.join("globals.css"),
            "@tailwind base;\n@tailwind components;\n@tailwind utilities;",
        )
        .unwrap();
        let setup = detect_setup_at(&dir);
        assert_eq!(setup.version, TailwindVersion::V3);
        assert_eq!(setup.entry_css.as_deref(), Some("globals.css"));
        assert!(!setup.components_layer);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn setup_prefers_shallowest_entry_candidate() {
        let dir = tmp("shallow");
        std::fs::create_dir_all(dir.join("src/styles/deep")).unwrap();
        std::fs::write(dir.join("app.css"), "@import \"tailwindcss\";").unwrap();
        std::fs::write(
            dir.join("src/styles/deep/extra.css"),
            "@import \"tailwindcss\";",
        )
        .unwrap();
        let setup = detect_setup_at(&dir);
        assert_eq!(setup.entry_css.as_deref(), Some("app.css"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn setup_reports_none_without_tailwind() {
        let dir = tmp("none");
        std::fs::write(dir.join("styles.css"), ".btn { color: red; }").unwrap();
        let setup = detect_setup_at(&dir);
        assert_eq!(setup.version, TailwindVersion::None);
        assert_eq!(setup.entry_css, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn setup_v3_config_without_locatable_entry() {
        let dir = tmp("v3-noentry");
        std::fs::write(dir.join("tailwind.config.ts"), "export default {}").unwrap();
        let setup = detect_setup_at(&dir);
        assert_eq!(setup.version, TailwindVersion::V3);
        assert_eq!(setup.entry_css, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ───────────── Validation ─────────────

    #[test]
    fn rejects_bad_class_names() {
        assert!(validate_class_name("btn-primary").is_ok());
        assert!(validate_class_name("_x").is_ok());
        assert!(validate_class_name("").is_err());
        assert!(validate_class_name("1btn").is_err());
        assert!(validate_class_name("a b").is_err());
        assert!(validate_class_name("a.b").is_err());
        assert!(validate_class_name("a}b").is_err());
    }

    #[test]
    fn rejects_dangerous_tokens_but_allows_tailwind_metachars() {
        // Real Tailwind tokens with metacharacters all pass.
        assert!(validate_tokens(&[
            "bg-black/50".into(),
            "w-1/2".into(),
            "hover:bg-[#1a3c5e]".into(),
            "[clip-path:circle(50%)]".into(),
            "!font-bold".into(),
        ])
        .is_ok());
        // Injection attempts are rejected.
        assert!(validate_tokens(&[]).is_err());
        assert!(validate_tokens(&["a; } .evil { color:red".into()]).is_err());
        assert!(validate_tokens(&["a{b".into()]).is_err());
        assert!(validate_tokens(&["a*/b".into()]).is_err());
        assert!(validate_tokens(&["has space".into()]).is_err());
    }

    // ───────────── create_class_in_css ─────────────

    #[test]
    fn create_inserts_into_existing_components_layer() {
        let css = "@import \"tailwindcss\";\n@layer components {\n  .card { @apply rounded; }\n}\n";
        let out = create_class_in_css(css, "btn", &["px-4".into(), "py-2".into()]).unwrap();
        // New rule lands inside the existing layer; both classes parse back out.
        let names: Vec<String> = parse_custom_classes(&out)
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert!(names.contains(&"btn".to_string()));
        assert!(names.contains(&"card".to_string()));
        assert!(out.contains("@apply px-4 py-2;"));
        // Didn't spawn a second components layer.
        assert_eq!(out.matches("@layer components").count(), 1);
    }

    #[test]
    fn create_appends_a_components_layer_when_absent() {
        let css = "@import \"tailwindcss\";\n";
        let out = create_class_in_css(css, "btn", &["px-4".into()]).unwrap();
        assert!(has_components_layer(&out));
        let parsed = parse_custom_classes(&out);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "btn");
        assert_eq!(parsed[0].tokens, vec!["px-4"]);
    }

    #[test]
    fn create_rejects_duplicate_and_bad_input() {
        let css = ".btn { @apply p-2; }";
        assert!(create_class_in_css(css, "btn", &["p-4".into()]).is_err());
        assert!(create_class_in_css(css, "1bad", &["p-4".into()]).is_err());
        assert!(create_class_in_css(css, "ok", &[]).is_err());
    }

    // ───────────── update_class_in_css ─────────────

    #[test]
    fn update_replaces_the_apply_list_only() {
        let css =
            "@layer components {\n  .btn { @apply px-4 py-2; }\n  .card { @apply rounded; }\n}\n";
        let out = update_class_in_css(
            css,
            "btn",
            &["px-8".into(), "py-4".into(), "rounded-lg".into()],
        )
        .unwrap();
        let btn = parse_custom_classes(&out)
            .into_iter()
            .find(|c| c.name == "btn")
            .unwrap();
        assert_eq!(btn.tokens, vec!["px-8", "py-4", "rounded-lg"]);
        // The sibling rule is untouched.
        assert!(out.contains(".card { @apply rounded; }"));
    }

    #[test]
    fn update_refuses_missing_or_unsafe_rules() {
        assert!(update_class_in_css(".btn { @apply p-2; }", "ghost", &["p-4".into()]).is_err());
        // Mixed raw declaration → not safe to rewrite.
        let mixed = ".btn { @apply p-2; color: red; }";
        assert!(update_class_in_css(mixed, "btn", &["p-4".into()]).is_err());
    }

    // ───────────── delete_class_in_css ─────────────

    #[test]
    fn delete_removes_rule_and_keeps_siblings() {
        let css = "@layer components {\n  .btn { @apply px-4; }\n  .card { @apply rounded; }\n}\n";
        let out = delete_class_in_css(css, "btn").unwrap();
        let names: Vec<String> = parse_custom_classes(&out)
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec!["card"]);
        assert!(!out.contains(".btn"));
        // No blank line left where .btn was.
        assert!(!out.contains("\n\n  .card"));
    }

    #[test]
    fn delete_removes_now_empty_components_layer() {
        let css = "@import \"tailwindcss\";\n\n@layer components {\n  .btn { @apply px-4; }\n}\n";
        let out = delete_class_in_css(css, "btn").unwrap();
        assert!(!has_components_layer(&out));
        assert!(out.contains("@import \"tailwindcss\";"));
    }

    #[test]
    fn delete_rejects_missing_rule() {
        assert!(delete_class_in_css(".btn { @apply p-2; }", "ghost").is_err());
    }

    // ───────────── @apply build-safety guard ─────────────

    #[test]
    fn rejects_applying_a_plain_custom_class() {
        // The element carried a project-defined plain class; @apply-ing it would
        // be a hard CssSyntaxError in Tailwind v4 — so create must refuse.
        let css = "@import \"tailwindcss\";\n.animate-fade { animation: x 1s; }\n";
        let err = create_class_in_css(css, "hero", &["text-2xl".into(), "animate-fade".into()])
            .unwrap_err();
        assert!(
            err.contains("animate-fade"),
            "names the offending token: {err}"
        );
    }

    #[test]
    fn project_guard_flags_plain_class_from_a_non_entry_stylesheet() {
        // The class is defined in a SEPARATE css file (a global, a component
        // sheet) — the entry-only guard would miss it; the project-wide scan
        // must catch it so the write can't brick the build.
        let dir = tmp("apply-guard");
        std::fs::create_dir_all(dir.join("src/styles")).unwrap();
        std::fs::write(dir.join("src/index.css"), "@import \"tailwindcss\";\n").unwrap();
        std::fs::write(
            dir.join("src/styles/animations.css"),
            ".fancy-spin { animation: spin 1s; }\n",
        )
        .unwrap();

        // A real utility passes; the cross-file plain class is rejected.
        assert!(guard_project_apply_safety(&dir, &["px-4".into()]).is_ok());
        let err =
            guard_project_apply_safety(&dir, &["px-4".into(), "fancy-spin".into()]).unwrap_err();
        assert!(
            matches!(err, CommandError::Validation { ref reason, .. } if reason.contains("fancy-spin")),
            "rejects the cross-file plain class: {err:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_guard_respects_at_utility_across_files() {
        let dir = tmp("apply-guard-utility");
        std::fs::write(dir.join("index.css"), "@import \"tailwindcss\";\n").unwrap();
        std::fs::write(
            dir.join("utils.css"),
            "@utility fancy-spin { animation: spin 1s; }\n",
        )
        .unwrap();
        // Defined as an @utility elsewhere → valid in @apply, not flagged.
        assert!(guard_project_apply_safety(&dir, &["fancy-spin".into()]).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn import_detection_matches_the_specifier_not_a_substring() {
        // Real Tailwind entry signals.
        assert!(css_imports_tailwind("@import \"tailwindcss\";"));
        assert!(css_imports_tailwind("@import 'tailwindcss';"));
        assert!(css_imports_tailwind(
            "@import \"tailwindcss/preflight\" layer(base);"
        ));
        // Plugins / unrelated files that merely CONTAIN the substring must not match.
        assert!(!css_imports_tailwind("@import \"tailwindcss-animate\";"));
        assert!(!css_imports_tailwind("@import \"./my-tailwindcss.css\";"));
        assert!(!css_imports_tailwind("@import \"@my/tailwindcss-preset\";"));
        assert!(!css_imports_tailwind("/* @import \"tailwindcss\"; */"));
    }

    #[test]
    fn guard_exempts_known_utilities_that_collide_with_plain_classes() {
        // A hand-written `.container {}` reset is common; `@apply container` is
        // still valid because `container` is a real utility — don't flag it.
        let css = ".container { max-width: 80rem; margin: 0 auto; }";
        let kind = css_scan(css);
        assert!(unsafe_apply_tokens(css, &kind, &["container".into(), "flex".into()]).is_empty());
        // A genuinely non-utility plain class is still flagged.
        assert_eq!(
            unsafe_apply_tokens(
                &format!("{css}\n.brandbox {{ color: red; }}"),
                &css_scan(&format!("{css}\n.brandbox {{ color: red; }}")),
                &["brandbox".into()]
            ),
            vec!["brandbox".to_string()]
        );
    }

    #[test]
    fn flags_group_and_peer_markers_as_unsafe() {
        // `group`/`peer` generate no CSS — `@apply group` errors. They must be
        // flagged even though they're not defined as plain classes anywhere.
        let css = "@import \"tailwindcss\";";
        let kind = css_scan(css);
        assert_eq!(
            unsafe_apply_tokens(
                css,
                &kind,
                &[
                    "group".into(),
                    "peer".into(),
                    "group/menu".into(),
                    "peer/email".into(),
                ],
            ),
            vec![
                "group".to_string(),
                "peer".to_string(),
                "group/menu".to_string(),
                "peer/email".to_string(),
            ]
        );
        // ...but variant utilities that merely *reference* a group are applyable.
        assert!(unsafe_apply_tokens(css, &kind, &["group-hover:bg-red-500".into()]).is_empty());
    }

    #[test]
    fn apply_base_name_strips_variant_then_important() {
        assert_eq!(apply_base_name("hover:!flex"), Some("flex"));
        assert_eq!(apply_base_name("!container"), Some("container"));
        assert_eq!(apply_base_name("md:text-lg"), Some("text-lg"));
        assert_eq!(apply_base_name("bg-[#fff]"), None);
    }

    #[test]
    fn allows_at_utility_defined_classes_in_apply() {
        // Same name, but defined as an @utility → valid in @apply.
        let css = "@import \"tailwindcss\";\n@utility animate-fade { animation: x 1s; }\n";
        let out =
            create_class_in_css(css, "hero", &["text-2xl".into(), "animate-fade".into()]).unwrap();
        assert!(out.contains("@apply text-2xl animate-fade;"));
    }

    #[test]
    fn unsafe_tokens_ignores_utilities_and_arbitrary_values() {
        let css = ".brandbox { color: red; }";
        let kind = css_scan(css);
        // Real utilities, arbitrary values, and variants are all fine.
        assert!(unsafe_apply_tokens(
            css,
            &kind,
            &[
                "px-4".into(),
                "bg-[#fff]".into(),
                "sm:text-6xl".into(),
                "lg:text-[5.25rem]".into(),
            ],
        )
        .is_empty());
        // The plain-class token is flagged (incl. with a variant prefix).
        assert_eq!(
            unsafe_apply_tokens(css, &kind, &["brandbox".into(), "hover:brandbox".into()]),
            vec!["brandbox".to_string(), "hover:brandbox".to_string()]
        );
    }

    #[test]
    fn create_then_update_then_delete_round_trips() {
        let mut css = "@import \"tailwindcss\";\n".to_string();
        css = create_class_in_css(&css, "btn", &["px-4".into(), "py-2".into()]).unwrap();
        css = update_class_in_css(&css, "btn", &["px-6".into()]).unwrap();
        let parsed = parse_custom_classes(&css);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].tokens, vec!["px-6"]);
        css = delete_class_in_css(&css, "btn").unwrap();
        assert!(parse_custom_classes(&css).is_empty());
    }
}
