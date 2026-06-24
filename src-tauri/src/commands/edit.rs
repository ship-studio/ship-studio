//! # Live Tailwind Editor — source resolution & write-back
//!
//! The visual editor maps a clicked DOM element back to the exact `className`
//! string literal in source, then surgically rewrites that literal on commit.
//!
//! ## Why string search (not a build plugin)
//! Tailwind class strings reach the DOM verbatim in dev (no CSS-modules hashing,
//! no rewrite), so a clicked element's `class` attribute *is* the authored
//! `className`. We locate the source by searching the project for that exact
//! literal, then disambiguate repeated strings with element context (tag, text,
//! and the nearest ancestor whose class is unique-in-source). A custom Babel/SWC
//! plugin would be more precise, but Babel breaks `next/font` and an SWC plugin
//! needs WASM authoring + a Next-version floor — neither is worth it for v1.
//!
//! Only **static** string classNames are indexed; dynamic ones (`clsx(...)`,
//! props, interpolated template literals) never match a source literal and are
//! reported read-only. A class string that matches several identical source
//! literals resolves to `Multi` — editable as a group (write all) or one at a
//! time — so the resolver never guesses a single wrong edit target.

use crate::commands::projects::detect_project_type;
use crate::errors::CommandError;
use crate::types::ProjectType;
use crate::utils::validate_project_path;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Source file extensions we index for class literals, by project shape. `.html`
/// is editable *source* only for a plain static-HTML project. In a JS-framework
/// project (Next, Astro, Svelte, …) the real source is `.tsx`/`.astro`/etc. and
/// any `.html` is an export or fixture (e.g. a Webflow export — easily megabytes
/// across many files); indexing it on every walk is pure cost and can stall the
/// resolver, so it's excluded there.
const SOURCE_EXTS_STATIC: &[&str] = &["tsx", "jsx", "astro", "liquid", "html"];
const SOURCE_EXTS_FRAMEWORK: &[&str] = &["tsx", "jsx", "astro", "liquid"];

/// The source extensions to index for `root`, including `.html` only for static
/// HTML projects. Cheap — `detect_project_type` is cached.
fn source_exts(root: &Path) -> &'static [&'static str] {
    match detect_project_type(root) {
        ProjectType::Statichtml => SOURCE_EXTS_STATIC,
        _ => SOURCE_EXTS_FRAMEWORK,
    }
}

/// Class-bearing attribute names to scan, by file extension. React/JSX
/// (`.tsx`/`.jsx`) authors write `className`; Astro `.astro` templates use the
/// HTML `class` attribute, while React/Preact islands embedded in `.astro` still
/// use `className` — so Astro files scan for both. Shopify Liquid and plain
/// `.html` templates only ever use `class`.
fn attrs_for_ext(ext: &str) -> &'static [&'static str] {
    match ext {
        "astro" => &["className", "class"],
        "liquid" | "html" => &["class"],
        _ => &["className"],
    }
}

/// Same as [`attrs_for_ext`] but from a path/filename (uses the trailing extension).
fn attrs_for_path(file: &str) -> &'static [&'static str] {
    let ext = file.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    attrs_for_ext(&ext)
}

/// Signature of the clicked element, reported by the in-iframe selection script.
/// Fields are camelCase to match the script's `postMessage` payload verbatim.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementSignature {
    /// The element's exact `class` attribute (== authored className for static cases).
    pub class_name: String,
    /// Lowercased DOM tag name (e.g. "div", "section", "a").
    pub tag_name: String,
    /// Trimmed text content, if any (used to disambiguate repeated class strings).
    #[serde(default)]
    pub text: Option<String>,
    /// Ancestor class strings, nearest-first, used to anchor to a component/file.
    #[serde(default)]
    pub ancestor_classes: Vec<String>,
    /// The element's raw `src` attribute (images) — the image-source resolver's
    /// search key when there's no class anchor.
    #[serde(default)]
    pub attr_src: Option<String>,
}

/// One source location of a className literal.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Location {
    /// Path relative to the project root, POSIX-style.
    pub file: String,
    /// 1-based line of the className literal's value.
    pub line: usize,
    /// 1-based column of the className literal's value.
    pub column: usize,
}

/// Result of resolving an element to a source location.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Resolution {
    /// A single confident source location was found.
    Resolved {
        /// Path relative to the project root, POSIX-style.
        file: String,
        /// 1-based line of the className literal's value.
        line: usize,
        /// 1-based column of the className literal's value.
        column: usize,
        /// The exact className string at that location (write-back's drift baseline).
        class_name: String,
        /// How the match was reached: "unique" | "tag" | "text" | "ancestor".
        confidence: String,
    },
    /// The class string matched multiple source literals we can't tell apart — all
    /// byte-identical, so it's still editable: write to all (default) or pick one.
    Multi {
        /// Every distinct source location with this class string.
        locations: Vec<Location>,
        /// The shared class string (identical at every location; the drift baseline).
        class_name: String,
    },
    /// No static source match — dynamic className, or a generated/runtime class.
    ReadOnly { reason: String },
}

/// One occurrence of a static `className="..."` literal found in source.
#[derive(Debug, Clone)]
struct Occurrence {
    class_name: String,
    /// Project-relative POSIX path.
    file: String,
    line: usize,
    column: usize,
    /// Lowercased nearest opening-tag identifier (soft signal; component tags
    /// like `Image` won't match the rendered DOM tag, so this never hard-filters).
    tag: String,
}

/// A located className literal within a single file, with byte range for surgical edits.
#[derive(Debug, Clone)]
struct Span {
    value: String,
    /// Byte offset of the first character inside the quotes.
    value_start: usize,
    /// Byte offset just past the last character inside the quotes.
    value_end: usize,
    line: usize,
    column: usize,
    tag: String,
}

/// Bytes that can extend an attribute/identifier name. Includes `-` so a needle
/// like `src` never matches inside `data-src=` (JSX identifiers can't contain `-`,
/// so this never rejects a real `className=`).
fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b == b'-'
}

/// React/JSX `className` only. Production callers use [`find_attr_spans`] with the
/// attribute set chosen by file extension; this thin wrapper keeps the className
/// unit tests terse.
#[cfg(test)]
fn find_classname_spans(src: &str) -> Vec<Span> {
    find_attr_spans(src, &["className"])
}

/// Find every static class string literal in a source file for the given attribute
/// names (`className` for JSX, plus `class` for Astro). Handles `attr="..."`,
/// `attr={"..."}`, single quotes, and backtick literals with no `${...}`
/// interpolation. Dynamic forms (`clsx(...)`, `class:list`, ternaries, variables)
/// are skipped — left unindexed → read-only. Hand-written rather than regex to
/// avoid catastrophic backtracking and an extra dependency.
///
/// Scanning `class` and `className` over the same source never double-counts: the
/// `=`-after-the-name check rejects the `class` prefix of a `className=` attribute
/// (the next char is `N`, not `=`), so each literal is found by exactly one needle.
fn find_attr_spans(src: &str, attrs: &[&str]) -> Vec<Span> {
    let bytes = src.as_bytes();
    let mut spans = Vec::new();
    let skip_ws = |mut k: usize| {
        while k < bytes.len() && (bytes[k] as char).is_whitespace() {
            k += 1;
        }
        k
    };

    for needle in attrs {
        let needle = *needle;
        let mut search_from = 0;
        while let Some(rel) = src[search_from..].find(needle) {
            let i = search_from + rel;
            search_from = i + needle.len();

            // Must be a standalone identifier (not `myClassName`, `setClassName`,
            // and for the `class` needle not `class Foo {}` / `classList`).
            if i > 0 && is_ident_byte(bytes[i - 1]) {
                continue;
            }

            let mut j = i + needle.len();
            j = skip_ws(j);
            if j >= bytes.len() || bytes[j] != b'=' {
                continue;
            }
            j = skip_ws(j + 1);
            // Optional JSXExpressionContainer wrapper: `={ "..." }`.
            if j < bytes.len() && bytes[j] == b'{' {
                j = skip_ws(j + 1);
            }
            if j >= bytes.len() {
                continue;
            }
            let quote = bytes[j];
            if quote != b'"' && quote != b'\'' && quote != b'`' {
                // Dynamic expression (clsx(...), a variable, cn(...)) — skip.
                continue;
            }
            let value_start = j + 1;
            // Find the matching closing quote. For " and ' there are effectively no
            // escaped quotes inside Tailwind class strings; for ` we also reject
            // interpolation.
            let mut k = value_start;
            let mut dynamic = false;
            while k < bytes.len() {
                let b = bytes[k];
                if quote == b'`' && b == b'$' && k + 1 < bytes.len() && bytes[k + 1] == b'{' {
                    dynamic = true;
                    break;
                }
                if b == quote {
                    break;
                }
                k += 1;
            }
            if dynamic || k >= bytes.len() || bytes[k] != quote {
                continue;
            }
            let value_end = k;
            let value = src[value_start..value_end].to_string();

            // 1-based line/column of value_start.
            let prefix = &src[..value_start];
            let line = prefix.bytes().filter(|&b| b == b'\n').count() + 1;
            let column = value_start - prefix.rfind('\n').map(|p| p + 1).unwrap_or(0) + 1;

            // Nearest opening tag before the attribute, for soft tag matching.
            let tag = nearest_tag(&src[..i]);

            spans.push(Span {
                value,
                value_start,
                value_end,
                line,
                column,
                tag,
            });
        }
    }
    // Multiple needles scan independently; keep source order for deterministic
    // resolution and write-back.
    spans.sort_by_key(|s| s.value_start);
    spans
}

/// Walk backwards to the nearest `<Identifier` and return it lowercased.
fn nearest_tag(prefix: &str) -> String {
    if let Some(lt) = prefix.rfind('<') {
        let after = &prefix[lt + 1..];
        let ident: String = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '_')
            .collect();
        return ident.to_ascii_lowercase();
    }
    String::new()
}

/// Short-lived cache of the per-project className index, so rapid element clicks
/// don't rescan the whole project each time. A stale entry only risks a rejected
/// save (the write-back re-verifies the source literal), never a wrong edit —
/// explicit invalidation on our own edits plus a short TTL keep it fresh.
static INDEX_CACHE: std::sync::LazyLock<
    std::sync::Mutex<
        std::collections::HashMap<
            std::path::PathBuf,
            (std::time::Instant, std::sync::Arc<Vec<Occurrence>>),
        >,
    >,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
const INDEX_TTL: std::time::Duration = std::time::Duration::from_secs(10);

/// The className index for `root`, from cache when fresh, else freshly built + stored.
fn index_occurrences_cached(root: &Path) -> std::sync::Arc<Vec<Occurrence>> {
    let key = root.to_path_buf();
    if let Ok(cache) = INDEX_CACHE.lock() {
        if let Some((at, idx)) = cache.get(&key) {
            if at.elapsed() < INDEX_TTL {
                return idx.clone();
            }
        }
    }
    let idx = std::sync::Arc::new(index_occurrences(root));
    if let Ok(mut cache) = INDEX_CACHE.lock() {
        cache.insert(key, (std::time::Instant::now(), idx.clone()));
    }
    idx
}

/// Drop the cached indexes for `root` after a write so the next resolve sees source.
fn invalidate_index_cache(root: &Path) {
    if let Ok(mut cache) = INDEX_CACHE.lock() {
        cache.remove(root);
    }
    if let Ok(mut cache) = TEXT_INDEX_CACHE.lock() {
        cache.remove(root);
    }
}

/// Index every static className occurrence under `root` (skips node_modules,
/// .next, .git, etc. via the `ignore` walker which also honors .gitignore).
fn index_occurrences(root: &Path) -> Vec<Occurrence> {
    let mut out = Vec::new();
    let exts = source_exts(root);
    let walker = ignore::WalkBuilder::new(root)
        .standard_filters(true)
        .build();
    for entry in walker.flatten() {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !exts.contains(&ext.as_str()) {
            continue;
        }
        let Ok(src) = std::fs::read_to_string(path) else {
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        for span in find_attr_spans(&src, attrs_for_ext(&ext)) {
            out.push(Occurrence {
                class_name: span.value,
                file: rel.clone(),
                line: span.line,
                column: span.column,
                tag: span.tag,
            });
        }
    }
    out
}

/// Distinct (file, line) locations among a candidate set.
fn distinct_locs(cands: &[&Occurrence]) -> usize {
    let mut set = std::collections::HashSet::new();
    for c in cands {
        set.insert((c.file.as_str(), c.line));
    }
    set.len()
}

fn resolved(o: &Occurrence, confidence: &str) -> Resolution {
    Resolution::Resolved {
        file: o.file.clone(),
        line: o.line,
        column: o.column,
        class_name: o.class_name.clone(),
        confidence: confidence.to_string(),
    }
}

/// Core resolution logic, separated from the Tauri command for unit testing.
fn resolve(occurrences: &[Occurrence], sig: &ElementSignature) -> Resolution {
    let exact: Vec<&Occurrence> = occurrences
        .iter()
        .filter(|o| o.class_name == sig.class_name)
        .collect();

    if exact.is_empty() {
        return Resolution::ReadOnly {
            reason: "These classes aren't a static string in source (dynamic or generated) — not editable in v1.".into(),
        };
    }
    if exact.len() == 1 {
        return resolved(exact[0], "unique");
    }

    // >1: narrow by tag (soft — only if it leaves candidates).
    let tag_filtered: Vec<&Occurrence> = exact
        .iter()
        .copied()
        .filter(|o| o.tag == sig.tag_name)
        .collect();
    let pool: Vec<&Occurrence> = if tag_filtered.is_empty() {
        exact.clone()
    } else {
        tag_filtered
    };
    if distinct_locs(&pool) == 1 {
        return resolved(pool[0], "tag");
    }

    // (Text-content disambiguation is a future rung — `sig.text` is captured but
    // not yet consulted; tag + ancestor anchoring already resolves ~78% on real
    // pages. See /tmp/resolver-accuracy.mjs harness.)

    // Ancestor anchor: nearest ancestor whose class is unique-in-source pins a
    // file; keep candidates in that file.
    for anc in &sig.ancestor_classes {
        let anc_occ: Vec<&Occurrence> = occurrences
            .iter()
            .filter(|o| &o.class_name == anc)
            .collect();
        if anc_occ.len() == 1 {
            let file = &anc_occ[0].file;
            let in_file: Vec<&Occurrence> =
                pool.iter().copied().filter(|o| &o.file == file).collect();
            if distinct_locs(&in_file) == 1 {
                return resolved(in_file[0], "ancestor");
            }
            // Anchored the file but still multiple lines — stop; ambiguous.
            break;
        }
    }

    // Multiple distinct source literals, all identical — editable as a group.
    let mut seen = std::collections::HashSet::new();
    let mut locations: Vec<Location> = Vec::new();
    for o in &pool {
        if seen.insert((o.file.clone(), o.line)) {
            locations.push(Location {
                file: o.file.clone(),
                line: o.line,
                column: o.column,
            });
        }
    }
    locations.sort_by(|a, b| (a.file.as_str(), a.line).cmp(&(b.file.as_str(), b.line)));
    Resolution::Multi {
        locations,
        class_name: sig.class_name.clone(),
    }
}

/// Collapse every run of whitespace to a single space (for matching DOM text,
/// which is whitespace-collapsed, against multi-line JSX source).
fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// When several byte-identical className literals match (a shared utility string
/// on distinct elements), pin the one the user actually clicked using its text
/// content. The clicked element's text is unique to its source location even when
/// the className isn't, so reading each candidate's source and keeping the one
/// whose body contains that text resolves "edit just this element" precisely.
/// Returns a single `Resolved("text")` only on an unambiguous match — otherwise
/// `None`, leaving the `Multi` result (edit-all / pick-one) intact.
fn disambiguate_by_text(
    root: &Path,
    locations: &[Location],
    class_name: &str,
    text: &str,
) -> Option<Resolution> {
    let needle = normalize_ws(text);
    // Too short to be distinctive (e.g. "More", "→") — don't risk a false pin.
    if needle.chars().count() < 8 {
        return None;
    }
    // Match on a bounded prefix: the source window may truncate a long paragraph.
    let probe: String = needle.chars().take(60).collect();
    let mut matched: Vec<&Location> = Vec::new();
    for loc in locations {
        let Ok(src) = std::fs::read_to_string(root.join(&loc.file)) else {
            continue;
        };
        let lines: Vec<&str> = src.lines().collect();
        let start = loc.line.saturating_sub(1);
        if start >= lines.len() {
            continue;
        }
        // Look from the className line through the element body (bounded look-ahead).
        let end = (start + 30).min(lines.len());
        if normalize_ws(&lines[start..end].join(" ")).contains(&probe) {
            matched.push(loc);
        }
    }
    match matched.as_slice() {
        [loc] => Some(Resolution::Resolved {
            file: loc.file.clone(),
            line: loc.line,
            column: loc.column,
            class_name: class_name.to_string(),
            confidence: "text".into(),
        }),
        _ => None,
    }
}

/// Resolve a clicked element to its source className location.
#[tauri::command]
#[tracing::instrument(skip(signature), fields(project = %project_path, tag = %signature.tag_name))]
pub fn resolve_classname_source(
    project_path: String,
    signature: ElementSignature,
) -> Result<Resolution, CommandError> {
    let root = validate_project_path(&project_path)?;
    let occurrences = index_occurrences_cached(&root);
    let resolution = resolve(occurrences.as_slice(), &signature);
    // Last rung: a shared className resolved to Multi can often still be pinned to
    // the clicked element by its (unique) text content — so "edit this element"
    // and "create a class from it" touch only that element, not its lookalikes.
    if let Resolution::Multi {
        locations,
        class_name,
    } = &resolution
    {
        if let Some(text) = signature.text.as_deref() {
            if let Some(pinned) = disambiguate_by_text(&root, locations, class_name, text) {
                return Ok(pinned);
            }
        }
    }
    Ok(resolution)
}

/// Surgically replace one className literal's value, after verifying the current
/// value still matches `old_class` (guards against the user having edited the
/// file directly since selection). Only the literal's value is touched; the rest
/// of the file — including formatting — is preserved byte-for-byte.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, file = %file, line = line))]
pub fn apply_classname_edit(
    project_path: String,
    file: String,
    line: usize,
    old_class: String,
    new_class: String,
) -> Result<(), CommandError> {
    let root = validate_project_path(&project_path)?;
    let abs = root.join(&file);
    // Defense in depth: the edited file must stay inside the project.
    let canon_root = root.canonicalize().map_err(CommandError::from)?;
    let canon_file = abs.canonicalize().map_err(CommandError::from)?;
    if !canon_file.starts_with(&canon_root) {
        return Err(CommandError::Validation {
            field: "file".into(),
            reason: "edit target is outside the project".into(),
        });
    }

    let src = std::fs::read_to_string(&abs).map_err(CommandError::from)?;
    let span = find_attr_spans(&src, attrs_for_path(&file))
        .into_iter()
        .find(|s| s.line == line && s.value == old_class)
        .ok_or_else(|| CommandError::Validation {
            field: "old_class".into(),
            reason: "source no longer matches — reselect the element".into(),
        })?;

    let mut updated = String::with_capacity(src.len() + new_class.len());
    updated.push_str(&src[..span.value_start]);
    updated.push_str(&new_class);
    updated.push_str(&src[span.value_end..]);

    std::fs::write(&abs, updated).map_err(CommandError::from)?;
    invalidate_index_cache(&root);
    Ok(())
}

/// Surgically replace one className literal at `file:line` if it still equals
/// `old_class`. Returns true if applied, false if the span no longer matches (drift)
/// or the file is missing/outside the project. Used by the multi-location write-back,
/// which skips stale spots rather than failing the whole batch.
fn try_replace_classname(
    root: &Path,
    canon_root: &Path,
    file: &str,
    line: usize,
    old_class: &str,
    new_class: &str,
) -> bool {
    let abs = root.join(file);
    let Ok(canon_file) = abs.canonicalize() else {
        return false;
    };
    if !canon_file.starts_with(canon_root) {
        return false;
    }
    let Ok(src) = std::fs::read_to_string(&abs) else {
        return false;
    };
    let Some(span) = find_attr_spans(&src, attrs_for_path(file))
        .into_iter()
        .find(|s| s.line == line && s.value == old_class)
    else {
        return false;
    };
    let mut updated = String::with_capacity(src.len() + new_class.len());
    updated.push_str(&src[..span.value_start]);
    updated.push_str(new_class);
    updated.push_str(&src[span.value_end..]);
    std::fs::write(&abs, updated).is_ok()
}

/// Apply the same className edit to several source locations at once (the "edit all
/// occurrences" path for a class string that appears in multiple places). Each spot
/// is verified against `old_class` independently; stale ones are skipped. Returns
/// how many were actually updated.
#[tauri::command]
#[tracing::instrument(skip(edits), fields(project = %project_path, count = edits.len()))]
pub fn apply_classname_edit_multi(
    project_path: String,
    edits: Vec<Location>,
    old_class: String,
    new_class: String,
) -> Result<usize, CommandError> {
    let root = validate_project_path(&project_path)?;
    let canon_root = root.canonicalize().map_err(CommandError::from)?;
    let applied = edits
        .iter()
        .filter(|e| {
            try_replace_classname(&root, &canon_root, &e.file, e.line, &old_class, &new_class)
        })
        .count();
    invalidate_index_cache(&root);
    Ok(applied)
}

// ───────────────────────────── Text content ─────────────────────────────────
//
// Live text editing rides on the same select → resolve → write-back rails as class
// editing. We reuse class resolution as the *anchor*: once an element's className
// pins a single source location, the static text run inside that tag is the thing
// we edit. There's no Multi rung in v1 — repeated elements (a `.map`) usually carry
// per-instance copy, so "edit all" would clobber real text; we offer text editing
// only when the class resolves to one confident location.

/// Resolution of an element's text content to its source literal.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TextResolution {
    /// A single static text run was found and is editable.
    Resolved {
        /// Path relative to the project root, POSIX-style.
        file: String,
        /// 1-based line of the trimmed text run.
        line: usize,
        /// 1-based column of the trimmed text run.
        column: usize,
        /// Current static text (trimmed) — the write-back's drift baseline.
        text: String,
        /// How the underlying element was reached: "unique" | "tag" | "ancestor".
        confidence: String,
    },
    /// The text isn't a plain editable string (dynamic, mixed, or ambiguous element).
    ReadOnly { reason: String },
}

/// A located static text run between an opening tag's `>` and its `</`. The run may
/// contain `<br>` line breaks (kept verbatim in `value`); any other nested element
/// or a `{…}` expression disqualifies it.
#[derive(Debug, Clone)]
struct TextSpan {
    /// Trimmed text — what the user edits (may contain `<br />`).
    value: String,
    /// Byte offset of the first non-whitespace text character.
    value_start: usize,
    /// Byte offset just past the last non-whitespace text character.
    value_end: usize,
    line: usize,
    column: usize,
    /// Lowercased enclosing tag name (for content-search disambiguation).
    tag: String,
}

/// 1-based (line, column) of a byte offset in `src`.
fn line_col(src: &str, byte: usize) -> (usize, usize) {
    let prefix = &src[..byte];
    let line = prefix.bytes().filter(|&b| b == b'\n').count() + 1;
    let column = byte - prefix.rfind('\n').map(|p| p + 1).unwrap_or(0) + 1;
    (line, column)
}

/// Inline elements allowed inside editable text — `<br>` for line breaks plus the
/// formatting tags the rich-text toolbar can apply. Anything else (a `<div>`, an
/// `<img>`, a component) makes the content non-editable (mixed).
const INLINE_TAGS: &[&str] = &[
    "br", "a", "b", "i", "em", "strong", "span", "code", "sub", "sup", "mark", "small", "u",
];

/// A parsed tag starting at some `<`.
struct TagInfo {
    /// Lowercased tag name.
    name: String,
    /// Byte offset just past the tag's `>`.
    end: usize,
    /// `</name>` rather than `<name>`.
    closing: bool,
    /// `<name/>` (or void) — opens and closes in one.
    self_closing: bool,
}

/// Parse the tag beginning at byte `at` (which must be `<`). The closing `>` is
/// found quote-aware, so a `>` inside an attribute value (`<a title="a > b">`)
/// doesn't truncate the tag. None if it isn't a well-formed tag start.
fn tag_at(src: &str, at: usize) -> Option<TagInfo> {
    let bytes = src.as_bytes();
    if bytes.get(at) != Some(&b'<') {
        return None;
    }
    let mut i = at + 1;
    let closing = bytes.get(i) == Some(&b'/');
    if closing {
        i += 1;
    }
    let name_start = i;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-') {
        i += 1;
    }
    if i == name_start {
        return None; // not a tag (e.g. `<` in text — but JSX text rarely has bare `<`)
    }
    let name = src[name_start..i].to_ascii_lowercase();
    // Find the tag's `>`, skipping any inside quoted attribute values.
    let mut k = i;
    let mut quote: u8 = 0;
    let mut gt = None;
    while k < bytes.len() {
        let b = bytes[k];
        if quote != 0 {
            if b == quote {
                quote = 0;
            }
        } else if b == b'"' || b == b'\'' {
            quote = b;
        } else if b == b'>' {
            gt = Some(k);
            break;
        }
        k += 1;
    }
    let gt = gt?;
    let self_closing = gt > 0 && bytes[gt - 1] == b'/';
    Some(TagInfo {
        name,
        end: gt + 1,
        closing,
        self_closing,
    })
}

/// Scan an element's inner content starting at `run_start` (just past the opening
/// tag's `>`). Returns the trimmed inner (text plus any allowed inline markup) and
/// its byte bounds. Tracks inline-tag nesting so a `</strong>` doesn't end the run
/// early — only a closing tag at depth 0 (the element's own) does. Returns None for
/// empty runs, dynamic text (`{…}`), or any disallowed nested element (mixed content).
/// If a JSX expression beginning at `{` (byte `at`) is a pure string literal —
/// `{" "}`, `{'text'}`, `` {`text`} `` with no `${…}` interpolation — return the byte
/// just past its `}`. These render to static text, so they don't disqualify a run.
/// None for any other expression (variable, call, interpolation).
fn string_expr_end(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut i = at + 1;
    while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    let q = *bytes.get(i)?;
    if q != b'"' && q != b'\'' && q != b'`' {
        return None;
    }
    i += 1;
    let mut closed = false;
    while i < bytes.len() {
        let b = bytes[i];
        if q == b'`' && b == b'$' && bytes.get(i + 1) == Some(&b'{') {
            return None; // template interpolation — dynamic
        }
        if b == b'\\' {
            i += 2;
            continue;
        }
        if b == q {
            i += 1;
            closed = true;
            break;
        }
        i += 1;
    }
    if !closed {
        return None;
    }
    while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    (bytes.get(i) == Some(&b'}')).then_some(i + 1)
}

fn scan_inner(src: &str, run_start: usize) -> Option<(String, usize, usize)> {
    let bytes = src.as_bytes();
    let mut j = run_start;
    let mut depth: i32 = 0;
    // Top-level (depth-0) element count and whether there's any direct text — a run
    // with several element children and no direct text is a layout container (e.g. a
    // flex row of buttons), not a text block, so it's not editable as one run.
    let mut top_elems = 0usize;
    let mut top_text = false;
    loop {
        if j >= bytes.len() {
            return None; // unterminated
        }
        match bytes[j] {
            b'{' => match string_expr_end(src, j) {
                Some(end) => j = end, // a string-literal expression like {" "} — static
                None => return None,  // a real (dynamic) expression
            },
            b'<' => {
                let t = tag_at(src, j)?; // unparseable `<` → bail (treat as non-text)
                if t.closing {
                    if depth == 0 {
                        break; // closes the element we're scanning — end of content
                    }
                    depth -= 1; // closes a nested inline tag
                } else {
                    if !INLINE_TAGS.contains(&t.name.as_str()) {
                        return None; // a block/other element → mixed content
                    }
                    if src[j..t.end].contains('{') {
                        return None; // dynamic attribute (e.g. <a href={url}>) — not static
                    }
                    if depth == 0 && t.name != "br" {
                        top_elems += 1;
                    }
                    if t.name != "br" && !t.self_closing {
                        depth += 1;
                    }
                }
                j = t.end;
            }
            b' ' | b'\t' | b'\n' | b'\r' => j += 1,
            _ => {
                if depth == 0 {
                    top_text = true;
                }
                j += 1;
            }
        }
    }
    if top_elems >= 2 && !top_text {
        return None; // layout container, not a text element
    }
    let run = &src[run_start..j];
    let trimmed = run.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lead = run.len() - run.trim_start().len();
    let value_start = run_start + lead;
    let value_end = value_start + trimmed.len();
    Some((trimmed.to_string(), value_start, value_end))
}

/// Starting just after a className value's closing quote, find the opening tag's
/// real `>` — skipping `>` inside attribute strings and `{…}` expressions (e.g.
/// `style={{}}`, `onClick={() => a > b}`) — then read the static text run after it.
/// None for self-closing tags or non-editable content (see [`scan_inner`]).
fn text_run_in_tag(src: &str, after_quote: usize) -> Option<TextSpan> {
    let bytes = src.as_bytes();
    let mut i = after_quote;
    let mut in_str: u8 = 0; // the quote char while inside an attribute string, else 0
    let mut depth: i32 = 0; // `{…}` expression depth within the opening tag
    let mut gt: Option<usize> = None;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str != 0 {
            if b == in_str {
                in_str = 0;
            }
        } else if b == b'"' || b == b'\'' || b == b'`' {
            in_str = b;
        } else if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth = (depth - 1).max(0);
        } else if depth == 0 {
            if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'>' {
                return None; // self-closing — no children
            }
            if b == b'>' {
                gt = Some(i);
                break;
            }
        }
        i += 1;
    }
    let gt = gt?;
    let (value, value_start, value_end) = scan_inner(src, gt + 1)?;
    let (line, column) = line_col(src, value_start);
    Some(TextSpan {
        value,
        value_start,
        value_end,
        line,
        column,
        tag: String::new(),
    })
}

/// Every static text run in a file (text between `>` and `</`, `<br>` allowed). Powers
/// both the content-search index and the write-back's re-locate by (line, value). A
/// stray `>` inside an expression can yield a spurious entry, but callers match on
/// exact (line, value) and re-verify, so a false span never drives a wrong edit.
fn find_text_spans(src: &str) -> Vec<TextSpan> {
    let bytes = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'>' {
            i += 1;
            continue;
        }
        if let Some((value, value_start, value_end)) = scan_inner(src, i + 1) {
            let (line, column) = line_col(src, value_start);
            let tag = nearest_tag(&src[..i]);
            out.push(TextSpan {
                value,
                value_start,
                value_end,
                line,
                column,
                tag,
            });
            i = value_end;
        } else {
            i += 1;
        }
    }
    out
}

/// One static text run found in source, with a normalized key for content matching.
#[derive(Debug, Clone)]
struct TextOccurrence {
    /// Raw source text (may contain `<br />`) — the write-back's drift baseline.
    value: String,
    /// Match key: `<br>`→space, whitespace-collapsed, lowercased. Lets a DOM element's
    /// rendered text (innerText: `<br>`→newline, CSS text-transform applied) match the
    /// source literal regardless of casing or wrapping.
    norm: String,
    /// Project-relative POSIX path.
    file: String,
    line: usize,
    column: usize,
    /// Lowercased enclosing tag name.
    tag: String,
}

/// Replace every tag in `s` (`<br>`, `<strong>`, `</a>`, …) with a single space,
/// leaving text content intact. Used to derive a plain-text match key.
fn strip_tags(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let (mut i, mut seg) = (0usize, 0usize);
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if let Some(t) = tag_at(s, i) {
                out.push_str(&s[seg..i]);
                out.push(' ');
                i = t.end;
                seg = t.end;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&s[seg..]);
    out
}

/// Normalize text for content matching: strip tags→space, collapse all whitespace,
/// trim, lowercase. Applied to both the element's innerText and each source literal so
/// inline formatting, line breaks, and CSS text-transform don't defeat the match.
/// Replace pure string-literal JSX expressions (`{" "}`, `{'x'}`) with their inner
/// text, so source matches the rendered DOM. Other `{…}` are left as-is. Copies
/// slices (UTF-8 safe); `{` only ever appears as a standalone ASCII byte.
fn replace_string_exprs(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let (mut i, mut seg) = (0usize, 0usize);
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = string_expr_end(s, i) {
                out.push_str(&s[seg..i]);
                let inner = &s[i..end];
                if let (Some(a), Some(b)) =
                    (inner.find(['"', '\'', '`']), inner.rfind(['"', '\'', '`']))
                {
                    if b > a {
                        out.push_str(&inner[a + 1..b]);
                    }
                }
                i = end;
                seg = end;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&s[seg..]);
    out
}

/// Decode the handful of HTML entities common in prose so encoded source matches the
/// rendered DOM (innerText gives the real character). Covers named essentials plus
/// numeric (`&#8212;`). Copies slices (UTF-8 safe).
fn decode_entities(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let (mut i, mut seg) = (0usize, 0usize);
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some(semi) = s[i..].find(';').map(|p| i + p) {
                if semi - i <= 10 {
                    let ch = match &s[i + 1..semi] {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" | "#39" => Some('\''),
                        "nbsp" | "#160" => Some(' '),
                        "mdash" | "#8212" => Some('—'),
                        "ndash" | "#8211" => Some('–'),
                        "hellip" | "#8230" => Some('…'),
                        "rsquo" | "#8217" => Some('’'),
                        "lsquo" | "#8216" => Some('‘'),
                        "rdquo" | "#8221" => Some('”'),
                        "ldquo" | "#8220" => Some('“'),
                        "copy" => Some('©'),
                        "reg" => Some('®'),
                        "trade" => Some('™'),
                        "deg" => Some('°'),
                        ent => ent
                            .strip_prefix('#')
                            .and_then(|n| n.parse::<u32>().ok())
                            .and_then(char::from_u32),
                    };
                    if let Some(c) = ch {
                        out.push_str(&s[seg..i]);
                        out.push(c);
                        i = semi + 1;
                        seg = i;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    out.push_str(&s[seg..]);
    out
}

/// Normalize text for content matching: decode string-expressions + HTML entities,
/// strip tags→space, `<br>`→space, collapse whitespace, trim, lowercase — so an
/// element's rendered innerText matches the encoded source literal.
fn normalize_text(s: &str) -> String {
    let decoded = decode_entities(&strip_tags(&replace_string_exprs(s)));
    decoded
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Short-lived cache of the per-project text index (parallels the className index).
static TEXT_INDEX_CACHE: std::sync::LazyLock<
    std::sync::Mutex<
        std::collections::HashMap<
            std::path::PathBuf,
            (std::time::Instant, std::sync::Arc<Vec<TextOccurrence>>),
        >,
    >,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Index every static text run under `root`, from cache when fresh.
fn index_text_cached(root: &Path) -> std::sync::Arc<Vec<TextOccurrence>> {
    let key = root.to_path_buf();
    if let Ok(cache) = TEXT_INDEX_CACHE.lock() {
        if let Some((at, idx)) = cache.get(&key) {
            if at.elapsed() < INDEX_TTL {
                return idx.clone();
            }
        }
    }
    let idx = std::sync::Arc::new(index_text_occurrences(root));
    if let Ok(mut cache) = TEXT_INDEX_CACHE.lock() {
        cache.insert(key, (std::time::Instant::now(), idx.clone()));
    }
    idx
}

/// Index every static text run under `root` (same file walk/filters as the className index).
fn index_text_occurrences(root: &Path) -> Vec<TextOccurrence> {
    let mut out = Vec::new();
    let exts = source_exts(root);
    let walker = ignore::WalkBuilder::new(root)
        .standard_filters(true)
        .build();
    for entry in walker.flatten() {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !exts.contains(&ext.as_str()) {
            continue;
        }
        let Ok(src) = std::fs::read_to_string(path) else {
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        for span in find_text_spans(&src) {
            let norm = normalize_text(&span.value);
            if norm.is_empty() {
                continue;
            }
            out.push(TextOccurrence {
                value: span.value,
                norm,
                file: rel.clone(),
                line: span.line,
                column: span.column,
                tag: span.tag,
            });
        }
    }
    out
}

/// Distinct (file, line) locations among text candidates.
fn distinct_text_locs(cands: &[&TextOccurrence]) -> usize {
    let mut set = std::collections::HashSet::new();
    for c in cands {
        set.insert((c.file.as_str(), c.line));
    }
    set.len()
}

fn resolved_text(o: &TextOccurrence, confidence: &str) -> TextResolution {
    TextResolution::Resolved {
        file: o.file.clone(),
        line: o.line,
        column: o.column,
        text: o.value.clone(),
        confidence: confidence.to_string(),
    }
}

/// Resolve an element's text by searching source for its (normalized) content. Used
/// for elements without a unique class anchor — classless tags, or a repeated class
/// whose text is unique. Disambiguates repeats by tag, then a unique ancestor's file.
fn resolve_text_by_content(
    class_occ: &[Occurrence],
    text_occ: &[TextOccurrence],
    sig: &ElementSignature,
) -> TextResolution {
    let Some(want) = sig
        .text
        .as_deref()
        .map(normalize_text)
        .filter(|w| !w.is_empty())
    else {
        return TextResolution::ReadOnly {
            reason: "No text to edit.".into(),
        };
    };
    let matches: Vec<&TextOccurrence> = text_occ.iter().filter(|o| o.norm == want).collect();
    if matches.is_empty() {
        return TextResolution::ReadOnly {
            reason: "This text comes from data or code, so it can't be edited inline.".into(),
        };
    }
    if distinct_text_locs(&matches) == 1 {
        return resolved_text(matches[0], "text");
    }

    // Narrow by tag (soft — only if it leaves candidates).
    let tag_filtered: Vec<&TextOccurrence> = matches
        .iter()
        .copied()
        .filter(|o| o.tag == sig.tag_name)
        .collect();
    let pool = if tag_filtered.is_empty() {
        matches.clone()
    } else {
        tag_filtered
    };
    if distinct_text_locs(&pool) == 1 {
        return resolved_text(pool[0], "tag");
    }

    // Anchor to the file of a unique-in-source ancestor class.
    for anc in &sig.ancestor_classes {
        let anc_occ: Vec<&Occurrence> = class_occ.iter().filter(|o| &o.class_name == anc).collect();
        if anc_occ.len() == 1 {
            let file = &anc_occ[0].file;
            let in_file: Vec<&TextOccurrence> =
                pool.iter().copied().filter(|o| &o.file == file).collect();
            if distinct_text_locs(&in_file) == 1 {
                return resolved_text(in_file[0], "ancestor");
            }
            break;
        }
    }

    TextResolution::ReadOnly {
        reason: "This text appears in several places — select a more specific element.".into(),
    }
}

/// Resolve a clicked element to its editable text source. Strategy 1: anchor on a
/// unique class and read the text inside that tag (most reliable). Strategy 2: when
/// there's no unique class (classless element, repeated class, or non-literal text),
/// search source for the element's text content.
#[tauri::command]
#[tracing::instrument(skip(signature), fields(project = %project_path, tag = %signature.tag_name))]
pub fn resolve_text_source(
    project_path: String,
    signature: ElementSignature,
) -> Result<TextResolution, CommandError> {
    let root = validate_project_path(&project_path)?;
    let occurrences = index_occurrences_cached(&root);

    // Strategy 1: class-anchored.
    if let Resolution::Resolved {
        file,
        line,
        class_name,
        confidence,
        ..
    } = resolve(occurrences.as_slice(), &signature)
    {
        if let Ok(src) = std::fs::read_to_string(root.join(&file)) {
            if let Some(span) = find_attr_spans(&src, attrs_for_path(&file))
                .into_iter()
                .find(|s| s.line == line && s.value == class_name)
            {
                if let Some(ts) = text_run_in_tag(&src, span.value_end + 1) {
                    return Ok(TextResolution::Resolved {
                        file,
                        line: ts.line,
                        column: ts.column,
                        text: ts.value,
                        confidence,
                    });
                }
            }
        }
    }

    // Strategy 2: content search.
    let text_idx = index_text_cached(&root);
    Ok(resolve_text_by_content(
        occurrences.as_slice(),
        text_idx.as_slice(),
        &signature,
    ))
}

/// True if `s` contains markup that would break JSX/Astro text: a `{` expression, or
/// any tag that isn't an allowed inline element (`<br>`, `<strong>`, `<a>`, …).
fn has_illegal_markup(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => return true,
            b'<' => match tag_at(s, i) {
                Some(t) if INLINE_TAGS.contains(&t.name.as_str()) => i = t.end,
                _ => return true,
            },
            _ => i += 1,
        }
    }
    false
}

/// The in-iframe serializer emits inline markup with the DOM attribute `class`, but
/// JSX/TSX source needs `className`. Convert so re-inserted inline elements (a bolded
/// span, a styled link) keep their classes. Astro templates use `class` — left as-is.
fn jsxify_class_attr(text: &str, file: &str) -> String {
    let ext = file.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if ext == "tsx" || ext == "jsx" {
        text.replace(" class=\"", " className=\"")
    } else {
        text.to_string()
    }
}

/// Surgically replace one static text run's value, after verifying the current text
/// still equals `old_text` (drift guard). The `column` pins the exact run when an
/// identical text appears more than once on the same line. Only the trimmed run is
/// touched — surrounding whitespace and the rest of the file are preserved byte-for-
/// byte. Allows plain text, `<br>` line breaks, and inline formatting; rejects other markup.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, file = %file, line = line))]
pub fn apply_text_edit(
    project_path: String,
    file: String,
    line: usize,
    column: usize,
    old_text: String,
    new_text: String,
) -> Result<(), CommandError> {
    if has_illegal_markup(&new_text) {
        return Err(CommandError::Validation {
            field: "new_text".into(),
            reason: "Text can only contain plain text, line breaks, and basic formatting (bold, italic, links)."
                .into(),
        });
    }
    // DOM serialization uses `class`; JSX needs `className`.
    let new_text = jsxify_class_attr(&new_text, &file);
    let root = validate_project_path(&project_path)?;
    let abs = root.join(&file);
    // Defense in depth: the edited file must stay inside the project.
    let canon_root = root.canonicalize().map_err(CommandError::from)?;
    let canon_file = abs.canonicalize().map_err(CommandError::from)?;
    if !canon_file.starts_with(&canon_root) {
        return Err(CommandError::Validation {
            field: "file".into(),
            reason: "edit target is outside the project".into(),
        });
    }

    let src = std::fs::read_to_string(&abs).map_err(CommandError::from)?;
    let span = find_text_spans(&src)
        .into_iter()
        .find(|s| s.line == line && s.column == column && s.value == old_text)
        .ok_or_else(|| CommandError::Validation {
            field: "old_text".into(),
            reason: "source no longer matches — reselect the element".into(),
        })?;

    let mut updated = String::with_capacity(src.len() + new_text.len());
    updated.push_str(&src[..span.value_start]);
    updated.push_str(&new_text);
    updated.push_str(&src[span.value_end..]);

    std::fs::write(&abs, updated).map_err(CommandError::from)?;
    invalidate_index_cache(&root);
    Ok(())
}

// ───────────────────────────── Image source ─────────────────────────────────
//
// "Replace image" rides the same rails as class/text editing: resolve the clicked
// <img> to the static `src="…"` literal in source, then surgically rewrite that
// literal. Strategy 1 anchors on the element's className (the same resolver style
// edits use) and reads the `src` attribute inside that opening tag — this also
// covers framework image components (`<Image className=… src="/x.png">`) whose
// rendered URL differs from the authored one. Strategy 2 — for classless images —
// searches the project for the rendered `src` attribute value. Only static string
// literals are editable; `src={…}` (imports, expressions) is read-only, mirroring
// the className rules. No Multi rung: the same image rendered from several source
// spots (nav + footer logo) can't be told apart, so we report it rather than guess.

/// Resolution of an `<img>`'s `src` attribute to its source literal.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ImageResolution {
    /// A single static `src="…"` literal was found and is editable.
    Resolved {
        /// Path relative to the project root, POSIX-style.
        file: String,
        /// 1-based line of the src literal's value.
        line: usize,
        /// 1-based column of the src literal's value.
        column: usize,
        /// Current static src value — the write-back's drift baseline.
        src: String,
        /// How the match was reached: class confidence, or "src" | "tag" | "ancestor".
        confidence: String,
    },
    /// The src isn't a static string literal (import, expression) or is ambiguous.
    ReadOnly { reason: String },
}

/// Outcome of looking for a `src` attribute inside one opening tag.
enum SrcInTag {
    /// A static literal, with the absolute byte offset of its value.
    Static { value: String, value_start: usize },
    /// A `src={…}` expression — present but not editable.
    Dynamic,
    /// No `src` attribute on this tag at all.
    Missing,
}

/// The byte offset of the `>` ending the opening tag, scanning from `from` (a byte
/// inside the tag, e.g. just past an attribute value's closing quote). Quote- and
/// `{…}`-aware so a `>` inside an attribute string or an arrow function
/// (`onLoad={() => a > b}`) can't end the tag early. Unlike [`text_run_in_tag`]'s
/// scan, self-closing tags are fine — that's the common `<img />`.
fn open_tag_end(src: &str, from: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut i = from;
    let mut in_str: u8 = 0;
    let mut depth: i32 = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str != 0 {
            if b == in_str {
                in_str = 0;
            }
        } else if b == b'"' || b == b'\'' || b == b'`' {
            in_str = b;
        } else if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth = (depth - 1).max(0);
        } else if depth == 0 && b == b'>' {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Whether an opening-tag slice contains a standalone `name=` attribute (any value
/// form) — used to tell a dynamic `src={…}` apart from no `src` at all.
fn has_attr_name(tag: &str, name: &str) -> bool {
    let bytes = tag.as_bytes();
    let mut from = 0;
    while let Some(rel) = tag[from..].find(name) {
        let i = from + rel;
        from = i + name.len();
        if i > 0 && is_ident_byte(bytes[i - 1]) {
            continue;
        }
        let mut j = i + name.len();
        while j < bytes.len() && (bytes[j] as char).is_whitespace() {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'=' {
            return true;
        }
    }
    false
}

/// Look for the `src` attribute inside the opening tag that contains the className
/// literal at `class_value_start..class_value_end`. The tag is bounded by the
/// nearest `<` before the class value and the expression-aware `>` after it; a
/// mis-bound (e.g. a `<` inside an exotic arbitrary class value) at worst yields
/// `Missing` — the drift-guarded write-back means a wrong edit can never happen.
fn src_attr_in_tag(src: &str, class_value_start: usize, class_value_end: usize) -> SrcInTag {
    let Some(start) = src[..class_value_start].rfind('<') else {
        return SrcInTag::Missing;
    };
    let Some(gt) = open_tag_end(src, class_value_end + 1) else {
        return SrcInTag::Missing;
    };
    let tag = &src[start..gt];
    if let Some(span) = find_attr_spans(tag, &["src"]).into_iter().next() {
        return SrcInTag::Static {
            value: span.value,
            value_start: start + span.value_start,
        };
    }
    if has_attr_name(tag, "src") {
        SrcInTag::Dynamic
    } else {
        SrcInTag::Missing
    }
}

/// One static `src="…"` literal found in source.
#[derive(Debug, Clone)]
struct SrcOccurrence {
    value: String,
    /// Project-relative POSIX path.
    file: String,
    line: usize,
    column: usize,
    /// Lowercased nearest opening-tag identifier (soft signal, like class matching).
    tag: String,
}

/// Index every static `src="…"` literal under `root` (same walk/filters as the
/// className index). Built fresh per resolve — image selections are infrequent
/// enough that a cache isn't worth the invalidation surface.
fn index_src_occurrences(root: &Path) -> Vec<SrcOccurrence> {
    let mut out = Vec::new();
    let exts = source_exts(root);
    let walker = ignore::WalkBuilder::new(root)
        .standard_filters(true)
        .build();
    for entry in walker.flatten() {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !exts.contains(&ext.as_str()) {
            continue;
        }
        let Ok(src) = std::fs::read_to_string(path) else {
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        for span in find_attr_spans(&src, &["src"]) {
            out.push(SrcOccurrence {
                value: span.value,
                file: rel.clone(),
                line: span.line,
                column: span.column,
                tag: span.tag,
            });
        }
    }
    out
}

/// Minimal percent-decoder (UTF-8, `+`→space). None on malformed escapes.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = s.get(i + 1..i + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// If `src` is a Next.js image-optimizer URL (`/_next/image?url=…`), recover the
/// authored source path from the `url` param so it matches the source literal.
fn next_image_url(src: &str) -> Option<String> {
    let query = src.strip_prefix("/_next/image?")?;
    for pair in query.split('&') {
        if let Some(v) = pair.strip_prefix("url=") {
            return percent_decode(v);
        }
    }
    None
}

/// Resolve an image by searching source for its rendered `src` value. Used when
/// there's no class anchor (classless `<img>`, or a repeated class). Disambiguates
/// repeats by tag, then by a unique ancestor's file — same ladder as class/text.
fn resolve_src_by_value(
    class_occ: &[Occurrence],
    src_occ: &[SrcOccurrence],
    sig: &ElementSignature,
) -> ImageResolution {
    const DYNAMIC_REASON: &str =
        "This image's source comes from code or data, so it can't be swapped here.";
    let Some(raw) = sig.attr_src.as_deref().filter(|s| !s.trim().is_empty()) else {
        return ImageResolution::ReadOnly {
            reason: DYNAMIC_REASON.into(),
        };
    };
    let want = next_image_url(raw).unwrap_or_else(|| raw.to_string());
    let matches: Vec<&SrcOccurrence> = src_occ.iter().filter(|o| o.value == want).collect();
    if matches.is_empty() {
        return ImageResolution::ReadOnly {
            reason: DYNAMIC_REASON.into(),
        };
    }

    let distinct = |cands: &[&SrcOccurrence]| {
        let mut set = std::collections::HashSet::new();
        for c in cands {
            set.insert((c.file.as_str(), c.line, c.column));
        }
        set.len()
    };
    let resolved = |o: &SrcOccurrence, confidence: &str| ImageResolution::Resolved {
        file: o.file.clone(),
        line: o.line,
        column: o.column,
        src: o.value.clone(),
        confidence: confidence.to_string(),
    };

    if distinct(&matches) == 1 {
        return resolved(matches[0], "src");
    }

    // Narrow by tag (soft — only if it leaves candidates).
    let tag_filtered: Vec<&SrcOccurrence> = matches
        .iter()
        .copied()
        .filter(|o| o.tag == sig.tag_name)
        .collect();
    let pool = if tag_filtered.is_empty() {
        matches.clone()
    } else {
        tag_filtered
    };
    if distinct(&pool) == 1 {
        return resolved(pool[0], "tag");
    }

    // Anchor to the file of a unique-in-source ancestor class.
    for anc in &sig.ancestor_classes {
        let anc_occ: Vec<&Occurrence> = class_occ.iter().filter(|o| &o.class_name == anc).collect();
        if anc_occ.len() == 1 {
            let file = &anc_occ[0].file;
            let in_file: Vec<&SrcOccurrence> =
                pool.iter().copied().filter(|o| &o.file == file).collect();
            if distinct(&in_file) == 1 {
                return resolved(in_file[0], "ancestor");
            }
            break;
        }
    }

    ImageResolution::ReadOnly {
        reason: "This image is used in several places in your code, so the editor can't tell which one you mean — change it in the Code tab instead.".into(),
    }
}

/// Resolve a clicked image to its editable `src` source literal. Strategy 1: anchor
/// on the element's className (most reliable; also covers framework image components
/// whose rendered URL differs from the authored one). Strategy 2: search source for
/// the rendered `src` attribute value.
#[tauri::command]
#[tracing::instrument(skip(signature), fields(project = %project_path, tag = %signature.tag_name))]
pub fn resolve_image_source(
    project_path: String,
    signature: ElementSignature,
) -> Result<ImageResolution, CommandError> {
    let root = validate_project_path(&project_path)?;
    let occurrences = index_occurrences_cached(&root);

    // Strategy 1: class-anchored.
    if !signature.class_name.trim().is_empty() {
        if let Resolution::Resolved {
            file,
            line,
            class_name,
            confidence,
            ..
        } = resolve(occurrences.as_slice(), &signature)
        {
            if let Ok(src) = std::fs::read_to_string(root.join(&file)) {
                if let Some(span) = find_attr_spans(&src, attrs_for_path(&file))
                    .into_iter()
                    .find(|s| s.line == line && s.value == class_name)
                {
                    match src_attr_in_tag(&src, span.value_start, span.value_end) {
                        SrcInTag::Static { value, value_start } => {
                            let (line, column) = line_col(&src, value_start);
                            return Ok(ImageResolution::Resolved {
                                file,
                                line,
                                column,
                                src: value,
                                confidence,
                            });
                        }
                        SrcInTag::Dynamic => {
                            return Ok(ImageResolution::ReadOnly {
                                reason: "This image's source is set in code (an import or expression), so it can't be swapped here.".into(),
                            });
                        }
                        SrcInTag::Missing => {} // fall through to the value search
                    }
                }
            }
        }
    }

    // Strategy 2: value search.
    let src_occ = index_src_occurrences(&root);
    Ok(resolve_src_by_value(
        occurrences.as_slice(),
        &src_occ,
        &signature,
    ))
}

/// Characters that can't appear in a quoted attribute value without breaking the
/// markup: quotes/backticks would terminate the literal, `<`/`>` would inject
/// markup, `{`/`}` would read as a JSX expression. Control chars have no business
/// in a URL; spaces are fine (browsers encode them).
fn invalid_src_value(s: &str) -> bool {
    s.is_empty()
        || s.chars()
            .any(|c| matches!(c, '"' | '\'' | '`' | '<' | '>' | '{' | '}' | '\\') || c.is_control())
}

/// Surgically replace one static `src` literal's value, after verifying it still
/// equals `old_src` (drift guard). The `column` pins the exact attribute when
/// identical values share a line. Only the literal's value is touched — the rest of
/// the file is preserved byte-for-byte.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, file = %file, line = line))]
pub fn apply_src_edit(
    project_path: String,
    file: String,
    line: usize,
    column: usize,
    old_src: String,
    new_src: String,
) -> Result<(), CommandError> {
    if invalid_src_value(&new_src) {
        return Err(CommandError::Validation {
            field: "new_src".into(),
            reason: "Image paths can't be empty or contain quotes, braces, or angle brackets."
                .into(),
        });
    }
    let root = validate_project_path(&project_path)?;
    let abs = root.join(&file);
    // Defense in depth: the edited file must stay inside the project.
    let canon_root = root.canonicalize().map_err(CommandError::from)?;
    let canon_file = abs.canonicalize().map_err(CommandError::from)?;
    if !canon_file.starts_with(&canon_root) {
        return Err(CommandError::Validation {
            field: "file".into(),
            reason: "edit target is outside the project".into(),
        });
    }

    let src = std::fs::read_to_string(&abs).map_err(CommandError::from)?;
    let span = find_attr_spans(&src, &["src"])
        .into_iter()
        .find(|s| s.line == line && s.column == column && s.value == old_src)
        .ok_or_else(|| CommandError::Validation {
            field: "old_src".into(),
            reason: "source no longer matches — reselect the image".into(),
        })?;

    let mut updated = String::with_capacity(src.len() + new_src.len());
    updated.push_str(&src[..span.value_start]);
    updated.push_str(&new_src);
    updated.push_str(&src[span.value_end..]);

    std::fs::write(&abs, updated).map_err(CommandError::from)?;
    invalidate_index_cache(&root);
    Ok(())
}

// ───────────────────────────── Breakpoints ──────────────────────────────────

/// A responsive breakpoint the editor can target (serialized to the frontend as
/// `{name, prefix, minPx}`). The frontend prepends the base (unprefixed) layer.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Breakpoint {
    /// Display name == the Tailwind variant key (e.g. "md", "2xl", or a custom name).
    pub name: String,
    /// Variant prefix without the colon — same as `name` for responsive breakpoints.
    pub prefix: String,
    /// Min-width the breakpoint activates at, in px.
    pub min_px: u32,
}

/// Tailwind's default breakpoints (px), the base set before project overrides.
const DEFAULT_BREAKPOINTS: &[(&str, u32)] = &[
    ("sm", 640),
    ("md", 768),
    ("lg", 1024),
    ("xl", 1280),
    ("2xl", 1536),
];

/// Parse a CSS length to px. Supports rem/em (×16), px, and unitless (treated as
/// px). Returns None for anything we can't resolve to a fixed px (var(), calc(), %).
fn parse_len_px(raw: &str) -> Option<u32> {
    let s = raw.trim();
    let (num, mult) = if let Some(n) = s.strip_suffix("rem") {
        (n, 16.0)
    } else if let Some(n) = s.strip_suffix("em") {
        (n, 16.0)
    } else if let Some(n) = s.strip_suffix("px") {
        (n, 1.0)
    } else {
        (s, 1.0)
    };
    let v: f64 = num.trim().parse().ok()?;
    if !v.is_finite() || v < 0.0 {
        return None;
    }
    Some((v * mult).round() as u32)
}

/// Apply Tailwind v4 `--breakpoint-*` declarations from `css` onto `map`. Handles
/// `--breakpoint-*: initial` (clear all defaults) and `--breakpoint-<name>: initial`
/// (remove one). Returns true if any `--breakpoint-` declaration was seen, so the
/// caller knows this is a v4 project and can skip v3 config parsing.
fn apply_css_breakpoints(css: &str, map: &mut std::collections::BTreeMap<String, u32>) -> bool {
    let mut seen = false;
    for line in css.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("--breakpoint-") else {
            continue;
        };
        let Some((name, value)) = rest.split_once(':') else {
            continue;
        };
        let name = name.trim();
        // Value is everything up to the terminating `;` or an inline `/* … */`.
        let value = value.split(';').next().unwrap_or("");
        let value = value.split("/*").next().unwrap_or("").trim();
        seen = true;
        if value == "initial" {
            if name == "*" {
                map.clear();
            } else {
                map.remove(name);
            }
            continue;
        }
        if name == "*" {
            continue; // `--breakpoint-*: <len>` isn't meaningful
        }
        if let Some(px) = parse_len_px(value) {
            map.insert(name.to_string(), px);
        }
    }
    seen
}

/// Best-effort: merge a v3 `screens: { name: 'value', … }` string-literal map from
/// a config file onto `map`. Bails on anything that isn't a simple literal block
/// (spreads, function values, `min`/`max` objects) — those keep the defaults.
fn apply_v3_screens(config: &str, map: &mut std::collections::BTreeMap<String, u32>) {
    let Some(idx) = config.find("screens") else {
        return;
    };
    let after = &config[idx + "screens".len()..];
    let Some(brace) = after.find('{') else {
        return;
    };
    // Between `screens` and `{` only ws/`:` may appear (else it's not `screens: {`).
    if after[..brace]
        .chars()
        .any(|c| !c.is_whitespace() && c != ':')
    {
        return;
    }
    let body = &after[brace + 1..];
    let Some(end) = body.find('}') else {
        return;
    };
    for part in body[..end].split(',') {
        let Some((k, v)) = part.split_once(':') else {
            continue;
        };
        let trim_q = |s: &str| {
            s.trim()
                .trim_matches(|c| c == '\'' || c == '"' || c == '`')
                .trim()
                .to_string()
        };
        let key = trim_q(k);
        let val = trim_q(v);
        if key.is_empty() {
            continue;
        }
        if let Some(px) = parse_len_px(&val) {
            map.insert(key, px);
        }
    }
}

/// Detect the project's Tailwind breakpoints. Tailwind v4 `@theme { --breakpoint-* }`
/// is the primary source (scanned from the project's CSS); v3 `theme.screens` is a
/// best-effort fallback; a missing/unparseable config yields Tailwind's defaults.
/// Returns only the real responsive breakpoints — the frontend prepends the base layer.
/// Whether Tailwind is actually wired into the project's build — so the utility
/// classes the visual editor writes will compile. A bare `@import "tailwindcss"`
/// in a CSS file does NOTHING without the Vite/PostCSS plugin (or a v3 config), so
/// we require a real integration. Used to gate the editor: no Tailwind → no editor.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn is_tailwind_active(project_path: String) -> Result<bool, CommandError> {
    let root = validate_project_path(&project_path)?;
    Ok(tailwind_active_at(&root))
}

/// Core of [`is_tailwind_active`], split out (no path validation) for unit testing.
fn tailwind_active_at(root: &Path) -> bool {
    // A v3-style config file present is a definitive signal.
    for name in [
        "tailwind.config.js",
        "tailwind.config.ts",
        "tailwind.config.cjs",
        "tailwind.config.mjs",
    ] {
        if root.join(name).exists() {
            return true;
        }
    }

    // Otherwise a build config must wire Tailwind in (the Vite/PostCSS plugin or the
    // Astro integration). We look for any mention of "tailwind" in the build configs.
    for name in [
        "astro.config.mjs",
        "astro.config.ts",
        "astro.config.js",
        "vite.config.ts",
        "vite.config.js",
        "vite.config.mjs",
        "next.config.js",
        "next.config.mjs",
        "next.config.ts",
        "postcss.config.js",
        "postcss.config.cjs",
        "postcss.config.mjs",
        "postcss.config.json",
        ".postcssrc.json",
        ".postcssrc.js",
        ".postcssrc",
    ] {
        if let Ok(contents) = std::fs::read_to_string(root.join(name)) {
            if contents.contains("tailwind") {
                return true;
            }
        }
    }

    false
}

/// Whether the project depends on React. The visual editor resolves a clicked
/// element back to a `className` literal in `.tsx`/`.jsx` source, so a Vite
/// project only earns the editor when it's React-flavored: Vue (`.vue`) and
/// Svelte (`.svelte`) keep their class strings in files the resolver never
/// indexes, so enabling them would surface an edit button that can't write back.
/// Meta-frameworks (Next.js) are gated by project type instead and don't need
/// this. React Native is detected before Vite, so a `ProjectType::Vite` project
/// matching here is genuinely a React web app.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn project_uses_react(project_path: String) -> Result<bool, CommandError> {
    let root = validate_project_path(&project_path)?;
    Ok(project_uses_react_at(&root))
}

/// Core of [`project_uses_react`], split out (no path validation) for unit testing.
fn project_uses_react_at(root: &Path) -> bool {
    let Ok(contents) = std::fs::read_to_string(root.join("package.json")) else {
        return false;
    };
    // Match the `"react":` dependency key specifically. This excludes substrings
    // like `"react-dom":`, `"@types/react":`, and `"@vitejs/plugin-react":` (none
    // contain the exact quote-`react`-quote-colon sequence), so a Vue/Svelte Vite
    // project that merely has a react-adjacent devDep won't be mistaken for React.
    contents.contains("\"react\":")
}

#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn detect_breakpoints(project_path: String) -> Result<Vec<Breakpoint>, CommandError> {
    let root = validate_project_path(&project_path)?;
    let mut map: std::collections::BTreeMap<String, u32> = DEFAULT_BREAKPOINTS
        .iter()
        .map(|(n, px)| (n.to_string(), *px))
        .collect();

    // v4: scan project CSS (the `ignore` walker skips node_modules/.next/.git).
    let mut css_touched = false;
    for entry in ignore::WalkBuilder::new(&root)
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
            css_touched |= apply_css_breakpoints(&css, &mut map);
        }
    }

    // v3: only when there's no v4 signal, best-effort parse the config's screens map.
    if !css_touched {
        for name in &[
            "tailwind.config.js",
            "tailwind.config.ts",
            "tailwind.config.cjs",
            "tailwind.config.mjs",
        ] {
            if let Ok(cfg) = std::fs::read_to_string(root.join(name)) {
                apply_v3_screens(&cfg, &mut map);
                break;
            }
        }
    }

    let mut bps: Vec<Breakpoint> = map
        .into_iter()
        .map(|(name, min_px)| Breakpoint {
            prefix: name.clone(),
            name,
            min_px,
        })
        .collect();
    bps.sort_by_key(|b| b.min_px);
    Ok(bps)
}

// ───────────────────────── Component usage ("where is this used") ────────────

/// How a source file is rendered: a route Page, a Layout (wraps many pages), or a
/// reusable Component.
#[derive(Debug, PartialEq)]
enum FileKind {
    Page,
    Layout,
    Component,
}

impl FileKind {
    fn as_str(&self) -> &'static str {
        match self {
            FileKind::Page => "page",
            FileKind::Layout => "layout",
            FileKind::Component => "component",
        }
    }
}

/// Classify a project-relative path by framework routing conventions
/// (Astro file-based routing, then Next.js App + Pages router).
fn classify_file(rel: &str) -> FileKind {
    let base = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();

    // Astro: file-based routing. An `.astro` under `pages/` is a route; one under
    // `layouts/` wraps the pages that import it; everything else is a component.
    if base.ends_with(".astro") {
        let lower = rel.to_ascii_lowercase();
        if lower.contains("pages/") {
            return FileKind::Page;
        }
        if lower.contains("layouts/") {
            return FileKind::Layout;
        }
        return FileKind::Component;
    }

    // Next.js (App + Pages router).
    if base.starts_with("page.") {
        return FileKind::Page; // App Router route segment
    }
    if base.starts_with("layout.") || base.starts_with("_app.") {
        return FileKind::Layout; // wraps every page under it
    }
    if rel.starts_with("pages/") && !base.starts_with('_') {
        return FileKind::Page; // Pages Router
    }
    FileKind::Component
}

/// The name in a component-declaration line (`function Foo`, `const Foo =`,
/// `class Foo`), if its first letter is uppercase (a React component).
fn decl_name(line: &str) -> Option<String> {
    let mut s = line.trim_start();
    for kw in ["export ", "default ", "async ", "pub "] {
        if let Some(rest) = s.strip_prefix(kw) {
            s = rest.trim_start();
        }
    }
    let rest = ["function ", "const ", "let ", "var ", "class "]
        .iter()
        .find_map(|kw| s.strip_prefix(kw))?;
    let name: String = rest
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
        .collect();
    if name.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
        Some(name)
    } else {
        None
    }
}

/// An `.astro` file *is* a component — there's no `function Foo` to scan for. Its
/// name is the PascalCase basename used at import sites (`Header.astro` → `Header`),
/// so `<Header` usage scanning can find it. Returns None for `index.astro`-style
/// route files only in the sense that the name is still derived; callers gate on
/// `self_kind` (a page isn't rendered as `<Component>` anywhere).
fn astro_component_name(file: &str) -> Option<String> {
    let base = file.rsplit('/').next().unwrap_or(file);
    let stem = base.rsplit_once('.').map(|(s, _)| s).unwrap_or(base);
    (!stem.is_empty()).then(|| stem.to_string())
}

/// The component that encloses `line` (1-based): the nearest component declaration
/// scanning upward. Heuristic, but accurate for top-level components.
fn enclosing_component(src: &str, line: usize) -> Option<String> {
    let lines: Vec<&str> = src.lines().collect();
    let start = line.min(lines.len());
    (0..start).rev().find_map(|i| decl_name(lines[i]))
}

/// Every line where `<Name` is rendered as JSX in `src` (boundary-checked so
/// `<Header` doesn't match `<HeaderBar`).
fn find_jsx_usages(src: &str, name: &str) -> Vec<usize> {
    let bytes = src.as_bytes();
    let needle = format!("<{name}");
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = src[from..].find(&needle) {
        let i = from + rel;
        from = i + needle.len();
        if bytes
            .get(i + needle.len())
            .copied()
            .is_some_and(is_ident_byte)
        {
            continue; // <HeaderBar
        }
        out.push(src[..i].bytes().filter(|&b| b == b'\n').count() + 1);
    }
    out
}

/// One place a component is rendered.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSite {
    file: String,
    line: usize,
    /// "page" | "layout" | "component"
    kind: String,
}

/// Where an edited element's component is used across the project — drives the
/// "this also appears in N places" scope hint.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// The enclosing component name, if we could determine it.
    component: Option<String>,
    /// Kind of the edited file itself (page = only this page; layout = every page).
    self_kind: String,
    /// Every `<Component>` render site found in source.
    sites: Vec<UsageSite>,
}

/// Find where the component containing `file:line` is rendered across the project.
/// Used to warn that editing a shared component changes it everywhere it appears.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, file = %file, line = line))]
pub fn find_component_usage(
    project_path: String,
    file: String,
    line: usize,
) -> Result<UsageReport, CommandError> {
    let root = validate_project_path(&project_path)?;
    let src = std::fs::read_to_string(root.join(&file)).unwrap_or_default();
    // `.astro` files have no JS component declaration to scan for — the component
    // name is the filename (used verbatim at `<Header>` import sites).
    let component = enclosing_component(&src, line).or_else(|| {
        file.to_ascii_lowercase()
            .ends_with(".astro")
            .then(|| astro_component_name(&file))
            .flatten()
    });
    let self_kind = classify_file(&file).as_str().to_string();

    let mut sites = Vec::new();
    if let Some(name) = &component {
        let exts = source_exts(&root);
        for entry in ignore::WalkBuilder::new(&root)
            .standard_filters(true)
            .build()
            .flatten()
        {
            let path = entry.path();
            let is_src = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| exts.contains(&e))
                .unwrap_or(false);
            if !is_src {
                continue;
            }
            let Ok(s) = std::fs::read_to_string(path) else {
                continue;
            };
            let rel = path
                .strip_prefix(&root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            for ln in find_jsx_usages(&s, name) {
                let kind = classify_file(&rel).as_str().to_string();
                sites.push(UsageSite {
                    file: rel.clone(),
                    line: ln,
                    kind,
                });
            }
        }
        sites.sort_by(|a, b| {
            (a.kind.as_str(), a.file.as_str(), a.line).cmp(&(
                b.kind.as_str(),
                b.file.as_str(),
                b.line,
            ))
        });
    }

    Ok(UsageReport {
        component,
        self_kind,
        sites,
    })
}

// ───────────────────────────── Element HTML ─────────────────────────────────
//
// "Edit the HTML by hand": map a selected element to the exact span of source
// markup it came from — its opening `<tag …>` through the matching `</tag>` —
// so the user can edit that markup as text and we write it straight back.
// Anchored on the same className resolution as style/text editing (so we pick
// the right element among duplicates), then expanded to the full element span
// by a quote/comment-aware tag balancer. Reliable for the well-formed HTML the
// visual editor targets; ambiguous (`Multi`) or dynamic elements stay read-only.

/// Void HTML elements — no closing tag, so the span is just the opening tag.
const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// The element's source byte span `[open '<', close '>' + 1)` given a byte
/// offset known to sit inside its opening tag (e.g. the `class` attribute value).
fn element_span(src: &str, inside_open_tag: usize) -> Option<(usize, usize)> {
    let bytes = src.as_bytes();
    let n = bytes.len();
    if inside_open_tag >= n {
        return None;
    }

    // 1. The '<' that opens this tag (scan back).
    let mut i = inside_open_tag;
    while i > 0 && bytes[i] != b'<' {
        i -= 1;
    }
    if bytes[i] != b'<' {
        return None;
    }
    let open_start = i;

    // Tag name.
    let name_start = open_start + 1;
    let mut j = name_start;
    while j < n && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-') {
        j += 1;
    }
    if j == name_start {
        return None;
    }
    let tag = src[name_start..j].to_ascii_lowercase();

    // 2. End of the opening tag ('>'), honoring quoted attribute values.
    let close_open = scan_to_gt(bytes, j)?;
    let open_end = close_open + 1;
    let self_closing = bytes[close_open.saturating_sub(1)] == b'/';
    if self_closing || VOID_ELEMENTS.contains(&tag.as_str()) {
        return Some((open_start, open_end));
    }

    // 3. Walk forward to the matching close tag, balancing same-name nesting and
    //    skipping comments.
    let mut depth = 1i32;
    let mut p = open_end;
    while p < n {
        // Byte comparison, NOT `&src[p..p+4]`: `p` advances byte-by-byte over
        // arbitrary text, so a `&str` slice here panics the moment it lands mid
        // multi-byte UTF-8 char (curly quotes, emoji, accents in element text).
        // `p` is only a char boundary once `bytes[p] == b'<'`, which the slices
        // below all sit behind — this probe runs at every position.
        if p + 4 <= n && &bytes[p..p + 4] == b"<!--" {
            p = src[p..].find("-->").map(|r| p + r + 3)?;
            continue;
        }
        if bytes[p] == b'<' {
            if p + 1 < n && bytes[p + 1] == b'/' {
                // Closing tag.
                let ns = p + 2;
                let mut ne = ns;
                while ne < n && (bytes[ne].is_ascii_alphanumeric() || bytes[ne] == b'-') {
                    ne += 1;
                }
                if src[ns..ne].to_ascii_lowercase() == tag {
                    depth -= 1;
                    if depth == 0 {
                        let gt = scan_to_gt(bytes, ne)?;
                        return Some((open_start, gt + 1));
                    }
                }
                p = ne;
                continue;
            }
            // Opening tag — bump depth only for a same-name, non-void, non-self-closing one.
            let ns = p + 1;
            let mut ne = ns;
            while ne < n && (bytes[ne].is_ascii_alphanumeric() || bytes[ne] == b'-') {
                ne += 1;
            }
            if ne > ns {
                let oname = src[ns..ne].to_ascii_lowercase();
                let gt = scan_to_gt(bytes, ne)?;
                let self_closing = bytes[gt.saturating_sub(1)] == b'/';
                // `<script>`/`<style>` hold raw text where `<` is not a tag (e.g.
                // `if (a < b)`); skip their whole body so it can't be misread as
                // markup or unbalance the depth count.
                if !self_closing && (oname == "script" || oname == "style") {
                    let close = format!("</{oname}");
                    if let Some(rel) = src[gt + 1..].to_ascii_lowercase().find(&close) {
                        p = scan_to_gt(bytes, gt + 1 + rel)? + 1;
                        continue;
                    }
                    return None;
                }
                if oname == tag && !self_closing && !VOID_ELEMENTS.contains(&oname.as_str()) {
                    depth += 1;
                }
                p = gt + 1;
                continue;
            }
        }
        p += 1;
    }
    None
}

/// First `>` at/after `from` that isn't inside a quoted attribute value.
fn scan_to_gt(bytes: &[u8], from: usize) -> Option<usize> {
    let mut k = from;
    let mut quote = 0u8;
    while k < bytes.len() {
        let c = bytes[k];
        if quote != 0 {
            if c == quote {
                quote = 0;
            }
        } else if c == b'"' || c == b'\'' {
            quote = c;
        } else if c == b'>' {
            return Some(k);
        }
        k += 1;
    }
    None
}

/// The element's source markup and where it lives.
#[derive(Debug, Serialize)]
pub struct ElementHtml {
    pub file: String,
    pub line: usize,
    pub html: String,
}

/// Resolve an element to the source markup span, file, and contents, plus the
/// byte span — shared by resolve/apply so both derive the span identically.
fn locate_element(
    project_path: &str,
    signature: ElementSignature,
) -> Result<(String, std::path::PathBuf, String, usize, usize, usize), CommandError> {
    let resolution = resolve_classname_source(project_path.to_string(), signature)?;
    let (file, line, class_name) = match resolution {
        Resolution::Resolved {
            file,
            line,
            class_name,
            ..
        } => (file, line, class_name),
        Resolution::Multi { .. } => {
            return Err(CommandError::Validation {
                field: "element".into(),
                reason: "This element appears in several identical places, so editing its markup here could change the wrong one. Ask your agent to edit it instead.".into(),
            })
        }
        // The class resolver couldn't anchor this element to source (its classes
        // are dynamic/generated, or it has none). The markup editor is
        // class-anchored, so phrase it for *markup*, not the class-string reason.
        Resolution::ReadOnly { .. } => {
            return Err(CommandError::Validation {
                field: "element".into(),
                reason: "This element can't be matched to its source markup (it has no static class to anchor on). Edit it with your agent instead.".into(),
            })
        }
    };
    let root = validate_project_path(project_path)?;
    let abs = root.join(&file);
    let src = std::fs::read_to_string(&abs).map_err(CommandError::from)?;
    let span = find_attr_spans(&src, attrs_for_path(&file))
        .into_iter()
        .find(|s| s.line == line && s.value == class_name)
        .ok_or_else(|| CommandError::Validation {
            field: "element".into(),
            reason: "source no longer matches — reselect the element".into(),
        })?;
    let (start, end) =
        element_span(&src, span.value_start).ok_or_else(|| CommandError::Validation {
            field: "element".into(),
            reason: "couldn't map this element to its source markup".into(),
        })?;
    Ok((file, abs, src, line, start, end))
}

/// Resolve a clicked element to its source HTML (opening tag → closing tag).
#[tauri::command]
#[tracing::instrument(skip(signature), fields(project = %project_path))]
pub fn resolve_element_html(
    project_path: String,
    signature: ElementSignature,
) -> Result<ElementHtml, CommandError> {
    let (file, _abs, src, line, start, end) = locate_element(&project_path, signature)?;
    Ok(ElementHtml {
        file,
        line,
        html: src[start..end].to_string(),
    })
}

/// Replace an element's source markup, after verifying it still equals
/// `old_html` (drift guard — the file may have changed since selection).
#[tauri::command]
#[tracing::instrument(skip(signature, old_html, new_html), fields(project = %project_path))]
pub fn apply_element_html(
    project_path: String,
    signature: ElementSignature,
    old_html: String,
    new_html: String,
) -> Result<(), CommandError> {
    let (_file, abs, src, _line, start, end) = locate_element(&project_path, signature)?;
    if src[start..end] != old_html {
        return Err(CommandError::Validation {
            field: "old_html".into(),
            reason: "source no longer matches — reselect the element".into(),
        });
    }
    let mut updated = String::with_capacity(src.len() + new_html.len());
    updated.push_str(&src[..start]);
    updated.push_str(&new_html);
    updated.push_str(&src[end..]);
    std::fs::write(&abs, updated).map_err(CommandError::from)?;
    let root = validate_project_path(&project_path)?;
    invalidate_index_cache(&root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span_str(src: &str) -> String {
        let inside = src.find("cls").unwrap();
        let (s, e) = element_span(src, inside).unwrap();
        src[s..e].to_string()
    }

    #[test]
    fn element_span_simple() {
        let src = r#"<section class="cls">hi</section>"#;
        assert_eq!(span_str(src), src);
    }

    #[test]
    fn element_span_nested_same_tag() {
        let src = r#"<div class="cls"><div>inner</div>tail</div>"#;
        assert_eq!(span_str(src), src);
    }

    #[test]
    fn element_span_void_img_has_no_close() {
        let src = r#"<img class="cls" src="x.png">after"#;
        assert_eq!(span_str(src), r#"<img class="cls" src="x.png">"#);
    }

    #[test]
    fn element_span_self_closing() {
        let src = r#"<Custom class="cls" />tail"#;
        assert_eq!(span_str(src), r#"<Custom class="cls" />"#);
    }

    #[test]
    fn element_span_skips_comment_and_quoted_gt() {
        let src = r#"<div class="cls" data-x="a>b"><!-- </div> --><span>x</span></div>"#;
        assert_eq!(span_str(src), src);
    }

    #[test]
    fn element_span_handles_multibyte_utf8_text() {
        // Regression: the forward walk advances byte-by-byte, so a `&str` slice
        // in the comment probe used to panic ("byte index is not a char
        // boundary") the moment it stepped into a multi-byte char in element
        // text (curly quotes, emoji, accents). Must walk past it cleanly.
        let src = "<p class=\"cls\">“Café” — déjà vu 🚀 done</p>tail";
        assert_eq!(
            span_str(src),
            "<p class=\"cls\">“Café” — déjà vu 🚀 done</p>"
        );
    }

    #[test]
    fn element_span_skips_script_raw_text() {
        // The `<` in `a < b` and the literal `</div>` string inside the script
        // must not be read as markup — the outer div's real close wins.
        let src = r#"<div class="cls"><script>if (a < b) { x("</div>") }</script>done</div>"#;
        assert_eq!(span_str(src), src);
    }

    fn sig(class: &str, tag: &str, ancestors: &[&str]) -> ElementSignature {
        ElementSignature {
            class_name: class.into(),
            tag_name: tag.into(),
            text: None,
            ancestor_classes: ancestors.iter().map(|s| s.to_string()).collect(),
            attr_src: None,
        }
    }

    #[test]
    fn source_exts_includes_html_only_for_static_projects() {
        // Framework project (Next): `.html` is an export/fixture, not source.
        let next = tempfile::TempDir::new().unwrap();
        std::fs::write(
            next.path().join("package.json"),
            r#"{"dependencies":{"next":"14.0.0"}}"#,
        )
        .unwrap();
        std::fs::write(next.path().join("export.html"), "<div class=\"x\"></div>").unwrap();
        assert!(!source_exts(next.path()).contains(&"html"));

        // Plain static-HTML project: `.html` IS the source.
        let static_site = tempfile::TempDir::new().unwrap();
        std::fs::write(
            static_site.path().join("index.html"),
            "<div class=\"x\"></div>",
        )
        .unwrap();
        assert!(source_exts(static_site.path()).contains(&"html"));
    }

    #[test]
    fn disambiguate_by_text_pins_the_clicked_instance() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("components")).unwrap();
        // Two distinct paragraphs sharing one utility className but different text.
        std::fs::write(
            root.join("components/About.tsx"),
            "export function About() {\n  return (\n    <p className=\"text-muted leading-relaxed\">\n      With over 65 years of proven performance in the market.\n    </p>\n  );\n}\n",
        )
        .unwrap();
        std::fs::write(
            root.join("components/Services.tsx"),
            "export function Services() {\n  return (\n    <p className=\"text-muted leading-relaxed\">\n      Custom cabinets built to last for decades.\n    </p>\n  );\n}\n",
        )
        .unwrap();
        let locations = vec![
            Location {
                file: "components/About.tsx".into(),
                line: 3,
                column: 1,
            },
            Location {
                file: "components/Services.tsx".into(),
                line: 3,
                column: 1,
            },
        ];
        let cls = "text-muted leading-relaxed";

        // The clicked element's text pins exactly one location.
        match disambiguate_by_text(
            root,
            &locations,
            cls,
            "With over 65 years of proven performance in the market.",
        ) {
            Some(Resolution::Resolved {
                file, confidence, ..
            }) => {
                assert_eq!(file, "components/About.tsx");
                assert_eq!(confidence, "text");
            }
            other => panic!("expected Resolved(text), got {other:?}"),
        }
        // Text not present in any candidate → no pin (stays Multi).
        assert!(disambiguate_by_text(root, &locations, cls, "Totally unrelated copy.").is_none());
        // Too-short text → no pin (not distinctive enough).
        assert!(disambiguate_by_text(root, &locations, cls, "Hi").is_none());
    }

    #[test]
    fn finds_static_classnames_skips_dynamic() {
        let src = r#"
            export function C() {
              return (
                <div className="flex p-4">
                  <span className={"text-sm"}>hi</span>
                  <a className={clsx("a", b)}>x</a>
                  <p className={`pad-${n}`}>y</p>
                  <b className={`static-tpl`}>z</b>
                </div>
              );
            }
        "#;
        let spans = find_classname_spans(src);
        let values: Vec<&str> = spans.iter().map(|s| s.value.as_str()).collect();
        assert!(values.contains(&"flex p-4"));
        assert!(values.contains(&"text-sm"));
        assert!(values.contains(&"static-tpl"));
        // clsx(...) and `pad-${n}` are dynamic — not indexed.
        assert!(!values.iter().any(|v| v.contains("a") && v.len() == 1));
        assert!(!values.contains(&"pad-"));
        assert_eq!(values.len(), 3);
    }

    #[test]
    fn does_not_match_identifier_substrings() {
        let src = r#"const myClassName = "x"; setClassName("y");"#;
        assert!(find_classname_spans(src).is_empty());
    }

    #[test]
    fn span_line_and_tag_are_correct() {
        let src = "<section className=\"a b\">\n  <div className=\"c\" />\n</section>";
        let spans = find_classname_spans(src);
        assert_eq!(spans[0].value, "a b");
        assert_eq!(spans[0].line, 1);
        assert_eq!(spans[0].tag, "section");
        assert_eq!(spans[1].value, "c");
        assert_eq!(spans[1].line, 2);
        assert_eq!(spans[1].tag, "div");
    }

    #[test]
    fn astro_scans_both_class_and_classname() {
        // An .astro file: HTML `class` in the template, plus `className` on an
        // embedded React island, plus dynamic forms that must stay read-only.
        let src = r#"---
import Card from '../components/Card.astro';
const items = [];
---
<section class="flex p-4">
  <h1 class="text-2xl font-bold">Hi</h1>
  <ul class:list={["a", "b"]}>
    <li class={items.length ? "on" : "off"}>x</li>
  </ul>
  <ReactWidget className="grid gap-2" />
</section>"#;
        let spans = find_attr_spans(src, attrs_for_ext("astro"));
        let values: Vec<&str> = spans.iter().map(|s| s.value.as_str()).collect();
        assert!(values.contains(&"flex p-4"));
        assert!(values.contains(&"text-2xl font-bold"));
        assert!(values.contains(&"grid gap-2")); // island className
                                                 // class:list and the ternary class={...} are dynamic — not indexed.
        assert!(!values.contains(&"on"));
        assert!(!values.contains(&"off"));
        assert_eq!(values.len(), 3);
    }

    #[test]
    fn class_needle_does_not_double_count_classname() {
        // Scanning both names over `className="..."` must yield exactly one span:
        // the `class` prefix is rejected because the next char is `N`, not `=`.
        let src = r#"<div className="flex" />"#;
        let spans = find_attr_spans(src, attrs_for_ext("astro"));
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].value, "flex");
    }

    #[test]
    fn class_needle_ignores_js_class_declarations() {
        // Astro frontmatter is JS/TS — a `class Foo {}` must not be picked up.
        let src = "---\nclass Foo { bar = 1; }\n---\n<div class=\"p-2\" />";
        let spans = find_attr_spans(src, attrs_for_ext("astro"));
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].value, "p-2");
    }

    #[test]
    fn liquid_scans_class_and_interpolated_values_stay_unresolvable() {
        let src = r#"{% schema %}{ "name": "Hero" }{% endschema %}
<section class="hero hero--{{ section.settings.style }}">
  <h1 class="hero__heading">{{ section.settings.heading }}</h1>
  {% if section.settings.show_cta %}
    <a class="btn btn--primary" href="{{ section.settings.url }}">Go</a>
  {% endif %}
</section>"#;
        let spans = find_attr_spans(src, attrs_for_ext("liquid"));
        let values: Vec<&str> = spans.iter().map(|s| s.value.as_str()).collect();
        assert!(values.contains(&"hero__heading"));
        assert!(values.contains(&"btn btn--primary"));
        // The interpolated class IS indexed as literal source text — but it can
        // never equal a rendered DOM className, so resolution stays read-only.
        let interpolated = "hero hero--{{ section.settings.style }}";
        assert!(values.contains(&interpolated));
        let occs = vec![occ(interpolated, "sections/hero.liquid", 2, "section")];
        assert!(matches!(
            resolve(&occs, &sig("hero hero--bold", "section", &[])),
            Resolution::ReadOnly { .. }
        ));
    }

    #[test]
    fn astro_component_name_from_filename() {
        assert_eq!(
            astro_component_name("src/components/Header.astro").as_deref(),
            Some("Header")
        );
        assert_eq!(
            astro_component_name("Footer.astro").as_deref(),
            Some("Footer")
        );
    }

    fn occ(class: &str, file: &str, line: usize, tag: &str) -> Occurrence {
        Occurrence {
            class_name: class.into(),
            file: file.into(),
            line,
            column: 1,
            tag: tag.into(),
        }
    }

    #[test]
    fn resolves_unique_string() {
        let occs = vec![occ("flex p-4", "a.tsx", 3, "div")];
        match resolve(&occs, &sig("flex p-4", "div", &[])) {
            Resolution::Resolved {
                confidence, file, ..
            } => {
                assert_eq!(confidence, "unique");
                assert_eq!(file, "a.tsx");
            }
            other => panic!("expected Resolved, got {other:?}"),
        }
    }

    #[test]
    fn dynamic_or_missing_is_read_only() {
        let occs = vec![occ("flex", "a.tsx", 1, "div")];
        assert!(matches!(
            resolve(&occs, &sig("bg-red-500 dynamic", "div", &[])),
            Resolution::ReadOnly { .. }
        ));
    }

    #[test]
    fn disambiguates_by_tag() {
        let occs = vec![
            occ("p-2", "a.tsx", 1, "div"),
            occ("p-2", "a.tsx", 2, "span"),
        ];
        match resolve(&occs, &sig("p-2", "span", &[])) {
            Resolution::Resolved {
                line, confidence, ..
            } => {
                assert_eq!(line, 2);
                assert_eq!(confidence, "tag");
            }
            other => panic!("expected Resolved, got {other:?}"),
        }
    }

    #[test]
    fn anchors_to_unique_ancestor_file() {
        // "flex" appears in two files; the unique ancestor pins the right one.
        let occs = vec![
            occ("flex", "Hero.tsx", 5, "div"),
            occ("flex", "Footer.tsx", 9, "div"),
            occ("hero-wrap unique", "Hero.tsx", 2, "section"),
        ];
        match resolve(&occs, &sig("flex", "div", &["hero-wrap unique"])) {
            Resolution::Resolved {
                file,
                line,
                confidence,
                ..
            } => {
                assert_eq!(file, "Hero.tsx");
                assert_eq!(line, 5);
                assert_eq!(confidence, "ancestor");
            }
            other => panic!("expected Resolved, got {other:?}"),
        }
    }

    #[test]
    fn unresolvable_repeats_are_multi_editable() {
        let occs = vec![
            occ("flex", "a.tsx", 1, "div"),
            occ("flex", "b.tsx", 1, "div"),
        ];
        match resolve(&occs, &sig("flex", "div", &["also-not-unique"])) {
            Resolution::Multi {
                locations,
                class_name,
            } => {
                assert_eq!(locations.len(), 2);
                assert_eq!(class_name, "flex");
                // Sorted by (file, line).
                assert_eq!(locations[0].file, "a.tsx");
                assert_eq!(locations[1].file, "b.tsx");
            }
            other => panic!("expected Multi, got {other:?}"),
        }
    }

    #[test]
    fn write_back_replaces_only_the_value() {
        let dir = std::env::temp_dir().join(format!("ss-edit-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("C.tsx");
        std::fs::write(&file, "const x=1;\n<div className=\"p-4 flex\">\n").unwrap();

        let spans = find_classname_spans(&std::fs::read_to_string(&file).unwrap());
        assert_eq!(spans[0].value, "p-4 flex");

        // Simulate the write-back's surgical replacement directly (command layer
        // adds path validation we can't exercise outside the ShipStudio root).
        let src = std::fs::read_to_string(&file).unwrap();
        let span = find_classname_spans(&src)
            .into_iter()
            .find(|s| s.line == 2 && s.value == "p-4 flex")
            .unwrap();
        let mut updated = String::new();
        updated.push_str(&src[..span.value_start]);
        updated.push_str("p-6 flex");
        updated.push_str(&src[span.value_end..]);
        std::fs::write(&file, &updated).unwrap();

        let after = std::fs::read_to_string(&file).unwrap();
        assert_eq!(after, "const x=1;\n<div className=\"p-6 flex\">\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn multi_write_back_updates_matches_skips_drift() {
        let dir = std::env::temp_dir().join(format!("ss-multi-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let canon_root = dir.canonicalize().unwrap();
        let a = dir.join("A.tsx");
        let b = dir.join("B.tsx");
        let c = dir.join("C.tsx");
        std::fs::write(&a, "<div className=\"flex p-4\" />\n").unwrap();
        std::fs::write(&b, "x\n<span className=\"flex p-4\" />\n").unwrap();
        std::fs::write(&c, "<div className=\"other\" />\n").unwrap(); // drift: won't match

        let replaced = |file: &str, line: usize| {
            try_replace_classname(&dir, &canon_root, file, line, "flex p-4", "flex p-8")
        };
        assert!(replaced("A.tsx", 1));
        assert!(replaced("B.tsx", 2));
        assert!(!replaced("C.tsx", 1)); // value differs → skipped
        assert!(!replaced("A.tsx", 99)); // wrong line → skipped

        assert_eq!(
            std::fs::read_to_string(&a).unwrap(),
            "<div className=\"flex p-8\" />\n"
        );
        assert_eq!(
            std::fs::read_to_string(&b).unwrap(),
            "x\n<span className=\"flex p-8\" />\n"
        );
        assert_eq!(
            std::fs::read_to_string(&c).unwrap(),
            "<div className=\"other\" />\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── Text content ──────────────────────────────────────────────────────

    /// Locate the text after the (single) className span in `src`.
    fn text_after_class(src: &str) -> Option<TextSpan> {
        let span = find_classname_spans(src).into_iter().next()?;
        text_run_in_tag(src, span.value_end + 1)
    }

    #[test]
    fn text_run_reads_plain_leaf_text() {
        let src = "<h1 className=\"hero\">Welcome to Trase</h1>";
        let ts = text_after_class(src).unwrap();
        assert_eq!(ts.value, "Welcome to Trase");
        assert_eq!(ts.line, 1);
        // Edits the trimmed run only.
        assert_eq!(&src[ts.value_start..ts.value_end], "Welcome to Trase");
    }

    #[test]
    fn text_run_trims_surrounding_whitespace() {
        let src = "<h1 className=\"hero\">\n  Welcome\n</h1>";
        let ts = text_after_class(src).unwrap();
        assert_eq!(ts.value, "Welcome");
        assert_eq!(ts.line, 2);
        assert_eq!(&src[ts.value_start..ts.value_end], "Welcome");
    }

    #[test]
    fn text_run_rejects_dynamic_mixed_and_selfclosing() {
        // Dynamic expression child.
        assert!(text_after_class("<h1 className=\"a\">{title}</h1>").is_none());
        // Partially dynamic.
        assert!(text_after_class("<h1 className=\"a\">Total: {n}</h1>").is_none());
        // A non-inline (block) child element → mixed content.
        assert!(text_after_class("<p className=\"a\"><div>x</div> y</p>").is_none());
        // Self-closing.
        assert!(text_after_class("<img className=\"a\" />").is_none());
        // Empty.
        assert!(text_after_class("<div className=\"a\"></div>").is_none());
    }

    #[test]
    fn text_run_keeps_inline_formatting() {
        // Inline formatting tags are part of editable text and kept verbatim.
        let ts = text_after_class("<p className=\"a\">Hi <em>there</em> friend</p>").unwrap();
        assert_eq!(ts.value, "Hi <em>there</em> friend");
        let link = text_after_class("<p className=\"a\">See <a href=\"/x\">docs</a></p>").unwrap();
        assert_eq!(link.value, "See <a href=\"/x\">docs</a>");
        // Nested inline tags: the inner </strong> doesn't end the run early.
        let nested =
            text_after_class("<p className=\"a\"><strong>Bold <em>both</em></strong></p>").unwrap();
        assert_eq!(nested.value, "<strong>Bold <em>both</em></strong>");
    }

    #[test]
    fn text_run_rejects_inline_tag_with_dynamic_attr() {
        // A dynamic href inside an inline tag would be clobbered on save — refuse it.
        assert!(text_after_class("<p className=\"a\">See <a href={url}>docs</a></p>").is_none());
    }

    #[test]
    fn tag_parsing_is_quote_aware() {
        // A `>` inside an attribute value must not truncate the tag.
        let ts = text_after_class("<p className=\"a\"><a title=\"a > b\">x</a></p>").unwrap();
        assert_eq!(ts.value, "<a title=\"a > b\">x</a>");
    }

    #[test]
    fn text_run_ignores_gt_inside_attrs_and_expressions() {
        // `>` inside an attribute string and inside a `{…}` expression must not be
        // mistaken for the tag close.
        let src = "<button className=\"b\" title=\"a > b\" onClick={() => go(1>0)}>Click</button>";
        let ts = text_after_class(src).unwrap();
        assert_eq!(ts.value, "Click");
    }

    #[test]
    fn text_run_handles_astro_class_attr() {
        let src = "<h1 class=\"title\">Hello Astro</h1>";
        let span = find_attr_spans(src, attrs_for_ext("astro"))
            .into_iter()
            .next()
            .unwrap();
        let ts = text_run_in_tag(src, span.value_end + 1).unwrap();
        assert_eq!(ts.value, "Hello Astro");
    }

    #[test]
    fn text_write_back_replaces_only_trimmed_run() {
        let src = "<h1 className=\"hero\">\n  Old Title\n</h1>\n";
        let span = find_text_spans(src)
            .into_iter()
            .find(|s| s.value == "Old Title")
            .unwrap();
        let mut updated = String::new();
        updated.push_str(&src[..span.value_start]);
        updated.push_str("New Title");
        updated.push_str(&src[span.value_end..]);
        // Surrounding whitespace/newlines preserved.
        assert_eq!(updated, "<h1 className=\"hero\">\n  New Title\n</h1>\n");
    }

    #[test]
    fn find_text_spans_locates_by_line_and_value() {
        let src = "<a className=\"x\">Home</a>\n<a className=\"y\">About</a>\n";
        let spans = find_text_spans(src);
        let home = spans.iter().find(|s| s.value == "Home").unwrap();
        let about = spans.iter().find(|s| s.value == "About").unwrap();
        assert_eq!(home.line, 1);
        assert_eq!(about.line, 2);
    }

    #[test]
    fn text_run_keeps_br_line_breaks() {
        // A multi-line heading with <br /> is editable; the br is part of the value.
        let src = "<h1 className=\"hero\">Elite AI Performance.<br />Powered By Trase.</h1>";
        let ts = text_after_class(src).unwrap();
        assert_eq!(ts.value, "Elite AI Performance.<br />Powered By Trase.");
        // A non-inline element is still mixed content.
        assert!(text_after_class("<h1 className=\"a\">Hi <div>there</div></h1>").is_none());
        // <break> must not be mistaken for <br>.
        assert!(text_after_class("<h1 className=\"a\">x<break>y</h1>").is_none());
    }

    #[test]
    fn normalize_text_collapses_br_case_and_whitespace() {
        // innerText (rendered, uppercased, br→newline) normalizes to match the source.
        assert_eq!(
            normalize_text("Trusted Where Failure Is\nNot An Option."),
            normalize_text("Trusted Where Failure Is<br />Not An Option.")
        );
        assert_eq!(
            normalize_text("KEY INDUSTRIES"),
            normalize_text("Key Industries")
        );
        assert_eq!(normalize_text("  a   b "), "a b");
    }

    fn toc(value: &str, file: &str, line: usize, tag: &str) -> TextOccurrence {
        TextOccurrence {
            value: value.into(),
            norm: normalize_text(value),
            file: file.into(),
            line,
            column: 1,
            tag: tag.into(),
        }
    }

    #[test]
    fn content_search_resolves_unique_classless_text() {
        let texts = vec![toc("Health systems.", "index.astro", 5, "p")];
        let sig = ElementSignature {
            class_name: String::new(),
            tag_name: "p".into(),
            text: Some("Health systems.".into()),
            ancestor_classes: vec![],
            attr_src: None,
        };
        match resolve_text_by_content(&[], &texts, &sig) {
            TextResolution::Resolved { line, text, .. } => {
                assert_eq!(line, 5);
                assert_eq!(text, "Health systems.");
            }
            other => panic!("expected Resolved, got {other:?}"),
        }
    }

    #[test]
    fn content_search_disambiguates_repeated_class_by_text() {
        // Two <span class="tag"> with different copy — resolved by unique text.
        let texts = vec![
            toc("Key Industries", "index.astro", 10, "span"),
            toc("Our Platform", "index.astro", 20, "span"),
        ];
        let sig = ElementSignature {
            class_name: "tag".into(),
            tag_name: "span".into(),
            text: Some("KEY INDUSTRIES".into()), // CSS-uppercased innerText
            ancestor_classes: vec![],
            attr_src: None,
        };
        match resolve_text_by_content(&[], &texts, &sig) {
            TextResolution::Resolved { line, text, .. } => {
                assert_eq!(line, 10);
                assert_eq!(text, "Key Industries");
            }
            other => panic!("expected Resolved, got {other:?}"),
        }
    }

    #[test]
    fn content_search_ambiguous_is_read_only() {
        let texts = vec![
            toc("Read more", "a.tsx", 1, "a"),
            toc("Read more", "b.tsx", 1, "a"),
        ];
        let sig = ElementSignature {
            class_name: String::new(),
            tag_name: "a".into(),
            text: Some("Read more".into()),
            ancestor_classes: vec![],
            attr_src: None,
        };
        assert!(matches!(
            resolve_text_by_content(&[], &texts, &sig),
            TextResolution::ReadOnly { .. }
        ));
    }

    #[test]
    fn text_run_rejects_multi_element_container() {
        // A flex row of two buttons (two element children, no direct text) is a layout
        // container, not an editable text block.
        assert!(text_after_class(
            "<div className=\"flex\"><a href=\"/a\">One</a><a href=\"/b\">Two</a></div>"
        )
        .is_none());
        // But prose with multiple inline links (has direct text) stays editable.
        assert!(text_after_class(
            "<p className=\"x\">See <a href=\"/a\">one</a> or <a href=\"/b\">two</a></p>"
        )
        .is_some());
    }

    #[test]
    fn text_run_allows_string_literal_expression() {
        // {" "} is static text, not a dynamic expression — the run stays editable.
        let ts = text_after_class("<p className=\"x\">Hello{\" \"}world</p>").unwrap();
        assert_eq!(ts.value, "Hello{\" \"}world");
        // A real expression still disqualifies it.
        assert!(text_after_class("<p className=\"x\">Hello {name}</p>").is_none());
    }

    #[test]
    fn normalize_matches_entities_and_string_exprs() {
        // Rendered innerText (decoded, real spaces) matches encoded source.
        assert_eq!(
            normalize_text("right rep &mdash; based{\" \"}on intent"),
            normalize_text("right rep — based on intent")
        );
        assert_eq!(normalize_text("Tom &amp; Jerry"), "tom & jerry");
        assert_eq!(normalize_text("a &#8212; b"), "a — b");
    }

    #[test]
    fn jsxify_class_attr_maps_class_for_jsx_only() {
        // JSX/TSX: class -> className so re-inserted inline elements keep their styling.
        assert_eq!(
            jsxify_class_attr("a <span class=\"x y\">b</span>", "page.tsx"),
            "a <span className=\"x y\">b</span>"
        );
        assert_eq!(
            jsxify_class_attr("<a href=\"/x\" class=\"btn\">go</a>", "Hero.jsx"),
            "<a href=\"/x\" className=\"btn\">go</a>"
        );
        // Astro keeps `class`; plain text is untouched.
        assert_eq!(
            jsxify_class_attr("<span class=\"x\">b</span>", "index.astro"),
            "<span class=\"x\">b</span>"
        );
        assert_eq!(jsxify_class_attr("just text", "page.tsx"), "just text");
    }

    #[test]
    fn illegal_markup_allows_inline_only() {
        assert!(!has_illegal_markup("Plain text"));
        assert!(!has_illegal_markup("Line one<br />Line two"));
        assert!(!has_illegal_markup(
            "Make it <strong>bold</strong> and <em>italic</em>"
        ));
        assert!(!has_illegal_markup("A <a href=\"/x\">link</a>"));
        // Block/other elements and expressions are rejected.
        assert!(has_illegal_markup("Has <div>block</div>"));
        assert!(has_illegal_markup("Has <img src=\"x\">"));
        assert!(has_illegal_markup("Has {expr}"));
    }

    use std::collections::BTreeMap;
    fn default_map() -> BTreeMap<String, u32> {
        DEFAULT_BREAKPOINTS
            .iter()
            .map(|(n, p)| (n.to_string(), *p))
            .collect()
    }

    #[test]
    fn classify_file_by_next_conventions() {
        assert_eq!(classify_file("app/about/page.tsx"), FileKind::Page);
        assert_eq!(classify_file("app/layout.tsx"), FileKind::Layout);
        assert_eq!(classify_file("app/blog/layout.jsx"), FileKind::Layout);
        assert_eq!(classify_file("components/Header.tsx"), FileKind::Component);
        assert_eq!(classify_file("pages/about.tsx"), FileKind::Page);
        assert_eq!(classify_file("pages/_app.tsx"), FileKind::Layout);
    }

    #[test]
    fn classify_file_by_astro_conventions() {
        assert_eq!(classify_file("src/pages/index.astro"), FileKind::Page);
        assert_eq!(classify_file("src/pages/blog/[slug].astro"), FileKind::Page);
        assert_eq!(classify_file("src/layouts/Base.astro"), FileKind::Layout);
        assert_eq!(
            classify_file("src/components/Header.astro"),
            FileKind::Component
        );
    }

    #[test]
    fn enclosing_component_finds_the_wrapping_component() {
        let src =
            "import x;\nexport default function Hero() {\n  return <h1 className=\"a\" />;\n}\n";
        assert_eq!(enclosing_component(src, 3).as_deref(), Some("Hero"));
        let src2 = "const Card = () => {\n  return <div className=\"c\" />;\n};\n";
        assert_eq!(enclosing_component(src2, 2).as_deref(), Some("Card"));
        // A lowercase helper isn't a component.
        let src3 = "function helper() {\n  return null;\n}\n";
        assert_eq!(enclosing_component(src3, 2), None);
    }

    #[test]
    fn find_jsx_usages_is_boundary_checked() {
        let src = "<Hero />\n<HeroBar/>\n<div><Hero></Hero></div>\n";
        assert_eq!(find_jsx_usages(src, "Hero"), vec![1, 3]); // not <HeroBar
        assert_eq!(find_jsx_usages(src, "HeroBar"), vec![2]);
    }

    #[test]
    fn parse_len_px_units() {
        assert_eq!(parse_len_px("48rem"), Some(768)); // rem → ×16
        assert_eq!(parse_len_px("40rem"), Some(640));
        assert_eq!(parse_len_px("768px"), Some(768));
        assert_eq!(parse_len_px("768"), Some(768)); // unitless → px
        assert_eq!(parse_len_px("var(--x)"), None);
        assert_eq!(parse_len_px("calc(100% - 1px)"), None);
    }

    #[test]
    fn css_breakpoints_override_remove_and_custom() {
        let mut map = default_map();
        let css = r#"
            @theme {
              --breakpoint-md: 50rem;     /* override */
              --breakpoint-lg: initial;   /* remove */
              --breakpoint-tablet: 900px; /* custom */
            }
        "#;
        assert!(apply_css_breakpoints(css, &mut map));
        assert_eq!(map.get("md"), Some(&800)); // 50rem
        assert_eq!(map.get("lg"), None); // removed
        assert_eq!(map.get("tablet"), Some(&900)); // custom name
        assert_eq!(map.get("sm"), Some(&640)); // untouched default kept
    }

    #[test]
    fn css_wildcard_initial_clears_defaults() {
        let mut map = default_map();
        let css = "--breakpoint-*: initial;\n--breakpoint-md: 768px;";
        assert!(apply_css_breakpoints(css, &mut map));
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("md"), Some(&768));
    }

    #[test]
    fn no_css_breakpoints_is_not_touched() {
        let mut map = default_map();
        // A var() usage that merely mentions --breakpoint must not count as a decl.
        assert!(!apply_css_breakpoints(
            "width: var(--breakpoint-md);",
            &mut map
        ));
        assert_eq!(map.len(), DEFAULT_BREAKPOINTS.len());
    }

    #[test]
    fn v3_screens_literal_merges() {
        let mut map = default_map();
        let cfg = r#"module.exports = { theme: { screens: { sm: '480px', md: "800px" } } };"#;
        apply_v3_screens(cfg, &mut map);
        assert_eq!(map.get("sm"), Some(&480));
        assert_eq!(map.get("md"), Some(&800));
        assert_eq!(map.get("lg"), Some(&1024)); // default kept
    }

    #[test]
    fn v3_screens_non_literal_is_ignored() {
        let mut map = default_map();
        // function/spread screens → keep defaults, don't crash.
        let cfg = r#"export default { theme: { screens: require('./bp') } }"#;
        apply_v3_screens(cfg, &mut map);
        assert_eq!(map, default_map());
    }

    #[test]
    fn tailwind_active_requires_a_real_integration() {
        let dir = std::env::temp_dir().join(format!("ss-tw-{}", std::process::id()));
        let chk = tailwind_active_at;

        // Astro WITHOUT the Vite plugin — a bare `@import "tailwindcss"` doesn't compile.
        let a = dir.join("no-tw");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("astro.config.mjs"), "export default {{ }}").unwrap();
        std::fs::write(a.join("global.css"), "@import \"tailwindcss\";").unwrap();
        assert!(!chk(&a), "import alone, no plugin → not active");

        // Astro WITH the Vite plugin wired in → active.
        let b = dir.join("astro-tw");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(
            b.join("astro.config.mjs"),
            "import tailwindcss from '@tailwindcss/vite';\nexport default {{ vite: {{ plugins: [tailwindcss()] }} }}",
        )
        .unwrap();
        assert!(chk(&b), "astro.config wires tailwind → active");

        // A v3-style config file present → active.
        let c = dir.join("v3");
        std::fs::create_dir_all(&c).unwrap();
        std::fs::write(c.join("tailwind.config.js"), "module.exports = {{}}").unwrap();
        assert!(chk(&c), "tailwind.config.js present → active");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_uses_react_matches_only_the_react_dependency() {
        let dir = std::env::temp_dir().join(format!("ss-react-{}", std::process::id()));
        let chk = project_uses_react_at;

        // No package.json at all → not React.
        let none = dir.join("none");
        std::fs::create_dir_all(&none).unwrap();
        assert!(!chk(&none), "no package.json → not react");

        // A React Vite app declares the `react` dependency.
        let react = dir.join("react");
        std::fs::create_dir_all(&react).unwrap();
        std::fs::write(
            react.join("package.json"),
            r#"{ "dependencies": { "react": "^18.2.0", "react-dom": "^18.2.0" } }"#,
        )
        .unwrap();
        assert!(chk(&react), "react dependency present → react");

        // A Vue Vite app has react-adjacent devDeps but no `react` dependency.
        let vue = dir.join("vue");
        std::fs::create_dir_all(&vue).unwrap();
        std::fs::write(
            vue.join("package.json"),
            r#"{ "dependencies": { "vue": "^3.4.0" }, "devDependencies": { "@types/react": "^18.0.0" } }"#,
        )
        .unwrap();
        assert!(!chk(&vue), "vue app with @types/react devDep → not react");

        std::fs::remove_dir_all(&dir).ok();
    }

    // ───────────────────────── Image source ─────────────────────────

    fn img_sig(class: &str, tag: &str, src: &str) -> ElementSignature {
        ElementSignature {
            class_name: class.into(),
            tag_name: tag.into(),
            text: None,
            ancestor_classes: vec![],
            attr_src: Some(src.into()),
        }
    }

    fn soc(value: &str, file: &str, line: usize, tag: &str) -> SrcOccurrence {
        SrcOccurrence {
            value: value.into(),
            file: file.into(),
            line,
            column: 1,
            tag: tag.into(),
        }
    }

    #[test]
    fn finds_static_src_skips_dynamic_and_lookalikes() {
        let src = r#"
            <img src="/hero.png" alt="hero" />
            <img src={heroImg} alt="dynamic" />
            <div data-src="/not-an-img.png" srcset="/a.png 1x" />
            <Image src={"/quoted.png"} />
        "#;
        let spans = find_attr_spans(src, &["src"]);
        let values: Vec<&str> = spans.iter().map(|s| s.value.as_str()).collect();
        assert_eq!(values, vec!["/hero.png", "/quoted.png"]);
    }

    #[test]
    fn src_in_tag_static_before_and_after_class() {
        for src in [
            r#"<img className="logo" src="/logo.png" />"#,
            r#"<img src="/logo.png" className="logo" />"#,
            "<img\n  src=\"/logo.png\"\n  className=\"logo\"\n  onLoad={() => a > b}\n/>",
        ] {
            let class_span = find_attr_spans(src, &["className"])
                .into_iter()
                .find(|s| s.value == "logo")
                .unwrap();
            match src_attr_in_tag(src, class_span.value_start, class_span.value_end) {
                SrcInTag::Static { value, .. } => assert_eq!(value, "/logo.png"),
                _ => panic!("expected Static in {src}"),
            }
        }
    }

    #[test]
    fn src_in_tag_dynamic_and_missing() {
        let dynamic = r#"<img className="logo" src={logo} />"#;
        let span = find_attr_spans(dynamic, &["className"])[0].clone();
        assert!(matches!(
            src_attr_in_tag(dynamic, span.value_start, span.value_end),
            SrcInTag::Dynamic
        ));

        let missing = r#"<div className="logo">x</div>"#;
        let span = find_attr_spans(missing, &["className"])[0].clone();
        assert!(matches!(
            src_attr_in_tag(missing, span.value_start, span.value_end),
            SrcInTag::Missing
        ));
    }

    #[test]
    fn src_in_tag_ignores_sibling_tags() {
        // A src on a CHILD tag must not be picked up for a tag without one.
        let src = r#"<div className="wrap"><img src="/a.png" /></div>"#;
        let span = find_attr_spans(src, &["className"])[0].clone();
        assert!(matches!(
            src_attr_in_tag(src, span.value_start, span.value_end),
            SrcInTag::Missing
        ));
    }

    #[test]
    fn next_image_url_decodes_the_authored_path() {
        assert_eq!(
            next_image_url("/_next/image?url=%2Fhero%20shot.png&w=640&q=75"),
            Some("/hero shot.png".into())
        );
        assert_eq!(next_image_url("/hero.png"), None);
    }

    #[test]
    fn src_value_search_resolves_unique_and_reports_ambiguous() {
        let occ = vec![
            soc("/logo.png", "Nav.tsx", 4, "img"),
            soc("/hero.png", "Hero.tsx", 9, "img"),
        ];
        match resolve_src_by_value(&[], &occ, &img_sig("", "img", "/hero.png")) {
            ImageResolution::Resolved {
                file, line, src, ..
            } => {
                assert_eq!(file, "Hero.tsx");
                assert_eq!(line, 9);
                assert_eq!(src, "/hero.png");
            }
            other => panic!("expected Resolved, got {other:?}"),
        }

        let dup = vec![
            soc("/logo.png", "Nav.tsx", 4, "img"),
            soc("/logo.png", "Footer.tsx", 12, "img"),
        ];
        assert!(matches!(
            resolve_src_by_value(&[], &dup, &img_sig("", "img", "/logo.png")),
            ImageResolution::ReadOnly { .. }
        ));
    }

    #[test]
    fn src_value_search_unwraps_next_image_optimizer_urls() {
        let occ = vec![soc("/hero.png", "Hero.tsx", 9, "image")];
        let sig = img_sig("", "img", "/_next/image?url=%2Fhero.png&w=828&q=75");
        assert!(matches!(
            resolve_src_by_value(&[], &occ, &sig),
            ImageResolution::Resolved { .. }
        ));
    }

    #[test]
    fn src_value_rejects_markup_breaking_paths() {
        assert!(invalid_src_value(""));
        assert!(invalid_src_value(r#"/a".png"#));
        assert!(invalid_src_value("/a{b}.png"));
        assert!(invalid_src_value("/a<b>.png"));
        assert!(!invalid_src_value("/images/My Logo (1).png"));
        assert!(!invalid_src_value("/hero.png?v=2"));
    }
}
