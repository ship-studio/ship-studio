//! # Internationalization (i18n) Commands
//!
//! Detects and manages built-in i18n routing configuration for Next.js
//! (Pages Router) and Astro projects — the two frameworks whose first-party
//! i18n support has a predictable, declarative config shape.
//!
//! Config edits are conservative string operations on shapes we recognize
//! (literal `locales` arrays and `defaultLocale` strings). If a config can't
//! be parsed or modified safely, commands return a `Validation` error and the
//! UI falls back to asking the AI agent — we never guess at a rewrite.

use crate::commands::projects::{is_astro_project, is_nextjs_project};
use crate::errors::CommandError;
use crate::utils::{resolve_workspace_path, validate_project_path};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tracing::info;

/// Next.js caps `i18n.locales` at 100 entries; we adopt the same limit.
const MAX_LOCALES: usize = 100;

const NEXT_CONFIG_NAMES: &[&str] = &["next.config.js", "next.config.mjs", "next.config.ts"];
const ASTRO_CONFIG_NAMES: &[&str] = &["astro.config.mjs", "astro.config.js", "astro.config.ts"];

/// next-intl's routing config — the file Ship Studio manages for App Router
/// projects. The setup prompt pins this location so detection stays reliable.
const NEXT_INTL_ROUTING_CANDIDATES: &[&str] = &[
    "src/i18n/routing.ts",
    "src/i18n/routing.tsx",
    "src/i18n/routing.js",
    "i18n/routing.ts",
    "i18n/routing.js",
];

/// Where next-intl message dictionaries conventionally live.
const MESSAGES_DIR_CANDIDATES: &[&str] = &["messages", "src/messages", "locales", "src/locales"];

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum I18nFramework {
    NextjsPages,
    NextjsApp,
    Astro,
    Unsupported,
}

#[derive(Serialize, Clone, Debug)]
pub struct I18nStatus {
    pub framework: I18nFramework,
    /// Whether Ship Studio can manage i18n for this project.
    pub supported: bool,
    /// Human-readable reason when `supported` is false.
    pub unsupported_reason: Option<String>,
    /// Whether an `i18n` block exists in the framework config.
    pub configured: bool,
    /// Locales parsed from the config (string literals only).
    pub locales: Vec<String>,
    pub default_locale: Option<String>,
    /// Config file name relative to the workspace root, when one exists.
    pub config_file: Option<String>,
    /// Set when an i18n block exists but couldn't be fully parsed.
    pub parse_warning: Option<String>,
    /// True when the project isn't manageable yet but a guided AI setup flow
    /// exists (Next.js App Router without next-intl).
    pub agent_setup_available: bool,
}

// ============ Locale validation ============

/// Validate a UTS-35-ish locale identifier (`en`, `en-US`, `zh-Hans`, `pt-BR`).
///
/// This is also an injection guard: validated locales are interpolated into
/// JS config files, so only ASCII alphanumerics and dashes may pass.
fn validate_locale(locale: &str) -> Result<(), String> {
    if locale.is_empty() {
        return Err("Locale cannot be empty".to_string());
    }
    if locale.len() > 35 {
        return Err(format!("Locale `{locale}` is too long"));
    }
    let mut segments = locale.split('-');
    let lang = segments.next().unwrap_or("");
    if lang.len() < 2 || lang.len() > 8 || !lang.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(format!(
            "Locale `{locale}` must start with a 2-8 letter language code (e.g. `en`, `fr`, `pt-BR`)"
        ));
    }
    for seg in segments {
        if seg.is_empty() || seg.len() > 8 || !seg.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(format!(
                "Locale `{locale}` has an invalid segment — use forms like `en-US` or `zh-Hans`"
            ));
        }
    }
    Ok(())
}

fn validate_locale_set(locales: &[String], default_locale: &str) -> Result<(), String> {
    if locales.is_empty() {
        return Err("At least one locale is required".to_string());
    }
    if locales.len() > MAX_LOCALES {
        return Err(format!("Too many locales (max {MAX_LOCALES})"));
    }
    let mut seen = std::collections::HashSet::new();
    for locale in locales {
        validate_locale(locale)?;
        if !seen.insert(locale.to_ascii_lowercase()) {
            return Err(format!("Duplicate locale `{locale}`"));
        }
    }
    validate_locale(default_locale)?;
    if !locales.iter().any(|l| l == default_locale) {
        return Err(format!(
            "Default locale `{default_locale}` must be one of the configured locales"
        ));
    }
    Ok(())
}

// ============ Config parsing (pure string helpers) ============

/// Byte classification produced by [`scan_source`].
#[derive(Clone, Copy, PartialEq, Debug)]
enum ByteKind {
    Code,
    /// Inside a string literal; payload = index of the opening quote.
    Str(usize),
    Comment,
}

/// One comment/string-aware pass over JS source. Classifies every byte and
/// tracks `{}` brace depth (counting only braces in real code), so every
/// parsing helper agrees on what is live code vs. comment vs. string.
struct SourceScan {
    kind: Vec<ByteKind>,
    /// Brace depth of each byte: a key directly inside the top-level config
    /// object is at depth 1; keys of nested objects (e.g. `domains` entries)
    /// are at depth 2+.
    depth: Vec<u32>,
}

fn scan_source(src: &str) -> SourceScan {
    let bytes = src.as_bytes();
    let mut kind = vec![ByteKind::Code; bytes.len()];
    let mut depth = vec![0u32; bytes.len()];
    let mut d: u32 = 0;
    let mut in_str: Option<(u8, usize)> = None;
    let mut in_line = false;
    let mut in_block = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        depth[i] = d;
        if let Some((q, s)) = in_str {
            kind[i] = ByteKind::Str(s);
            if c == b'\\' {
                if i + 1 < bytes.len() {
                    kind[i + 1] = ByteKind::Str(s);
                    depth[i + 1] = d;
                }
                i += 2;
                continue;
            }
            // Plain strings can't span lines — recover at the newline so an
            // unterminated quote doesn't swallow the rest of the file.
            if c == q || (c == b'\n' && q != b'`') {
                in_str = None;
            }
        } else if in_line {
            kind[i] = ByteKind::Comment;
            if c == b'\n' {
                in_line = false;
            }
        } else if in_block {
            kind[i] = ByteKind::Comment;
            if c == b'*' && bytes.get(i + 1) == Some(&b'/') {
                kind[i + 1] = ByteKind::Comment;
                depth[i + 1] = d;
                in_block = false;
                i += 2;
                continue;
            }
        } else {
            match c {
                b'"' | b'\'' | b'`' => {
                    in_str = Some((c, i));
                    kind[i] = ByteKind::Str(i);
                }
                b'/' if bytes.get(i + 1) == Some(&b'/') => {
                    in_line = true;
                    kind[i] = ByteKind::Comment;
                }
                b'/' if bytes.get(i + 1) == Some(&b'*') => {
                    in_block = true;
                    kind[i] = ByteKind::Comment;
                }
                b'{' => d += 1,
                b'}' => {
                    d = d.saturating_sub(1);
                    depth[i] = d;
                }
                _ => {}
            }
        }
        i += 1;
    }
    SourceScan { kind, depth }
}

fn skip_ws_and_comments(bytes: &[u8], scan: &SourceScan, mut i: usize) -> usize {
    while i < bytes.len() && (bytes[i].is_ascii_whitespace() || scan.kind[i] == ByteKind::Comment) {
        i += 1;
    }
    i
}

/// First occurrence of `pat` that is live code (not a comment or string).
fn find_in_code(src: &str, scan: &SourceScan, pat: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(rel) = src[from..].find(pat) {
        let idx = from + rel;
        from = idx + 1;
        if scan.kind[idx] == ByteKind::Code {
            return Some(idx);
        }
    }
    None
}

/// Find the byte index of the first character of the value for `key:` in JS
/// source. Comment- and string-aware (quoted keys like `"i18n":` are
/// recognized); `required_depth` restricts matches to keys of the object at
/// that brace depth — pass `Some(1)` to skip identical keys nested deeper
/// (e.g. `defaultLocale` inside Next.js `domains` entries).
fn find_key_value(src: &str, key: &str, required_depth: Option<u32>) -> Option<usize> {
    let scan = scan_source(src);
    let bytes = src.as_bytes();
    let mut from = 0;
    while let Some(rel) = src[from..].find(key) {
        let start = from + rel;
        from = start + 1;

        // Comments never count; a string occurrence only counts when the
        // string IS the key (quoted-key style, opening quote right before).
        match scan.kind[start] {
            ByteKind::Comment => continue,
            ByteKind::Str(s) if start == 0 || s != start - 1 => continue,
            _ => {}
        }

        // Word boundary before the key (or a quote for `"key":` style).
        let mut quoted = 0u8;
        if start > 0 {
            let p = bytes[start - 1];
            if p.is_ascii_alphanumeric() || p == b'_' || p == b'$' || p == b'.' {
                continue;
            }
            if p == b'"' || p == b'\'' {
                quoted = p;
            }
        }

        let mut i = start + key.len();
        if quoted != 0 {
            if bytes.get(i) != Some(&quoted) {
                continue; // `"i18n-something"` — not our key
            }
            i += 1;
        } else if bytes
            .get(i)
            .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'$' || *c == b'-')
        {
            continue; // part of a longer identifier
        }

        if let Some(d) = required_depth {
            if scan.depth[start] != d {
                continue;
            }
        }

        i = skip_ws_and_comments(bytes, &scan, i);
        if bytes.get(i) != Some(&b':') {
            continue;
        }
        i += 1;
        i = skip_ws_and_comments(bytes, &scan, i);
        if i < bytes.len() {
            return Some(i);
        }
    }
    None
}

/// Given the index of an opening `{`, `[`, or `(`, return the index of its
/// matching closer. String literals (including template literals) and
/// comments are skipped so braces inside them don't affect depth.
fn match_delim(src: &str, open_idx: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let open = *bytes.get(open_idx)?;
    let close = match open {
        b'{' => b'}',
        b'[' => b']',
        b'(' => b')',
        _ => return None,
    };
    let mut depth = 0usize;
    let mut i = open_idx;
    let mut in_str: Option<u8> = None;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = in_str {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == q {
                in_str = None;
            }
        } else if in_line_comment {
            if c == b'\n' {
                in_line_comment = false;
            }
        } else if in_block_comment {
            if c == b'*' && bytes.get(i + 1) == Some(&b'/') {
                in_block_comment = false;
                i += 1;
            }
        } else if c == b'"' || c == b'\'' || c == b'`' {
            in_str = Some(c);
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'/') {
            in_line_comment = true;
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            in_block_comment = true;
        } else if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// Extract top-level string literals from the inside of a JS array literal.
/// ANY other token at the array's top level — objects, identifiers, spreads,
/// numbers — flags `has_non_string`, so callers refuse to rewrite an array
/// they can't faithfully reproduce. Comments are ignored entirely.
fn extract_string_items(inner: &str) -> (Vec<String>, bool) {
    let bytes = inner.as_bytes();
    let mut items = Vec::new();
    let mut has_non_string = false;
    let mut depth = 0i32;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
                continue;
            }
            b'"' | b'\'' | b'`' => {
                let q = c;
                let start = i + 1;
                i += 1;
                while i < bytes.len() && bytes[i] != q {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                if depth == 0 {
                    items.push(inner[start..i.min(bytes.len())].to_string());
                }
            }
            b'{' | b'[' | b'(' => {
                if depth == 0 {
                    has_non_string = true;
                }
                depth += 1;
            }
            b'}' | b']' | b')' => depth -= 1,
            b',' => {}
            _ if c.is_ascii_whitespace() => {}
            _ => {
                if depth == 0 {
                    has_non_string = true;
                }
            }
        }
        i += 1;
    }
    (items, has_non_string)
}

/// Top-level string locales from a `locales: [...]` array in `src`, plus a
/// flag for non-string entries (objects, identifiers).
fn parse_locales_array(src: &str) -> (Vec<String>, bool) {
    match find_key_value(src, "locales", Some(1)) {
        Some(arr_idx) if src.as_bytes().get(arr_idx) == Some(&b'[') => {
            match match_delim(src, arr_idx) {
                Some(arr_end) => extract_string_items(&src[arr_idx + 1..arr_end]),
                None => (Vec::new(), true),
            }
        }
        Some(_) => (Vec::new(), true),
        None => (Vec::new(), false),
    }
}

/// The string value of `defaultLocale: '...'` in `src`, if literal.
fn parse_default_locale(src: &str) -> Option<String> {
    find_key_value(src, "defaultLocale", Some(1)).and_then(|idx| {
        let b = src.as_bytes();
        let q = *b.get(idx)?;
        if q != b'"' && q != b'\'' {
            return None;
        }
        let rest = &src[idx + 1..];
        let close = rest.find(q as char)?;
        Some(rest[..close].to_string())
    })
}

/// Parsed pieces of an existing `i18n: { ... }` block.
struct I18nBlock {
    locales: Vec<String>,
    has_non_string_locales: bool,
    default_locale: Option<String>,
}

fn parse_i18n_block(content: &str) -> Option<I18nBlock> {
    let val_idx = find_key_value(content, "i18n", Some(1))?;
    if content.as_bytes().get(val_idx) != Some(&b'{') {
        return None;
    }
    let end = match_delim(content, val_idx)?;
    let block = &content[val_idx..=end];
    let (locales, has_non_string_locales) = parse_locales_array(block);

    Some(I18nBlock {
        locales,
        has_non_string_locales,
        default_locale: parse_default_locale(block),
    })
}

// ============ Config writing (pure string helpers) ============

fn build_locales_array(locales: &[String]) -> String {
    let quoted: Vec<String> = locales.iter().map(|l| format!("'{l}'")).collect();
    format!("[{}]", quoted.join(", "))
}

fn build_i18n_snippet(locales: &[String], default_locale: &str) -> String {
    format!(
        "  i18n: {{\n    locales: {},\n    defaultLocale: '{}',\n  }},",
        build_locales_array(locales),
        default_locale
    )
}

/// Find the insertion point (just after the opening `{`) of the exported
/// config object. Recognizes the common literal and `const x = …; export
/// default x` shapes; returns None for anything else (HOC wrappers, computed
/// configs) so callers can fail loudly instead of corrupting the file.
fn find_exported_object_open(content: &str) -> Option<usize> {
    let scan = scan_source(content);
    const ANCHORS: &[&str] = &[
        "export default defineConfig({",
        "module.exports = defineConfig({",
        "module.exports = {",
        "export default {",
    ];
    for anchor in ANCHORS {
        if let Some(idx) = find_in_code(content, &scan, anchor) {
            return Some(idx + anchor.len());
        }
    }

    let ident = export_ident(content, &scan, "export default ")
        .or_else(|| export_ident(content, &scan, "module.exports = "))?;
    let bytes = content.as_bytes();
    let decl_end = ["const ", "let ", "var "].iter().find_map(|kw| {
        let pat = format!("{kw}{ident}");
        let idx = find_in_code(content, &scan, &pat)?;
        let after = idx + pat.len();
        // Reject prefix matches on longer identifiers (nextConfigFoo).
        match bytes.get(after) {
            Some(c) if c.is_ascii_alphanumeric() || *c == b'_' || *c == b'$' => None,
            _ => Some(after),
        }
    })?;
    // Skip an optional `: Type` annotation up to the `=`.
    let eq = content[decl_end..].find('=')? + decl_end;
    let mut i = eq + 1;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if content[i..].starts_with("defineConfig(") {
        i += "defineConfig(".len();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
    }
    if bytes.get(i) == Some(&b'{') {
        return Some(i + 1);
    }
    None
}

/// Capture the identifier following `pat` (e.g. `export default nextConfig`).
fn export_ident(content: &str, scan: &SourceScan, pat: &str) -> Option<String> {
    let idx = find_in_code(content, scan, pat)? + pat.len();
    let ident: String = content[idx..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
        .collect();
    if ident.is_empty() {
        None
    } else {
        Some(ident)
    }
}

/// Surgically replace the `locales: [...]` array and `defaultLocale: '...'`
/// value anywhere in `src`, leaving every other byte untouched. Works on an
/// extracted `i18n` block (Next.js/Astro) or a whole next-intl routing file.
fn replace_locales_in(
    src: &str,
    locales: &[String],
    default_locale: &str,
) -> Result<String, String> {
    let loc_idx = find_key_value(src, "locales", Some(1))
        .filter(|i| src.as_bytes().get(*i) == Some(&b'['))
        .ok_or("The existing config has no `locales` array Ship Studio can update.")?;
    let loc_end = match_delim(src, loc_idx)
        .ok_or("Couldn't parse the `locales` array (unbalanced brackets).")?;

    // Rewriting the array would drop anything that isn't a plain string —
    // e.g. Astro's `{ path, codes }` locale objects. Refuse rather than
    // silently destroy user configuration.
    let (_, has_non_string) = extract_string_items(&src[loc_idx + 1..loc_end]);
    if has_non_string {
        return Err(
            "Some locales use advanced configuration (custom paths or codes) that Ship Studio \
             can't rewrite safely — edit the locales array in the config file directly."
                .to_string(),
        );
    }

    let def_idx = find_key_value(src, "defaultLocale", Some(1))
        .ok_or("The existing config has no `defaultLocale` Ship Studio can update.")?;
    let def_quote = *src
        .as_bytes()
        .get(def_idx)
        .filter(|q| **q == b'"' || **q == b'\'')
        .ok_or("`defaultLocale` isn't a plain string Ship Studio can update.")?;
    let def_end = src[def_idx + 1..]
        .find(def_quote as char)
        .map(|i| i + def_idx + 1)
        .ok_or("Couldn't parse the `defaultLocale` value.")?;

    // Replace the later range first so the earlier offsets stay valid.
    let mut replacements = [
        (loc_idx, loc_end, build_locales_array(locales)),
        (def_idx, def_end, format!("'{default_locale}'")),
    ];
    replacements.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = src.to_string();
    for (start, end, rep) in replacements {
        out.replace_range(start..=end, &rep);
    }
    Ok(out)
}

/// Apply the desired locales to a config file's content.
///
/// If an `i18n` block exists, only the `locales` array and `defaultLocale`
/// value are replaced in place — sibling keys (`domains`, `routing`,
/// `localeDetection`, …) are preserved untouched. Otherwise a fresh block is
/// inserted at the top of the exported config object.
fn apply_i18n_to_content(
    content: &str,
    locales: &[String],
    default_locale: &str,
) -> Result<String, String> {
    if let Some(val_idx) = find_key_value(content, "i18n", Some(1)) {
        if content.as_bytes().get(val_idx) != Some(&b'{') {
            return Err(
                "An `i18n` key exists in the config but isn't a plain object Ship Studio can update."
                    .to_string(),
            );
        }
        let block_end = match_delim(content, val_idx)
            .ok_or("Couldn't parse the existing i18n block (unbalanced braces).")?;
        let block = &content[val_idx..=block_end];
        let new_block = replace_locales_in(block, locales, default_locale)?;

        let mut out = content.to_string();
        out.replace_range(val_idx..=block_end, &new_block);
        Ok(out)
    } else {
        let insert_at = find_exported_object_open(content)
            .ok_or("Ship Studio couldn't find where to add i18n settings in this config file.")?;
        let snippet = build_i18n_snippet(locales, default_locale);
        let text = if content[insert_at..].starts_with('\n') {
            format!("\n{snippet}")
        } else {
            format!("\n{snippet}\n")
        };
        let mut out = content.to_string();
        out.insert_str(insert_at, &text);
        Ok(out)
    }
}

/// Canonical config file created when the project has none.
fn default_config_content(
    framework: I18nFramework,
    locales: &[String],
    default_locale: &str,
) -> (&'static str, String) {
    let snippet = build_i18n_snippet(locales, default_locale);
    match framework {
        I18nFramework::Astro => (
            "astro.config.mjs",
            format!(
                "import {{ defineConfig }} from 'astro/config';\n\nexport default defineConfig({{\n{snippet}\n}});\n"
            ),
        ),
        _ => (
            "next.config.mjs",
            format!(
                "/** @type {{import('next').NextConfig}} */\nconst nextConfig = {{\n{snippet}\n}};\n\nexport default nextConfig;\n"
            ),
        ),
    }
}

// ============ next-intl (App Router) ============

/// Locate the next-intl routing config, if the project has one.
fn find_next_intl_routing(workspace: &Path) -> Option<&'static str> {
    NEXT_INTL_ROUTING_CANDIDATES
        .iter()
        .find(|rel| workspace.join(rel).is_file())
        .copied()
}

/// Locate the directory holding next-intl message dictionaries: the first
/// conventional candidate that exists and contains a .json file.
fn find_messages_dir(workspace: &Path) -> Option<PathBuf> {
    MESSAGES_DIR_CANDIDATES
        .iter()
        .map(|rel| workspace.join(rel))
        .find(|dir| {
            std::fs::read_dir(dir).is_ok_and(|entries| {
                entries
                    .flatten()
                    .any(|e| e.path().extension().is_some_and(|ext| ext == "json"))
            })
        })
}

/// Make sure every locale has a message dictionary. New locales are seeded
/// from the default locale's file (the site keeps working untranslated until
/// the AI translation pass runs). Existing files are never touched.
/// Returns a warning string when the messages directory can't be located.
fn ensure_message_files(
    workspace: &Path,
    locales: &[String],
    default_locale: &str,
) -> Option<String> {
    let Some(dir) = find_messages_dir(workspace) else {
        return Some(
            "Couldn't find the messages directory — create a <locale>.json file per language \
             next to your existing message dictionaries."
                .to_string(),
        );
    };
    let seed = std::fs::read_to_string(dir.join(format!("{default_locale}.json")))
        .unwrap_or_else(|_| "{}\n".to_string());
    for locale in locales {
        let path = dir.join(format!("{locale}.json"));
        if !path.exists() {
            if let Err(e) = std::fs::write(&path, &seed) {
                return Some(format!(
                    "Couldn't create {}: {e}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                ));
            }
        }
    }
    None
}

// ============ Detection & status ============

fn detect_i18n_framework(workspace: &Path) -> I18nFramework {
    if is_astro_project(workspace) {
        return I18nFramework::Astro;
    }
    if is_nextjs_project(workspace) {
        // Built-in i18n routing is a Pages Router feature. A `pages/`
        // directory (root or src/) marks the Pages Router; otherwise we
        // assume the App Router (the default for new Next.js apps).
        if workspace.join("pages").is_dir() || workspace.join("src/pages").is_dir() {
            return I18nFramework::NextjsPages;
        }
        return I18nFramework::NextjsApp;
    }
    I18nFramework::Unsupported
}

fn find_config_file(workspace: &Path, names: &[&str]) -> Option<PathBuf> {
    names.iter().map(|n| workspace.join(n)).find(|p| p.exists())
}

fn config_names_for(framework: I18nFramework) -> &'static [&'static str] {
    match framework {
        I18nFramework::Astro => ASTRO_CONFIG_NAMES,
        _ => NEXT_CONFIG_NAMES,
    }
}

fn unsupported_status(framework: I18nFramework, reason: &str) -> I18nStatus {
    I18nStatus {
        framework,
        supported: false,
        unsupported_reason: Some(reason.to_string()),
        configured: false,
        locales: Vec::new(),
        default_locale: None,
        config_file: None,
        parse_warning: None,
        agent_setup_available: false,
    }
}

/// Status for an App Router project: manageable when a next-intl routing
/// config exists, otherwise a guided agent setup is offered.
fn compute_app_router_status(workspace: &Path) -> I18nStatus {
    let Some(routing_rel) = find_next_intl_routing(workspace) else {
        let mut status = unsupported_status(
            I18nFramework::NextjsApp,
            "This Next.js project uses the App Router, which has no built-in i18n. \
             Ship Studio can set it up with next-intl — the standard library for \
             App Router projects.",
        );
        status.agent_setup_available = true;
        return status;
    };

    let mut status = I18nStatus {
        framework: I18nFramework::NextjsApp,
        supported: true,
        unsupported_reason: None,
        configured: true,
        locales: Vec::new(),
        default_locale: None,
        config_file: Some(routing_rel.to_string()),
        parse_warning: None,
        agent_setup_available: false,
    };

    let Ok(content) = std::fs::read_to_string(workspace.join(routing_rel)) else {
        status.parse_warning = Some("Couldn't read the next-intl routing config.".to_string());
        return status;
    };
    let (locales, has_non_string) = parse_locales_array(&content);
    status.locales = locales;
    status.default_locale = parse_default_locale(&content);
    if has_non_string || status.locales.is_empty() {
        status.parse_warning = Some(
            "A next-intl config exists but Ship Studio couldn't read its locales.".to_string(),
        );
    }
    status
}

/// Non-default locale URL prefixes configured for an Astro project. The page
/// selector uses these to collapse per-language page duplicates (e.g. hide
/// `/fr/about` when `/about` is the same page in the default language).
pub(crate) fn astro_locale_prefixes(workspace: &Path) -> Vec<String> {
    let Some(config_path) = find_config_file(workspace, ASTRO_CONFIG_NAMES) else {
        return Vec::new();
    };
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return Vec::new();
    };
    let Some(block) = parse_i18n_block(&content) else {
        return Vec::new();
    };
    let default = block.default_locale.unwrap_or_default();
    block
        .locales
        .into_iter()
        .filter(|l| *l != default)
        .collect()
}

/// Next.js i18n routing doesn't work with `output: 'export'` (static export
/// bypasses the routing layer entirely).
fn nextjs_uses_static_export(content: &str) -> bool {
    find_key_value(content, "output", Some(1)).is_some_and(|idx| {
        content[idx..].starts_with("'export'") || content[idx..].starts_with("\"export\"")
    })
}

fn compute_status(workspace: &Path) -> I18nStatus {
    let framework = detect_i18n_framework(workspace);
    match framework {
        I18nFramework::Unsupported => {
            return unsupported_status(
                framework,
                "Multilingual setup currently supports Next.js (Pages Router) and Astro projects.",
            );
        }
        I18nFramework::NextjsApp => {
            return compute_app_router_status(workspace);
        }
        I18nFramework::NextjsPages | I18nFramework::Astro => {}
    }

    let config_path = find_config_file(workspace, config_names_for(framework));
    let mut status = I18nStatus {
        framework,
        supported: true,
        unsupported_reason: None,
        configured: false,
        locales: Vec::new(),
        default_locale: None,
        config_file: config_path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string()),
        parse_warning: None,
        agent_setup_available: false,
    };

    let Some(config_path) = config_path else {
        return status;
    };
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        status.parse_warning = Some("Couldn't read the config file.".to_string());
        return status;
    };

    if framework == I18nFramework::NextjsPages && nextjs_uses_static_export(&content) {
        status.supported = false;
        status.unsupported_reason = Some(
            "This project uses static export (`output: 'export'`), which doesn't support \
             Next.js built-in i18n routing."
                .to_string(),
        );
    }

    if let Some(block) = parse_i18n_block(&content) {
        status.configured = true;
        status.locales = block.locales;
        status.default_locale = block.default_locale;
        if block.has_non_string_locales {
            status.parse_warning = Some(
                "Some locales use advanced configuration (custom paths or codes) and are \
                 managed directly in the config file."
                    .to_string(),
            );
        } else if status.locales.is_empty() {
            status.parse_warning = Some(
                "An i18n config exists but Ship Studio couldn't read its locales.".to_string(),
            );
        }
    }

    status
}

// ============ Tauri commands ============

/// Report the i18n state of a project: framework support, whether an i18n
/// block exists, and the configured locales.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_i18n_status(project_path: String) -> Result<I18nStatus, CommandError> {
    let project = validate_project_path(&project_path)?;
    let workspace = resolve_workspace_path(&project);
    Ok(compute_status(&workspace))
}

/// Create or update the i18n configuration: writes `locales` and
/// `defaultLocale` into the framework config, creating the config file if the
/// project has none. Fails with a `Validation` error (and changes nothing)
/// when the existing config can't be edited safely.
#[tauri::command]
#[tracing::instrument(skip(locales), fields(project = %project_path, locale_count = locales.len(), default_locale = %default_locale))]
pub async fn set_i18n_config(
    project_path: String,
    locales: Vec<String>,
    default_locale: String,
) -> Result<I18nStatus, CommandError> {
    let project = validate_project_path(&project_path)?;
    let workspace = resolve_workspace_path(&project);

    validate_locale_set(&locales, &default_locale).map_err(|reason| CommandError::Validation {
        field: "locales".to_string(),
        reason,
    })?;

    let framework = detect_i18n_framework(&workspace);
    let status = compute_status(&workspace);
    if !status.supported {
        return Err(CommandError::Validation {
            field: if status.agent_setup_available {
                // App Router without next-intl: the UI runs the guided agent
                // setup instead of this command.
                "setup".to_string()
            } else {
                "framework".to_string()
            },
            reason: status
                .unsupported_reason
                .unwrap_or_else(|| "Unsupported project type".to_string()),
        });
    }

    // App Router: the managed file is next-intl's routing config, and each
    // locale needs a message dictionary seeded from the default locale's.
    if framework == I18nFramework::NextjsApp {
        let routing_rel =
            find_next_intl_routing(&workspace).ok_or_else(|| CommandError::Validation {
                field: "setup".to_string(),
                reason: "next-intl isn't set up yet — run the setup flow first.".to_string(),
            })?;
        let routing_path = workspace.join(routing_rel);
        let content = std::fs::read_to_string(&routing_path)?;
        let updated =
            replace_locales_in(&content, &locales, &default_locale).map_err(|reason| {
                CommandError::Validation {
                    field: "config".to_string(),
                    reason,
                }
            })?;
        std::fs::write(&routing_path, updated)?;
        let messages_warning = ensure_message_files(&workspace, &locales, &default_locale);
        info!(config = routing_rel, "Updated next-intl routing config");

        let mut status = compute_status(&workspace);
        if status.parse_warning.is_none() {
            status.parse_warning = messages_warning;
        }
        return Ok(status);
    }

    match find_config_file(&workspace, config_names_for(framework)) {
        Some(config_path) => {
            let content = std::fs::read_to_string(&config_path)?;
            let updated =
                apply_i18n_to_content(&content, &locales, &default_locale).map_err(|reason| {
                    CommandError::Validation {
                        field: "config".to_string(),
                        reason,
                    }
                })?;
            std::fs::write(&config_path, updated)?;
            info!(config = %config_path.display(), "Updated i18n config");
        }
        None => {
            let (name, content) = default_config_content(framework, &locales, &default_locale);
            std::fs::write(workspace.join(name), content)?;
            info!(config = name, "Created config file with i18n block");
        }
    }

    Ok(compute_status(&workspace))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // ---- locale validation ----

    #[test]
    fn accepts_standard_locales() {
        for l in [
            "en",
            "fr",
            "en-US",
            "nl-NL",
            "zh-Hans",
            "pt-BR",
            "sr-Latn-RS",
        ] {
            assert!(validate_locale(l).is_ok(), "{l} should be valid");
        }
    }

    #[test]
    fn rejects_invalid_locales() {
        for l in [
            "",
            "e",
            "en US",
            "en'",
            "en\"",
            "1en",
            "en-",
            "en--US",
            "en_US",
            "no'); alert('x",
        ] {
            assert!(validate_locale(l).is_err(), "{l} should be rejected");
        }
    }

    #[test]
    fn locale_set_requires_default_in_list() {
        let locales = vec!["en".to_string(), "fr".to_string()];
        assert!(validate_locale_set(&locales, "en").is_ok());
        assert!(validate_locale_set(&locales, "de").is_err());
    }

    #[test]
    fn locale_set_rejects_duplicates() {
        let locales = vec!["en".to_string(), "EN".to_string()];
        assert!(validate_locale_set(&locales, "en").is_err());
    }

    // ---- parsing ----

    const NEXT_WITH_I18N: &str = r#"/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  i18n: {
    locales: ['en-US', 'fr', 'nl-NL'],
    defaultLocale: 'en-US',
  },
};

module.exports = nextConfig;
"#;

    #[test]
    fn parses_simple_i18n_block() {
        let block = parse_i18n_block(NEXT_WITH_I18N).expect("block found");
        assert_eq!(block.locales, vec!["en-US", "fr", "nl-NL"]);
        assert_eq!(block.default_locale.as_deref(), Some("en-US"));
        assert!(!block.has_non_string_locales);
    }

    #[test]
    fn ignores_commented_i18n() {
        let src = "module.exports = {\n  // i18n: { locales: ['en'] },\n};\n";
        assert!(parse_i18n_block(src).is_none());
    }

    #[test]
    fn ignores_i18n_substring_identifiers() {
        let src = "const mi18n = 1;\nmodule.exports = { useI18n: true };\n";
        assert!(parse_i18n_block(src).is_none());
    }

    #[test]
    fn parses_quoted_key() {
        let src = "module.exports = {\n  \"i18n\": {\n    locales: [\"en\", \"de\"],\n    defaultLocale: \"en\",\n  },\n};\n";
        let block = parse_i18n_block(src).expect("block found");
        assert_eq!(block.locales, vec!["en", "de"]);
        assert_eq!(block.default_locale.as_deref(), Some("en"));
    }

    #[test]
    fn flags_astro_object_locales() {
        let src = r#"export default defineConfig({
  i18n: {
    locales: ['es', 'en', { path: 'french', codes: ['fr', 'fr-CA'] }],
    defaultLocale: 'en',
  },
});
"#;
        let block = parse_i18n_block(src).expect("block found");
        assert_eq!(block.locales, vec!["es", "en"]);
        assert!(block.has_non_string_locales);
        assert_eq!(block.default_locale.as_deref(), Some("en"));
    }

    #[test]
    fn brace_matching_skips_strings_and_comments() {
        let src = "{ i18n: { locales: ['a}b'], /* } */ defaultLocale: 'a}b', // }\n } }";
        let block = parse_i18n_block(src).expect("block found");
        assert_eq!(block.locales, vec!["a}b"]);
        assert_eq!(block.default_locale.as_deref(), Some("a}b"));
    }

    #[test]
    fn nested_domain_keys_are_not_touched() {
        // `domains` entries carry their own `defaultLocale`/`locales`; only
        // the block-level (depth 1) keys may be read or written.
        let src = r#"module.exports = {
  i18n: {
    domains: [{ domain: 'example.fr', defaultLocale: 'fr', locales: ['fr-CA'] }],
    locales: ['en', 'fr'],
    defaultLocale: 'en',
  },
};
"#;
        // Read side: the top-level default, not the domain's.
        let block = parse_i18n_block(src).expect("block found");
        assert_eq!(block.default_locale.as_deref(), Some("en"));
        assert_eq!(block.locales, vec!["en", "fr"]);

        // Write side: domain entries byte-for-byte intact, top-level updated.
        let locales = vec!["en".to_string(), "de".to_string()];
        let out = apply_i18n_to_content(src, &locales, "de").unwrap();
        assert!(
            out.contains("{ domain: 'example.fr', defaultLocale: 'fr', locales: ['fr-CA'] }"),
            "domain entry must be untouched: {out}"
        );
        assert!(out.contains("locales: ['en', 'de']"));
        assert!(out.contains("defaultLocale: 'de'"));
    }

    #[test]
    fn block_commented_i18n_is_dead_config() {
        let src = "module.exports = {\n  /*\n  i18n: {\n    locales: ['en'],\n    defaultLocale: 'en',\n  },\n  */\n  reactStrictMode: true,\n};\n";
        assert!(
            parse_i18n_block(src).is_none(),
            "commented config is not live"
        );
        // Saving must insert a fresh live block, not edit inside the comment.
        let locales = vec!["en".to_string(), "fr".to_string()];
        let out = apply_i18n_to_content(src, &locales, "en").unwrap();
        let block = parse_i18n_block(&out).expect("new live block");
        assert_eq!(block.locales, vec!["en", "fr"]);
        assert!(out.contains("/*"), "original comment preserved");
    }

    #[test]
    fn url_in_string_does_not_hide_same_line_keys() {
        // A `//` inside a string (e.g. an https URL) must not make the rest
        // of the line invisible — that would insert a duplicate i18n block.
        let src = "module.exports = { assetPrefix: 'https://cdn.example.com', i18n: { locales: ['en'], defaultLocale: 'en' } };\n";
        let block = parse_i18n_block(src).expect("block found despite URL");
        assert_eq!(block.locales, vec!["en"]);

        let locales = vec!["en".to_string(), "fr".to_string()];
        let out = apply_i18n_to_content(src, &locales, "en").unwrap();
        assert_eq!(out.matches("i18n:").count(), 1, "no duplicate block: {out}");
        assert!(out.contains("locales: ['en', 'fr']"));
    }

    #[test]
    fn refuses_identifier_and_spread_locales() {
        for arr in [
            "locales: ['en', FRENCH_LOCALE]",
            "locales: [...SHARED, 'fr']",
        ] {
            let src = format!("module.exports = {{ i18n: {{ {arr}, defaultLocale: 'en' }} }};\n");
            let locales = vec!["en".to_string()];
            assert!(
                apply_i18n_to_content(&src, &locales, "en").is_err(),
                "must refuse to rewrite: {arr}"
            );
        }
    }

    #[test]
    fn comments_inside_locales_array_are_ignored() {
        let (items, non_string) = extract_string_items("'en', /* 'fr', */ 'de' // 'es'");
        assert_eq!(items, vec!["en", "de"]);
        assert!(!non_string);
    }

    #[test]
    fn insertion_anchor_ignores_comments() {
        // The commented-out anchor must not win — and without a live anchor
        // this wrapped config has no safe insertion point.
        let src = "// module.exports = {\nmodule.exports = withPlugins({});\n";
        assert!(find_exported_object_open(src).is_none());
    }

    #[test]
    fn detects_static_export() {
        assert!(nextjs_uses_static_export(
            "module.exports = { output: 'export' };"
        ));
        assert!(nextjs_uses_static_export(
            "module.exports = { output: \"export\" };"
        ));
        assert!(!nextjs_uses_static_export(
            "module.exports = { output: 'standalone' };"
        ));
        assert!(!nextjs_uses_static_export("module.exports = {};"));
    }

    // ---- insertion points ----

    #[test]
    fn finds_insertion_in_common_shapes() {
        for src in [
            "module.exports = {\n  reactStrictMode: true,\n};\n",
            "export default {\n};\n",
            "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",
            "const nextConfig = {\n};\nmodule.exports = nextConfig;\n",
            "const nextConfig = {\n};\nexport default nextConfig;\n",
            "import type { NextConfig } from 'next';\nconst nextConfig: NextConfig = {\n};\nexport default nextConfig;\n",
            "const config = defineConfig({\n});\nexport default config;\n",
        ] {
            assert!(
                find_exported_object_open(src).is_some(),
                "should find insertion point in: {src}"
            );
        }
    }

    #[test]
    fn refuses_wrapped_configs() {
        let src =
            "const withMDX = require('@next/mdx')();\nmodule.exports = withMDX(nextConfig);\n";
        assert!(find_exported_object_open(src).is_none());
    }

    #[test]
    fn does_not_match_longer_identifier_declaration() {
        let src = "const nextConfigFactory = () => ({});\nexport default nextConfig;\n";
        assert!(find_exported_object_open(src).is_none());
    }

    // ---- applying changes ----

    #[test]
    fn inserts_block_into_next_config() {
        let src = "module.exports = {\n  reactStrictMode: true,\n};\n";
        let locales = vec!["en".to_string(), "es".to_string()];
        let out = apply_i18n_to_content(src, &locales, "en").unwrap();
        assert_eq!(
            out,
            "module.exports = {\n  i18n: {\n    locales: ['en', 'es'],\n    defaultLocale: 'en',\n  },\n  reactStrictMode: true,\n};\n"
        );
        // Round-trip: the result must parse back to what we wrote.
        let block = parse_i18n_block(&out).expect("round-trip parse");
        assert_eq!(block.locales, vec!["en", "es"]);
        assert_eq!(block.default_locale.as_deref(), Some("en"));
    }

    #[test]
    fn inserts_block_into_empty_define_config() {
        let src =
            "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({});\n";
        let locales = vec!["en".to_string(), "fr".to_string()];
        let out = apply_i18n_to_content(src, &locales, "en").unwrap();
        assert_eq!(
            out,
            "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n  i18n: {\n    locales: ['en', 'fr'],\n    defaultLocale: 'en',\n  },\n});\n"
        );
    }

    #[test]
    fn updates_existing_block_surgically() {
        let locales = vec!["en-US".to_string(), "de".to_string()];
        let out = apply_i18n_to_content(NEXT_WITH_I18N, &locales, "de").unwrap();
        assert!(out.contains("locales: ['en-US', 'de']"));
        assert!(out.contains("defaultLocale: 'de'"));
        assert!(out.contains("reactStrictMode: true"), "siblings preserved");
        assert!(!out.contains("nl-NL"));
    }

    #[test]
    fn update_preserves_sibling_i18n_keys() {
        let src = r#"module.exports = {
  i18n: {
    locales: ['en'],
    defaultLocale: 'en',
    localeDetection: false,
    domains: [{ domain: 'example.fr', defaultLocale: 'fr' }],
  },
};
"#;
        let locales = vec!["en".to_string(), "fr".to_string()];
        let out = apply_i18n_to_content(src, &locales, "en").unwrap();
        assert!(out.contains("locales: ['en', 'fr']"));
        assert!(out.contains("localeDetection: false"));
        assert!(out.contains("domain: 'example.fr'"));
        // The domains entry's own defaultLocale must be untouched: only the
        // first (block-level) defaultLocale is replaced, and it keeps 'en'.
        assert!(out.contains("defaultLocale: 'fr'"));
    }

    #[test]
    fn refuses_to_rewrite_object_locales() {
        // Astro `{ path, codes }` entries would be silently destroyed by an
        // array rewrite — the update must fail instead.
        let src = r#"export default defineConfig({
  i18n: {
    locales: ['es', 'en', { path: 'french', codes: ['fr', 'fr-CA'] }],
    defaultLocale: 'en',
  },
});
"#;
        let locales = vec!["es".to_string(), "en".to_string(), "de".to_string()];
        let err = apply_i18n_to_content(src, &locales, "en").unwrap_err();
        assert!(err.contains("advanced configuration"), "got: {err}");
    }

    #[test]
    fn errors_on_unparseable_existing_block() {
        let src = "module.exports = { i18n: makeI18n() };\n";
        let locales = vec!["en".to_string()];
        assert!(apply_i18n_to_content(src, &locales, "en").is_err());
    }

    #[test]
    fn errors_on_wrapped_config_without_block() {
        let src = "module.exports = withPlugins([], { reactStrictMode: true });\n";
        let locales = vec!["en".to_string()];
        assert!(apply_i18n_to_content(src, &locales, "en").is_err());
    }

    #[test]
    fn default_next_config_round_trips() {
        let locales = vec!["en".to_string(), "ja".to_string()];
        let (name, content) = default_config_content(I18nFramework::NextjsPages, &locales, "en");
        assert_eq!(name, "next.config.mjs");
        let block = parse_i18n_block(&content).expect("parses");
        assert_eq!(block.locales, vec!["en", "ja"]);
        assert!(find_exported_object_open(&content).is_some());
    }

    #[test]
    fn default_astro_config_round_trips() {
        let locales = vec!["en".to_string(), "ko".to_string()];
        let (name, content) = default_config_content(I18nFramework::Astro, &locales, "en");
        assert_eq!(name, "astro.config.mjs");
        let block = parse_i18n_block(&content).expect("parses");
        assert_eq!(block.locales, vec!["en", "ko"]);
        assert_eq!(block.default_locale.as_deref(), Some("en"));
    }

    // ---- framework detection & status ----

    fn write(dir: &TempDir, name: &str, content: &str) {
        let path = dir.path().join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn detects_nextjs_pages_router() {
        let tmp = TempDir::new().unwrap();
        write(&tmp, "package.json", r#"{"dependencies":{"next":"14"}}"#);
        std::fs::create_dir_all(tmp.path().join("pages")).unwrap();
        assert_eq!(
            detect_i18n_framework(tmp.path()),
            I18nFramework::NextjsPages
        );
    }

    #[test]
    fn detects_nextjs_src_pages_router() {
        let tmp = TempDir::new().unwrap();
        write(&tmp, "package.json", r#"{"dependencies":{"next":"14"}}"#);
        std::fs::create_dir_all(tmp.path().join("src/pages")).unwrap();
        assert_eq!(
            detect_i18n_framework(tmp.path()),
            I18nFramework::NextjsPages
        );
    }

    #[test]
    fn detects_nextjs_app_router() {
        let tmp = TempDir::new().unwrap();
        write(&tmp, "package.json", r#"{"dependencies":{"next":"14"}}"#);
        std::fs::create_dir_all(tmp.path().join("app")).unwrap();
        assert_eq!(detect_i18n_framework(tmp.path()), I18nFramework::NextjsApp);
    }

    #[test]
    fn detects_astro() {
        let tmp = TempDir::new().unwrap();
        write(&tmp, "astro.config.mjs", "export default {};");
        assert_eq!(detect_i18n_framework(tmp.path()), I18nFramework::Astro);
    }

    #[test]
    fn detects_unsupported() {
        let tmp = TempDir::new().unwrap();
        write(&tmp, "package.json", r#"{"name":"x"}"#);
        assert_eq!(
            detect_i18n_framework(tmp.path()),
            I18nFramework::Unsupported
        );
    }

    #[test]
    fn status_unconfigured_next_pages() {
        let tmp = TempDir::new().unwrap();
        write(&tmp, "package.json", r#"{"dependencies":{"next":"14"}}"#);
        std::fs::create_dir_all(tmp.path().join("pages")).unwrap();
        let status = compute_status(tmp.path());
        assert!(status.supported);
        assert!(!status.configured);
        assert_eq!(status.config_file, None);
    }

    #[test]
    fn status_configured_next_pages() {
        let tmp = TempDir::new().unwrap();
        write(&tmp, "next.config.js", NEXT_WITH_I18N);
        std::fs::create_dir_all(tmp.path().join("pages")).unwrap();
        let status = compute_status(tmp.path());
        assert!(status.supported);
        assert!(status.configured);
        assert_eq!(status.locales, vec!["en-US", "fr", "nl-NL"]);
        assert_eq!(status.default_locale.as_deref(), Some("en-US"));
        assert_eq!(status.config_file.as_deref(), Some("next.config.js"));
        assert!(status.parse_warning.is_none());
    }

    #[test]
    fn status_blocks_static_export() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp,
            "next.config.js",
            "module.exports = { output: 'export' };\n",
        );
        std::fs::create_dir_all(tmp.path().join("pages")).unwrap();
        let status = compute_status(tmp.path());
        assert!(!status.supported);
        assert!(status.unsupported_reason.unwrap().contains("static export"));
    }

    #[test]
    fn status_app_router_unsupported() {
        let tmp = TempDir::new().unwrap();
        write(&tmp, "package.json", r#"{"dependencies":{"next":"14"}}"#);
        std::fs::create_dir_all(tmp.path().join("app")).unwrap();
        let status = compute_status(tmp.path());
        assert!(!status.supported);
        assert_eq!(status.framework, I18nFramework::NextjsApp);
        assert!(status.unsupported_reason.unwrap().contains("App Router"));
    }

    // ---- next-intl (App Router) ----

    const ROUTING_TS: &str = r#"import {defineRouting} from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['en', 'de'],
  defaultLocale: 'en'
});
"#;

    #[test]
    fn status_app_router_with_next_intl_is_managed() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp,
            "package.json",
            r#"{"dependencies":{"next":"15","next-intl":"4"}}"#,
        );
        std::fs::create_dir_all(tmp.path().join("app")).unwrap();
        write(&tmp, "src/i18n/routing.ts", ROUTING_TS);
        let status = compute_status(tmp.path());
        assert_eq!(status.framework, I18nFramework::NextjsApp);
        assert!(status.supported);
        assert!(status.configured);
        assert_eq!(status.locales, vec!["en", "de"]);
        assert_eq!(status.default_locale.as_deref(), Some("en"));
        assert_eq!(status.config_file.as_deref(), Some("src/i18n/routing.ts"));
        assert!(!status.agent_setup_available);
        assert!(status.parse_warning.is_none());
    }

    #[test]
    fn status_app_router_without_next_intl_offers_setup() {
        let tmp = TempDir::new().unwrap();
        write(&tmp, "package.json", r#"{"dependencies":{"next":"15"}}"#);
        std::fs::create_dir_all(tmp.path().join("app")).unwrap();
        let status = compute_status(tmp.path());
        assert_eq!(status.framework, I18nFramework::NextjsApp);
        assert!(!status.supported);
        assert!(status.agent_setup_available);
        assert!(status.unsupported_reason.unwrap().contains("next-intl"));
    }

    #[test]
    fn replace_locales_in_routing_file() {
        let locales: Vec<String> = ["en", "fr", "ja"].iter().map(|s| s.to_string()).collect();
        let out = replace_locales_in(ROUTING_TS, &locales, "fr").unwrap();
        assert!(out.contains("locales: ['en', 'fr', 'ja']"));
        assert!(out.contains("defaultLocale: 'fr'"));
        assert!(out.contains("import {defineRouting} from 'next-intl/routing';"));
        assert!(out.contains("export const routing = defineRouting({"));
    }

    #[test]
    fn ensure_message_files_seeds_from_default() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp,
            "messages/en.json",
            "{\"HomePage\":{\"title\":\"Hi\"}}\n",
        );
        let locales: Vec<String> = ["en", "fr"].iter().map(|s| s.to_string()).collect();
        let warning = ensure_message_files(tmp.path(), &locales, "en");
        assert!(warning.is_none());
        let fr = std::fs::read_to_string(tmp.path().join("messages/fr.json")).unwrap();
        assert_eq!(fr, "{\"HomePage\":{\"title\":\"Hi\"}}\n");
    }

    #[test]
    fn ensure_message_files_never_overwrites() {
        let tmp = TempDir::new().unwrap();
        write(&tmp, "messages/en.json", "{\"a\":\"1\"}\n");
        write(&tmp, "messages/fr.json", "{\"a\":\"un\"}\n");
        let locales: Vec<String> = ["en", "fr"].iter().map(|s| s.to_string()).collect();
        assert!(ensure_message_files(tmp.path(), &locales, "en").is_none());
        let fr = std::fs::read_to_string(tmp.path().join("messages/fr.json")).unwrap();
        assert_eq!(fr, "{\"a\":\"un\"}\n", "existing dictionaries untouched");
    }

    #[test]
    fn ensure_message_files_warns_without_messages_dir() {
        let tmp = TempDir::new().unwrap();
        let locales: Vec<String> = vec!["en".to_string()];
        assert!(ensure_message_files(tmp.path(), &locales, "en").is_some());
    }

    // ---- astro locale prefixes (page selector support) ----

    #[test]
    fn astro_locale_prefixes_excludes_default() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp,
            "astro.config.mjs",
            "export default defineConfig({\n  i18n: {\n    locales: ['en', 'fr', 'de'],\n    defaultLocale: 'en',\n  },\n});\n",
        );
        assert_eq!(astro_locale_prefixes(tmp.path()), vec!["fr", "de"]);
    }

    #[test]
    fn astro_locale_prefixes_empty_without_i18n() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp,
            "astro.config.mjs",
            "export default defineConfig({});\n",
        );
        assert!(astro_locale_prefixes(tmp.path()).is_empty());
        let empty = TempDir::new().unwrap();
        assert!(astro_locale_prefixes(empty.path()).is_empty());
    }

    #[test]
    fn status_astro_configured() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp,
            "astro.config.mjs",
            "import { defineConfig } from 'astro/config';\nexport default defineConfig({\n  i18n: {\n    locales: ['en', 'es'],\n    defaultLocale: 'en',\n  },\n});\n",
        );
        let status = compute_status(tmp.path());
        assert_eq!(status.framework, I18nFramework::Astro);
        assert!(status.supported);
        assert!(status.configured);
        assert_eq!(status.locales, vec!["en", "es"]);
    }
}
