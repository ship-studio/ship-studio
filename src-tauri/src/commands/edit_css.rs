//! # Visual editor — CSS Mode (class-based rule editing for HTML/CSS projects)
//!
//! A second style engine for the visual editor. Where the Tailwind path
//! (`edit.rs`) mutates the *class-attribute string* with utility tokens, CSS
//! Mode edits the **CSS rule** a class points at — `padding: 24px`, any
//! property, any value — and writes it surgically back into the stylesheet.
//!
//! ## Reliability via convention, not heroic parsing
//! We do not try to robustly handle arbitrary CSS. We narrow the input space to
//! a convention (external, class-based stylesheets; one rule per editable class;
//! a fixed `@media (min-width: …)` breakpoint set) and an out-of-band agent prep
//! prompt conforms off-spec projects into it. The engine here is therefore
//! **strict and fail-closed**: when the source doesn't match the convention it
//! returns a typed status (`Multiple`, `NotFound`, `Inline`, `NeedsClass`) and
//! refuses to guess — it never silently writes the wrong rule.
//!
//! ## Locator, not a parser
//! A heavyweight CSS parser reserializes whole files, which kills minimal-diff
//! edits and trashes formatting/comments. Instead we hand-roll a small,
//! comment/string/brace-aware locator that records, for each style rule, its
//! selector, the byte span of its declaration block, the source line, and the
//! enclosing `@media` prelude. Writes are then surgical span replacements,
//! preserving everything else byte-for-byte — the same philosophy as `i18n.rs`.
//!
//! See `docs/visual-editor-css-mode.md` for the full design and phasing.

use crate::commands::edit::Location;
use crate::errors::CommandError;
use crate::utils::validate_project_path;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Skip stylesheets larger than this (bytes) — almost certainly generated /
/// minified bundles, not hand-authored convention-conforming CSS.
const MAX_CSS_BYTES: u64 = 2 * 1024 * 1024;

/// How long a parsed-stylesheets snapshot stays fresh. Resolving runs on every
/// element select / edit; without this each one re-walks, re-reads, and re-parses
/// the whole project. Matches the Tailwind index TTL (`edit::INDEX_TTL`) so the
/// CSS editor is as snappy. Writes invalidate the entry so edits are seen at once.
const SHEET_CACHE_TTL: Duration = Duration::from_secs(10);

/// A discovered stylesheet with its rules pre-indexed. Caching the parsed rules
/// (not just the raw text) means a click resolves against memory — no re-walk,
/// re-read, or re-parse — the same shape as the Tailwind editor's `Arc`-cached
/// occurrence index.
#[derive(Clone)]
struct SheetIndex {
    rel: String,
    content: String,
    rules: Vec<RuleSpan>,
}

impl SheetIndex {
    fn parse(rel: String, content: String) -> Self {
        let rules = index_rules(&content);
        Self {
            rel,
            content,
            rules,
        }
    }
}

#[allow(clippy::type_complexity)]
static SHEET_CACHE: LazyLock<Mutex<HashMap<PathBuf, (Instant, Arc<Vec<SheetIndex>>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Parsed, cached stylesheets for `root`. Returns a cheap `Arc` clone on a hit;
/// only a cold miss walks + parses.
fn cached_sheets(root: &Path) -> Arc<Vec<SheetIndex>> {
    if let Ok(cache) = SHEET_CACHE.lock() {
        if let Some((at, sheets)) = cache.get(root) {
            if at.elapsed() < SHEET_CACHE_TTL {
                return sheets.clone();
            }
        }
    }
    let sheets = Arc::new(
        discover_stylesheets(root)
            .into_iter()
            .map(|(rel, content)| SheetIndex::parse(rel, content))
            .collect::<Vec<_>>(),
    );
    if let Ok(mut cache) = SHEET_CACHE.lock() {
        cache.insert(root.to_path_buf(), (Instant::now(), sheets.clone()));
    }
    sheets
}

/// Drop the cached snapshot for `root` after a write, so the next resolve reads
/// the just-saved CSS.
fn invalidate_sheet_cache(root: &Path) {
    if let Ok(mut cache) = SHEET_CACHE.lock() {
        cache.remove(root);
    }
}

// ───────────────────────────── Types ─────────────────────────────

/// A single CSS declaration (`property: value`), as reported to / from the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Declaration {
    pub property: String,
    pub value: String,
    #[serde(default)]
    pub important: bool,
}

/// Signature of the clicked element for CSS resolution. camelCase to match the
/// in-iframe selection script's `postMessage` payload.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CssSignature {
    /// The element's full `class` attribute (may hold several tokens).
    pub class_name: String,
    /// Lowercased DOM tag name (reserved for future disambiguation).
    #[serde(default)]
    pub tag_name: String,
    /// Which class token the user means to edit. When absent we pick the sole
    /// token, or the last one (the most specific by convention).
    #[serde(default)]
    pub target_class: Option<String>,
    /// Whether the element carries an inline `style="…"` attribute. Drives the
    /// `Inline` status (managed styling should live in a class, not inline).
    #[serde(default)]
    pub has_inline_style: bool,
    /// A pseudo-class / state to target, without the leading colon (e.g.
    /// "hover", "focus", "focus-visible"). Appended to the class selector so the
    /// editor resolves `.class:hover` — states ARE selectors in CSS.
    #[serde(default)]
    pub pseudo: Option<String>,
}

/// Whether a pseudo selector is safe to append (any state CSS allows — simple
/// `:hover`, functional `:nth-child(2n+1)`, `:not(.x)`, pseudo-elements
/// `::before`) while forbidding structural chars that could break out of the
/// selector (`{`, `}`, `;`). Must start with `:`, have balanced parens, and
/// contain a letter.
fn is_safe_pseudo(s: &str) -> bool {
    if !s.starts_with(':') {
        return false;
    }
    let mut depth = 0i32;
    let mut saw_alpha = false;
    for c in s.chars() {
        match c {
            ':' | '-' | '_' | '+' | '.' | '#' | '%' => {}
            // `,` and ` ` group/combine selectors — only legal inside a
            // functional pseudo (`:is(.a, .b)`, `:not(.x .y)`). At the top level
            // they'd break out of the appended selector.
            ',' | ' ' if depth > 0 => {}
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            c if c.is_ascii_alphanumeric() => {
                if c.is_ascii_alphabetic() {
                    saw_alpha = true;
                }
            }
            _ => return false,
        }
    }
    depth == 0 && saw_alpha
}

/// The sanitized pseudo suffix for a signature, or "" for the default state.
/// The pseudo may carry its own colon(s) (`::before`); a bare name gets one.
fn pseudo_suffix(sig: &CssSignature) -> String {
    match sig.pseudo.as_deref() {
        Some(p) => {
            let t = p.trim();
            if t.is_empty() {
                return String::new();
            }
            let with_colon = if t.starts_with(':') {
                t.to_string()
            } else {
                format!(":{t}")
            };
            if is_safe_pseudo(&with_colon) {
                with_colon
            } else {
                String::new()
            }
        }
        None => String::new(),
    }
}

/// Result of resolving an element to a CSS rule.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CssResolution {
    /// Exactly one rule defines this class at the requested breakpoint.
    Resolved {
        /// Project-relative POSIX stylesheet path.
        file: String,
        /// The class selector we resolved (e.g. `.hero-title`).
        selector: String,
        /// 1-based line of the rule's selector.
        line: usize,
        /// The `min-width` of the enclosing `@media`, if any.
        media_min_px: Option<u32>,
        /// The rule's current declarations.
        declarations: Vec<Declaration>,
    },
    /// The class is defined by more than one rule — read-only, never guessed.
    Multiple {
        selector: String,
        locations: Vec<Location>,
    },
    /// The element is styled via an inline `style` attribute, not a class.
    Inline { reason: String },
    /// The element has no class to anchor a rule to (offer "create class").
    NeedsClass { reason: String },
    /// The class exists but no rule defines it yet (offer "create rule").
    NotFound { selector: String },
}

/// One matching rule reported by the in-iframe cascade walker, to be mapped back
/// to its source location. camelCase to match the `ss:cascade` postMessage shape.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedRuleQuery {
    /// The (normalized) compound selector the browser matched, e.g. `.btn--primary`
    /// or `#hero .btn`.
    pub selector: String,
    /// The enclosing media condition text (`(max-width: 768px)`), or null for a base
    /// rule. Matched against the source `@media` prelude so a min-width OR max-width
    /// (or any) media variant resolves to its OWN rule, not the base one.
    #[serde(default)]
    pub media_text: Option<String>,
    /// The served stylesheet URL (`rule.parentStyleSheet.href`), used only as a
    /// basename tie-breaker when the same selector lives in several files.
    #[serde(default)]
    pub href: Option<String>,
    /// The enclosing `@layer` name, if the rule is inside one. Distinguishes the same
    /// selector declared in different layers (which would otherwise collide → Multiple).
    #[serde(default)]
    pub layer: Option<String>,
    /// The enclosing `@container` condition, if any — same disambiguation role as `layer`.
    #[serde(default)]
    pub container: Option<String>,
    /// The enclosing `@supports` condition, if any — same disambiguation role as `layer`.
    #[serde(default)]
    pub supports: Option<String>,
}

/// Where a cascade rule lives in source — the editable seam for the code panel.
/// Index-aligned with the `matched` input of [`locate_css_rules`].
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RuleLocation {
    /// Pinned to exactly one source rule. `inner_text` is the verbatim text inside
    /// the braces — what the editor seeds from and drift-guards against.
    Resolved {
        /// Project-relative POSIX stylesheet path.
        file: String,
        /// 1-based line of the rule's selector.
        line: usize,
        /// Verbatim source between the rule's braces.
        inner_text: String,
    },
    /// The selector resolves to more than one source rule — read-only (we never
    /// guess which one the browser painted).
    Multiple { files: Vec<String> },
    /// No authored `.css` rule backs this match (UA / framework-injected / inline /
    /// unmappable scoped style) — read-only.
    NotFound,
}

/// One located style rule and the byte span of its declaration block.
#[derive(Debug, Clone, PartialEq)]
struct RuleSpan {
    /// Full selector prelude, trimmed (may be a comma group).
    selector: String,
    /// `@media` prelude (e.g. `(min-width: 768px)`) if nested, else `None`.
    media: Option<String>,
    /// Byte range of the enclosing `@media` condition text (for editing the at-rule),
    /// if the rule is inside one.
    media_prelude: Option<(usize, usize)>,
    /// The name of the enclosing `@layer` (innermost), if any. Distinguishes the same
    /// selector declared in different cascade layers so locate doesn't collide them.
    layer: Option<String>,
    /// The enclosing `@container` condition (innermost), if any — same disambiguation role.
    container: Option<String>,
    /// The enclosing `@supports` condition (innermost), if any — same disambiguation role.
    supports: Option<String>,
    /// Byte offset of the first significant byte of the selector (for delete/wrap,
    /// which need the rule's start, not just its block).
    selector_start: usize,
    /// Byte offset just inside the opening `{`.
    block_inner_start: usize,
    /// Byte offset of the closing `}`.
    block_inner_end: usize,
    /// 1-based line of the selector.
    selector_line: usize,
}

/// A located declaration within a rule's block, with byte offsets into the
/// original stylesheet so edits can be surgical.
#[derive(Debug, Clone, PartialEq)]
struct DeclSpan {
    property: String,
    property_lc: String,
    /// First non-whitespace byte of the property name.
    decl_start: usize,
    /// First non-whitespace byte of the value.
    value_start: usize,
    /// Exclusive end of the value (trimmed; before any `;`).
    value_end: usize,
    /// Position just past the terminating `;`, or `value_end` if unterminated.
    decl_end: usize,
    /// Whether a `;` terminated this declaration.
    terminated: bool,
}

// ───────────────────────── Low-level helpers ─────────────────────────

/// 1-based line number of the given byte index.
fn line_of(src: &str, byte_idx: usize) -> usize {
    src.as_bytes()[..byte_idx.min(src.len())]
        .iter()
        .filter(|&&b| b == b'\n')
        .count()
        + 1
}

/// Leading whitespace of the line containing `pos`.
fn indent_of_line(src: &str, pos: usize) -> String {
    let bytes = src.as_bytes();
    let mut start = pos.min(bytes.len());
    while start > 0 && bytes[start - 1] != b'\n' {
        start -= 1;
    }
    let mut end = start;
    while end < bytes.len() && (bytes[end] == b' ' || bytes[end] == b'\t') {
        end += 1;
    }
    src[start..end].to_string()
}

/// Trim a byte range to its non-whitespace core, returning `(start, end)`.
fn trim_range(src: &str, mut start: usize, mut end: usize) -> (usize, usize) {
    let bytes = src.as_bytes();
    while start < end && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    (start, end)
}

/// Remove `/* … */` comments from a string, preserving everything else
/// (including UTF-8 — cuts only on the ASCII comment delimiters).
fn strip_css_comments(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut seg = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            out.push_str(&s[seg..i]);
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            seg = i;
            continue;
        }
        i += 1;
    }
    out.push_str(&s[seg..]);
    out
}

/// Byte offset of the first non-whitespace, non-comment character in
/// `[start, end)` (used for a rule's true selector line).
fn first_significant(css: &str, start: usize, end: usize) -> usize {
    let bytes = css.as_bytes();
    let mut i = start;
    while i < end {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if bytes[i] == b'/' && i + 1 < end && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < end && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(end);
            continue;
        }
        return i;
    }
    end
}

/// Extract the `min-width` pixel value from an `@media` prelude.
fn media_min_px(prelude: &str) -> Option<u32> {
    let low = prelude.to_ascii_lowercase();
    let idx = low.find("min-width")?;
    let after = &low[idx + "min-width".len()..];
    let after = after.split(':').nth(1)?;
    let digits: String = after
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// Does a rule's media context match the requested breakpoint? Base edits
/// (`None`) match only un-mediated rules; a breakpoint edit matches only the
/// `@media` block with that exact `min-width`.
fn media_matches(media: &Option<String>, bp: Option<u32>) -> bool {
    match (media, bp) {
        (None, None) => true,
        (Some(m), Some(px)) => media_min_px(m) == Some(px),
        _ => false,
    }
}

/// Does a (possibly comma-grouped) selector contain `target` as one of its
/// parts exactly? Strictness is intentional — descendant/compound selectors
/// don't match, so we never edit a rule that also styles other elements
/// implicitly.
/// Split a grouped selector on its TOP-LEVEL commas only — commas inside
/// `:is(.a, .b)` / `:not(…)` / `[attr="a,b"]` are protected by paren / bracket /
/// string depth. Mirrors the iframe walker's `ssSplitSel` so the two stay in
/// agreement; a naive `split(',')` would shred a functional pseudo-class into
/// non-matching fragments (`.x:is(.a` + ` .b)`), the root of several "read-only on
/// modern CSS" misses.
fn split_selector_group(sel: &str) -> Vec<&str> {
    let bytes = sel.as_bytes();
    let mut parts: Vec<&str> = Vec::new();
    let mut depth = 0i32;
    let mut quote = 0u8;
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if quote != 0 {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == quote {
                quote = 0;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' | b'\'' => quote = c,
            b'(' | b'[' => depth += 1,
            b')' | b']' => {
                if depth > 0 {
                    depth -= 1;
                }
            }
            b',' if depth == 0 => {
                parts.push(&sel[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(&sel[start..]);
    parts
}

fn selector_has_part(selector: &str, target: &str) -> bool {
    split_selector_group(selector)
        .iter()
        .any(|p| p.trim() == target)
}

/// Normalize a selector for cross-source comparison: collapse runs of whitespace
/// to one space, drop the spaces around descendant combinators so an authored
/// `.a>.b` matches the browser-serialized `.a > .b`, and canonicalize the spacing
/// around commas *inside* functional pseudo-classes so `:is(.a,.b)` (source) matches
/// `:is(.a, .b)` (browser-serialized). Comparison-only — never written back to source,
/// so flattening whitespace inside an attribute string is harmless (both sides flatten).
fn norm_selector(s: &str) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .replace(" > ", ">")
        .replace(" + ", "+")
        .replace(" ~ ", "~")
        .replace(", ", ",")
        .replace(" ,", ",")
}

/// Like [`selector_has_part`] but whitespace/combinator-insensitive — used to match
/// a browser-reported compound selector against an authored rule's selector group.
fn rule_selector_matches(rule_selector: &str, target: &str) -> bool {
    let t = norm_selector(target);
    split_selector_group(rule_selector)
        .iter()
        .any(|p| norm_selector(p) == t)
}

/// Whether a rule's `@media` prelude equals the browser-reported condition text
/// (whitespace/case-insensitive). Both empty → a base (un-mediated) rule. This
/// matches by the FULL condition so max-width / feature queries don't collide with
/// the base rule the way a min-width-only comparison did.
/// Normalize an at-rule condition for comparison: drop whitespace, lowercase. So
/// `(max-width: 768px)` and `(max-width:768px)` (browser vs source) compare equal.
fn norm_cond(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn media_text_matches(rule_media: &Option<String>, query: &Option<String>) -> bool {
    let r = rule_media.as_deref().map(norm_cond).unwrap_or_default();
    let q = query.as_deref().map(norm_cond).unwrap_or_default();
    r == q
}

/// Whether braces in an edited rule body are balanced (comment/string-aware) — the
/// guard that lets nested CSS through while still preventing a body from breaking
/// out of its own block.
fn braces_balanced(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0usize;
    let mut depth = 0i32;
    let mut quote = 0u8;
    while i < b.len() {
        let c = b[i];
        if quote != 0 {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == quote {
                quote = 0;
            }
            i += 1;
            continue;
        }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            i += 2;
            let mut closed = false;
            while i + 1 < b.len() {
                if b[i] == b'*' && b[i + 1] == b'/' {
                    closed = true;
                    i += 2;
                    break;
                }
                i += 1;
            }
            // An unterminated comment swallows the rest of the source — including this
            // body's own closing brace and every following rule. Refuse the write.
            if !closed {
                return false;
            }
            continue;
        }
        match c {
            b'"' | b'\'' => quote = c,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
        i += 1;
    }
    depth == 0 && quote == 0
}

/// The filename component of a served stylesheet URL (`…/styles.css?v=3` → `styles.css`).
fn href_basename(href: &str) -> Option<String> {
    let no_q = href.split(['?', '#']).next().unwrap_or(href);
    no_q.rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// The filename component of a project-relative POSIX path, minus any `?style=N`
/// embedded-block suffix (`src/Foo.astro?style=0` → `Foo.astro`).
fn rel_basename(rel: &str) -> &str {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.split('?').next().unwrap_or(name)
}

/// Map one cascade match to its source rule across the pre-indexed sheets.
fn locate_rule(sheets: &[SheetIndex], q: &MatchedRuleQuery) -> RuleLocation {
    let resolved = |rel: &str, content: &str, rule: &RuleSpan| RuleLocation::Resolved {
        file: rel.to_string(),
        line: rule.selector_line,
        inner_text: content[rule.block_inner_start..rule.block_inner_end].to_string(),
    };

    let mut hits: Vec<(&str, &str, &RuleSpan)> = Vec::new();
    for sheet in sheets {
        for rule in &sheet.rules {
            if rule_selector_matches(&rule.selector, &q.selector)
                && media_text_matches(&rule.media, &q.media_text)
            {
                hits.push((sheet.rel.as_str(), sheet.content.as_str(), rule));
            }
        }
    }

    match hits.len() {
        0 => RuleLocation::NotFound,
        1 => {
            let (rel, content, rule) = hits[0];
            resolved(rel, content, rule)
        }
        _ => {
            // Several rules share this selector + media. Break the tie — as a tie-break,
            // never a hard filter, so a single-hit locate can't regress. First by at-rule
            // CONTEXT (layer / container / supports — the same selector in a different
            // cascade layer or condition is genuinely a distinct rule), then by the served
            // href's basename (same selector across files). Resolve only if exactly one
            // survives; otherwise it's honestly ambiguous → read-only.
            let cond_eq = |a: &Option<String>, b: &Option<String>| match (a, b) {
                (Some(x), Some(y)) => norm_cond(x) == norm_cond(y),
                (None, None) => true,
                _ => false,
            };
            let by_ctx: Vec<_> = hits
                .iter()
                .copied()
                .filter(|(_, _, r)| {
                    cond_eq(&r.layer, &q.layer)
                        && cond_eq(&r.container, &q.container)
                        && cond_eq(&r.supports, &q.supports)
                })
                .collect();
            let pool = if by_ctx.len() == 1 {
                return {
                    let (rel, content, rule) = by_ctx[0];
                    resolved(rel, content, rule)
                };
            } else if !by_ctx.is_empty() && by_ctx.len() < hits.len() {
                by_ctx
            } else {
                hits.clone()
            };
            if let Some(base) = q.href.as_deref().and_then(href_basename) {
                let narrowed: Vec<_> = pool
                    .iter()
                    .copied()
                    .filter(|(rel, _, _)| rel_basename(rel) == base)
                    .collect();
                if narrowed.len() == 1 {
                    let (rel, content, rule) = narrowed[0];
                    return resolved(rel, content, rule);
                }
            }
            RuleLocation::Multiple {
                files: pool.iter().map(|(rel, _, _)| rel.to_string()).collect(),
            }
        }
    }
}

/// Replace the verbatim body of the single rule matching `selector`+`bp` in `src`,
/// drift-guarded against `old_inner`. The testable core of [`apply_css_rule_text`].
fn apply_rule_text_to_source(
    src: &str,
    selector: &str,
    media_text: &Option<String>,
    old_inner: &str,
    new_inner: &str,
) -> Result<String, CommandError> {
    let all = index_rules(src);
    let matches: Vec<&RuleSpan> = all
        .iter()
        .filter(|r| {
            rule_selector_matches(&r.selector, selector) && media_text_matches(&r.media, media_text)
        })
        .collect();
    let rule = pick_by_body(&matches, src, old_inner)?;
    // Drift guard: the source must still read exactly what the editor was seeded
    // with, or another change has landed and we'd clobber it.
    let current = &src[rule.block_inner_start..rule.block_inner_end];
    if current != old_inner {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "source changed since you selected it — reselect to edit".into(),
        });
    }
    let mut out = String::with_capacity(src.len() - current.len() + new_inner.len());
    out.push_str(&src[..rule.block_inner_start]);
    out.push_str(new_inner);
    out.push_str(&src[rule.block_inner_end..]);
    Ok(out)
}

/// Pin the ONE rule to edit among candidates that share a selector + media. When more
/// than one matches (a base rule plus the same selector inside `@container`/`@supports`/
/// `@layer`, which the write API doesn't otherwise distinguish), narrow by the body the
/// editor was seeded with (`old_inner`) — a natural, drift-safe discriminator.
fn pick_by_body<'a>(
    matches: &[&'a RuleSpan],
    src: &str,
    old_inner: &str,
) -> Result<&'a RuleSpan, CommandError> {
    match matches.len() {
        0 => Err(CommandError::Validation {
            field: "selector".into(),
            reason: "rule no longer matches — reselect the element".into(),
        }),
        1 => Ok(matches[0]),
        _ => {
            let narrowed: Vec<&'a RuleSpan> = matches
                .iter()
                .copied()
                .filter(|r| src[r.block_inner_start..r.block_inner_end] == *old_inner)
                .collect();
            match narrowed.len() {
                1 => Ok(narrowed[0]),
                _ => Err(CommandError::Validation {
                    field: "selector".into(),
                    reason: "selector matches multiple rules — not editable".into(),
                }),
            }
        }
    }
}

/// Find the single rule matching `selector`+`media_text` and verify its body still
/// reads `old_inner` (drift guard). The shared front half of delete/wrap.
fn locate_one_editable<'a>(
    rules: &'a [RuleSpan],
    src: &str,
    selector: &str,
    media_text: &Option<String>,
    old_inner: &str,
) -> Result<&'a RuleSpan, CommandError> {
    let matches: Vec<&RuleSpan> = rules
        .iter()
        .filter(|r| {
            rule_selector_matches(&r.selector, selector) && media_text_matches(&r.media, media_text)
        })
        .collect();
    let rule = pick_by_body(&matches, src, old_inner)?;
    if &src[rule.block_inner_start..rule.block_inner_end] != old_inner {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "source changed since you selected it — reselect to edit".into(),
        });
    }
    Ok(rule)
}

/// Remove the whole rule (selector through closing `}`, plus its line's leading
/// indentation and one trailing newline) from `src`. The testable core of
/// [`delete_css_rule`].
fn remove_rule_from_source(
    src: &str,
    selector: &str,
    media_text: &Option<String>,
    old_inner: &str,
) -> Result<String, CommandError> {
    let rules = index_rules(src);
    let rule = locate_one_editable(&rules, src, selector, media_text, old_inner)?;
    let bytes = src.as_bytes();
    // Back up over the selector line's indentation so we don't leave a blank gutter.
    let mut start = rule.selector_start;
    while start > 0 && (bytes[start - 1] == b' ' || bytes[start - 1] == b'\t') {
        start -= 1;
    }
    let mut end = rule.block_inner_end + 1; // just past the closing `}`
    while end < bytes.len() && (bytes[end] == b' ' || bytes[end] == b'\t') {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'\n' {
        end += 1;
    }

    // If the rule is the SOLE child of an enclosing `@media`, take the whole wrapper
    // with it — don't leave an empty `@media (…) {}` behind (which would accumulate as
    // you add/remove conditional rules). Only when it's truly the only child: a sibling
    // rule before or after means the wrapper must stay.
    if let Some((cs, ce)) = rule.media_prelude {
        // The at-rule's `@` (scan back from the condition text) and opening `{`.
        let mut at = cs;
        while at > 0 && bytes[at - 1] != b'@' && bytes[at - 1] != b'\n' {
            at -= 1;
        }
        let at_start = if at > 0 && bytes[at - 1] == b'@' {
            at - 1
        } else {
            at
        };
        let mut ob = ce;
        while ob < bytes.len() && bytes[ob] != b'{' {
            ob += 1;
        }
        let before_empty = ob < bytes.len()
            && ob + 1 <= rule.selector_start
            && src[ob + 1..rule.selector_start].trim().is_empty();
        let mut after = rule.block_inner_end + 1;
        while after < bytes.len() && (bytes[after] as char).is_whitespace() {
            after += 1;
        }
        let after_is_wrapper_close = after < bytes.len() && bytes[after] == b'}';
        if before_empty && after_is_wrapper_close {
            start = at_start;
            while start > 0 && (bytes[start - 1] == b' ' || bytes[start - 1] == b'\t') {
                start -= 1;
            }
            end = after + 1; // past the wrapper's `}`
            while end < bytes.len() && (bytes[end] == b' ' || bytes[end] == b'\t') {
                end += 1;
            }
            if end < bytes.len() && bytes[end] == b'\n' {
                end += 1;
            }
        }
    }

    let mut out = String::with_capacity(src.len() - (end - start));
    out.push_str(&src[..start]);
    out.push_str(&src[end..]);
    Ok(out)
}

/// Replace the matching rule's selector with `new_selector` (drift-guarded against
/// `old_inner`). Lets the user change a rule to any selector — combinators, pseudo
/// classes, attributes — the only constraint is no `{`/`}`. Testable core of
/// [`rename_css_selector`].
fn rename_selector_in_source(
    src: &str,
    selector: &str,
    media_text: &Option<String>,
    old_inner: &str,
    new_selector: &str,
) -> Result<String, CommandError> {
    validate_selector(new_selector)?;
    let rules = index_rules(src);
    let rule = locate_one_editable(&rules, src, selector, media_text, old_inner)?;
    let brace = rule.block_inner_start - 1; // the opening `{`
    let mut out = String::with_capacity(src.len() + new_selector.len());
    out.push_str(&src[..rule.selector_start]);
    out.push_str(new_selector.trim());
    out.push(' ');
    out.push_str(&src[brace..]); // `{ … }`
    Ok(out)
}

/// Replace the condition of the `@media` block enclosing the matching rule with
/// `new_media` (drift-guarded). Edits the shared wrapper, so every rule inside that
/// `@media` moves with it. Testable core of [`rename_css_at_rule`].
fn rename_at_rule_in_source(
    src: &str,
    selector: &str,
    media_text: &Option<String>,
    old_inner: &str,
    new_media: &str,
) -> Result<String, CommandError> {
    let nm = new_media.trim();
    if nm.is_empty() || nm.contains('{') || nm.contains('}') {
        return Err(CommandError::Validation {
            field: "media".into(),
            reason: "invalid at-rule condition".into(),
        });
    }
    let rules = index_rules(src);
    let rule = locate_one_editable(&rules, src, selector, media_text, old_inner)?;
    let (cs, ce) = rule.media_prelude.ok_or_else(|| CommandError::Validation {
        field: "media".into(),
        reason: "this rule isn't inside an at-rule".into(),
    })?;
    let mut out = String::with_capacity(src.len() + nm.len());
    out.push_str(&src[..cs]);
    out.push_str(nm);
    out.push_str(&src[ce..]);
    Ok(out)
}

/// Wrap the matching rule in an at-rule: `selector { body }` →
/// `at_prelude {\n  selector { body }\n}` (re-indented). The testable core of
/// [`wrap_css_rule`]. The inner rule stays editable afterward for `@media`
/// (condition surfaced) and for the descended grouping at-rules `@layer`/
/// `@supports`/`@container`.
/// An at-rule prelude must start with `@` and carry no braces (a brace would let it
/// break out of the wrapper). Shared by `wrap_css_rule` and conditional rule creation.
fn validate_at_prelude(at_prelude: &str) -> Result<(), CommandError> {
    let at = at_prelude.trim();
    if !at.starts_with('@') || at.contains('{') || at.contains('}') {
        return Err(CommandError::Validation {
            field: "atRule".into(),
            reason: "invalid at-rule prelude".into(),
        });
    }
    Ok(())
}

fn wrap_rule_in_source(
    src: &str,
    selector: &str,
    media_text: &Option<String>,
    at_prelude: &str,
    old_inner: &str,
) -> Result<String, CommandError> {
    validate_at_prelude(at_prelude)?;
    let at = at_prelude.trim();
    let rules = index_rules(src);
    let rule = locate_one_editable(&rules, src, selector, media_text, old_inner)?;
    let bytes = src.as_bytes();
    let mut region_start = rule.selector_start;
    while region_start > 0 && bytes[region_start - 1] != b'\n' {
        region_start -= 1;
    }
    let region_end = rule.block_inner_end + 1; // just past the closing `}`
    let rule_text = &src[rule.selector_start..region_end]; // selector through `}`
    let indented = format!("  {}", rule_text.replace('\n', "\n  "));
    let wrapped = format!("{at} {{\n{indented}\n}}");
    let mut out = String::with_capacity(src.len() + wrapped.len());
    out.push_str(&src[..region_start]);
    out.push_str(&wrapped);
    out.push_str(&src[region_end..]);
    Ok(out)
}

// ───────────────────────────── Locator ─────────────────────────────

/// Index every style rule in a stylesheet, including those nested in `@media` and
/// the grouping at-rules `@layer`/`@supports`/`@container` (descended into). Comments,
/// strings, `;`-statements (`@import`/`@charset`), `@keyframes`/`@font-face`/`@page`
/// inner blocks, and CSS-nested child rules are skipped rather than mis-read as rules.
fn index_rules(css: &str) -> Vec<RuleSpan> {
    enum Frame {
        /// `@media` block — condition string + byte range of the condition text.
        Media(String, usize, usize),
        /// A grouping at-rule that holds ordinary style rules (`@layer`, `@supports`,
        /// `@container`): we descend and index the rules inside it so they stay editable.
        /// Payload carries the kind + condition so same-selector rules in different
        /// layers/containers/supports are distinguishable on locate.
        Group(GroupKind),
        /// An at-rule whose inner blocks are NOT style rules (`@keyframes` stops,
        /// `@font-face`/`@page` descriptors), or a malformed block — not indexed.
        Other,
        /// A style rule; payload is its index in `rules`.
        Rule(usize),
    }
    /// What kind of grouping at-rule a `Frame::Group` is, with its discriminating text.
    enum GroupKind {
        Layer(String),
        Container(String),
        Supports(String),
        /// Anonymous `@layer { }` — descended but carries no discriminator.
        Anonymous,
    }

    /// The nearest enclosing `@media` condition + its byte range, if any.
    fn enclosing_media(stack: &[Frame]) -> (Option<String>, Option<(usize, usize)>) {
        stack
            .iter()
            .rev()
            .find_map(|f| match f {
                Frame::Media(m, cs, ce) => Some((Some(m.clone()), Some((*cs, *ce)))),
                _ => None,
            })
            .unwrap_or((None, None))
    }
    /// The nearest enclosing named `@layer`, if any.
    fn enclosing_layer(stack: &[Frame]) -> Option<String> {
        stack.iter().rev().find_map(|f| match f {
            Frame::Group(GroupKind::Layer(name)) => Some(name.clone()),
            _ => None,
        })
    }
    /// The nearest enclosing `@container` condition, if any.
    fn enclosing_container(stack: &[Frame]) -> Option<String> {
        stack.iter().rev().find_map(|f| match f {
            Frame::Group(GroupKind::Container(c)) => Some(c.clone()),
            _ => None,
        })
    }
    /// The nearest enclosing `@supports` condition, if any.
    fn enclosing_supports(stack: &[Frame]) -> Option<String> {
        stack.iter().rev().find_map(|f| match f {
            Frame::Group(GroupKind::Supports(c)) => Some(c.clone()),
            _ => None,
        })
    }

    let bytes = css.as_bytes();
    let n = bytes.len();
    let mut rules: Vec<RuleSpan> = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    let mut prelude_start = 0usize;
    let mut i = 0usize;

    while i < n {
        let c = bytes[i];

        // Comment
        if c == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }
        // String
        if c == b'"' || c == b'\'' {
            i += 1;
            while i < n && bytes[i] != c {
                if bytes[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(n);
            continue;
        }

        // A `;` ends a statement (`@import …;`, `@charset …;`, `@layer a, b;`) or a
        // declaration. Reset the prelude marker so a completed statement never leaks
        // into the next rule's selector (which previously made the first rule after an
        // `@import`/`@charset`/`@layer` statement unindexed → read-only).
        if c == b';' {
            i += 1;
            prelude_start = i;
            continue;
        }

        if c == b'{' {
            let prelude_clean = strip_css_comments(&css[prelude_start..i]);
            let prelude = prelude_clean.trim();
            let inside_rule = matches!(stack.last(), Some(Frame::Rule(_)));
            let inside_other = stack.iter().any(|f| matches!(f, Frame::Other));

            if inside_rule || inside_other {
                stack.push(Frame::Other);
            } else if let Some(rest) = prelude.strip_prefix('@') {
                let name: String = rest
                    .chars()
                    .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
                    .collect::<String>()
                    .to_ascii_lowercase();
                if name == "media" {
                    let media_prelude = rest["media".len()..].trim().to_string();
                    // Byte range of the condition text within the original source, so
                    // the at-rule can be edited in place.
                    let raw = &css[prelude_start..i];
                    let kw = raw
                        .to_ascii_lowercase()
                        .find("@media")
                        .map(|k| k + 6)
                        .unwrap_or(0);
                    let rb = raw.as_bytes();
                    let mut cs = kw;
                    while cs < raw.len() && rb[cs].is_ascii_whitespace() {
                        cs += 1;
                    }
                    let mut ce = raw.len();
                    while ce > cs && rb[ce - 1].is_ascii_whitespace() {
                        ce -= 1;
                    }
                    stack.push(Frame::Media(
                        media_prelude,
                        prelude_start + cs,
                        prelude_start + ce,
                    ));
                } else if name == "layer"
                    || name == "supports"
                    || name == "container"
                    || name == "scope"
                {
                    // Grouping at-rules that hold ordinary style rules — descend so their
                    // contents are editable (font-face/page do NOT). Capture the condition
                    // (layer name / container query / supports test) so the same selector
                    // in different contexts doesn't collide on locate. `@scope` descends
                    // too (its `:scope`/nested rules are editable) — without this it was
                    // `Frame::Other` so everything inside was read-only, and the `@scope`
                    // wrap-menu action stranded the rule out of the editor.
                    let cond = rest[name.len()..].trim();
                    let kind = match name.as_str() {
                        "layer" if cond.is_empty() => GroupKind::Anonymous,
                        "layer" => GroupKind::Layer(cond.to_string()),
                        "container" => GroupKind::Container(cond.to_string()),
                        "supports" => GroupKind::Supports(cond.to_string()),
                        _ => GroupKind::Anonymous, // @scope — descend; no disambiguator yet
                    };
                    stack.push(Frame::Group(kind));
                } else if name.ends_with("keyframes") {
                    // `@keyframes <name>` / `@-webkit-keyframes <name>`: a named
                    // animation. Index the whole rule as ONE locatable/editable block
                    // (selector = the full `@keyframes name` prelude); its step blocks
                    // (`0%`, `from`, …) are written verbatim as body text rather than
                    // indexed as separate style rules (so the body round-trips through
                    // `apply_css_rule_text`).
                    let (media, media_prelude) = enclosing_media(&stack);
                    let layer = enclosing_layer(&stack);
                    let container = enclosing_container(&stack);
                    let supports = enclosing_supports(&stack);
                    let selector_start = first_significant(css, prelude_start, i);
                    let selector_line = line_of(css, selector_start);
                    let idx = rules.len();
                    rules.push(RuleSpan {
                        selector: prelude.to_string(),
                        media,
                        media_prelude,
                        layer,
                        container,
                        supports,
                        selector_start,
                        block_inner_start: i + 1,
                        block_inner_end: i + 1,
                        selector_line,
                    });
                    stack.push(Frame::Rule(idx));
                } else {
                    stack.push(Frame::Other);
                }
            } else if !prelude.is_empty() {
                let (media, media_prelude) = enclosing_media(&stack);
                let layer = enclosing_layer(&stack);
                let container = enclosing_container(&stack);
                let supports = enclosing_supports(&stack);
                let selector_start = first_significant(css, prelude_start, i);
                let selector_line = line_of(css, selector_start);
                let idx = rules.len();
                rules.push(RuleSpan {
                    selector: prelude.to_string(),
                    media,
                    media_prelude,
                    layer,
                    container,
                    supports,
                    selector_start,
                    block_inner_start: i + 1,
                    block_inner_end: i + 1,
                    selector_line,
                });
                stack.push(Frame::Rule(idx));
            } else {
                stack.push(Frame::Other);
            }
            i += 1;
            prelude_start = i;
            continue;
        }

        if c == b'}' {
            if let Some(Frame::Rule(idx)) = stack.pop() {
                rules[idx].block_inner_end = i;
            }
            i += 1;
            prelude_start = i;
            continue;
        }

        i += 1;
    }

    rules
}

/// Locate every declaration inside a rule's block `[inner_start, inner_end)`,
/// with byte offsets into the original stylesheet.
fn locate_declarations(css: &str, inner_start: usize, inner_end: usize) -> Vec<DeclSpan> {
    let bytes = css.as_bytes();
    let mut out = Vec::new();
    let mut seg_start = inner_start;
    let mut i = inner_start;
    let mut depth = 0i32;

    let flush = |seg_start: usize, seg_end: usize, terminated: bool, out: &mut Vec<DeclSpan>| {
        let (ds, de) = trim_range(css, seg_start, seg_end);
        if ds >= de {
            return;
        }
        // Find the property/value colon, ignoring strings/parens.
        let seg = &css.as_bytes()[ds..de];
        let mut colon: Option<usize> = None;
        let mut d = 0i32;
        let mut j = 0usize;
        while j < seg.len() {
            let ch = seg[j];
            if ch == b'"' || ch == b'\'' {
                j += 1;
                while j < seg.len() && seg[j] != ch {
                    if seg[j] == b'\\' {
                        j += 1;
                    }
                    j += 1;
                }
                j += 1;
                continue;
            }
            match ch {
                b'(' => d += 1,
                b')' => d -= 1,
                b':' if d == 0 => {
                    colon = Some(ds + j);
                    break;
                }
                _ => {}
            }
            j += 1;
        }
        let Some(colon) = colon else { return };
        let (vs, ve) = trim_range(css, colon + 1, de);
        if vs >= ve {
            return;
        }
        let property = css[ds..colon].trim().to_string();
        let decl_end = if terminated {
            (seg_end + 1).min(inner_end)
        } else {
            ve
        };
        out.push(DeclSpan {
            property_lc: property.to_ascii_lowercase(),
            property,
            decl_start: ds,
            value_start: vs,
            value_end: ve,
            decl_end,
            terminated,
        });
    };

    // Brace depth tracks nested rules / at-rules inside this block (CSS nesting,
    // `&:hover { … }`, a nested `@media { … }`). Their preludes are not declarations
    // and their inner declarations belong to *them*, not to this block — so we never
    // flush a segment while inside one, and resume scanning after its closing brace.
    let mut brace_depth = 0i32;
    while i < inner_end {
        let c = bytes[i];
        if c == b'/' && i + 1 < inner_end && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < inner_end && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(inner_end);
            continue;
        }
        if c == b'"' || c == b'\'' {
            i += 1;
            while i < inner_end && bytes[i] != c {
                if bytes[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(inner_end);
            continue;
        }
        match c {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'{' => brace_depth += 1,
            b'}' => {
                brace_depth -= 1;
                if brace_depth <= 0 {
                    // Closed a nested block — the next top-level declaration (if any)
                    // starts here. Drop any half-scanned prelude and re-sync paren depth.
                    brace_depth = 0;
                    seg_start = i + 1;
                    depth = 0;
                }
            }
            b';' if brace_depth == 0 && depth == 0 => {
                flush(seg_start, i, true, &mut out);
                seg_start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    // Only flush a trailing segment when we're back at the top level — a body that
    // ends inside a nested block has no dangling top-level declaration to emit.
    if brace_depth == 0 {
        flush(seg_start, inner_end, false, &mut out);
    }
    out
}

/// Parse a rule block into `Declaration`s (with `!important` split out of value).
fn declarations_in(css: &str, rule: &RuleSpan) -> Vec<Declaration> {
    locate_declarations(css, rule.block_inner_start, rule.block_inner_end)
        .into_iter()
        .map(|d| {
            let raw = css[d.value_start..d.value_end].trim();
            let (value, important) = match raw.to_ascii_lowercase().rfind("!important") {
                Some(idx) => (raw[..idx].trim().to_string(), true),
                None => (raw.to_string(), false),
            };
            Declaration {
                property: d.property,
                value,
                important,
            }
        })
        .collect()
}

// ─────────────────────── Surgical declaration write ───────────────────────

/// Set, add, or remove (`value: None`) a single declaration inside the rule
/// block `[inner_start, inner_end)`, preserving all surrounding formatting.
fn set_declaration_in_block(
    css: &str,
    inner_start: usize,
    inner_end: usize,
    property: &str,
    value: Option<&str>,
) -> String {
    let decls = locate_declarations(css, inner_start, inner_end);
    let prop_lc = property.to_ascii_lowercase();
    let existing = decls.iter().find(|d| d.property_lc == prop_lc);

    match (existing, value) {
        // Update an existing declaration's value in place. Preserve a trailing
        // `!important` the UI doesn't round-trip (it tracks the flag separately
        // and sends only the value), so editing a property never silently drops
        // its importance.
        (Some(d), Some(v)) => {
            let existing = css[d.value_start..d.value_end].trim_end();
            let keep_important = existing.to_ascii_lowercase().ends_with("!important")
                && !v.to_ascii_lowercase().contains("!important");
            let mut out = String::with_capacity(css.len());
            out.push_str(&css[..d.value_start]);
            out.push_str(v);
            if keep_important {
                out.push_str(" !important");
            }
            out.push_str(&css[d.value_end..]);
            out
        }
        // Remove a declaration, taking its whole line with it.
        (Some(d), None) => {
            let bytes = css.as_bytes();
            // Back up over the indentation to the line start.
            let mut rs = d.decl_start;
            while rs > inner_start && (bytes[rs - 1] == b' ' || bytes[rs - 1] == b'\t') {
                rs -= 1;
            }
            // Swallow one trailing newline so we don't leave a blank line.
            let mut re = d.decl_end;
            while re < inner_end && (bytes[re] == b' ' || bytes[re] == b'\t') {
                re += 1;
            }
            if re < inner_end && bytes[re] == b'\n' {
                re += 1;
            } else if rs > inner_start && bytes[rs - 1] == b'\n' {
                // No trailing newline (last decl) — drop the leading one instead.
                rs -= 1;
            }
            let mut out = String::with_capacity(css.len());
            out.push_str(&css[..rs]);
            out.push_str(&css[re..]);
            out
        }
        // Append a new declaration after the last one.
        (None, Some(v)) => {
            if let Some(last) = decls.last() {
                let insert_at = last.decl_end;
                let indent = indent_of_line(css, last.decl_start);
                let mut ins = String::new();
                if !last.terminated {
                    ins.push(';');
                }
                ins.push('\n');
                ins.push_str(&indent);
                ins.push_str(property);
                ins.push_str(": ");
                ins.push_str(v);
                ins.push(';');
                let mut out = String::with_capacity(css.len() + ins.len());
                out.push_str(&css[..insert_at]);
                out.push_str(&ins);
                out.push_str(&css[insert_at..]);
                out
            } else if css[inner_start..inner_end].trim().is_empty() {
                // Truly empty block — lay out a fresh multi-line body.
                let rule_indent = indent_of_line(css, inner_start);
                let decl_indent = format!("{rule_indent}  ");
                let body = format!("\n{decl_indent}{property}: {v};\n{rule_indent}");
                let mut out = String::with_capacity(css.len() + body.len());
                out.push_str(&css[..inner_start]);
                out.push_str(&body);
                out.push_str(&css[inner_end..]);
                out
            } else {
                // No top-level declarations, but the block isn't empty — it holds
                // nested rules / at-rules. Insert the new declaration at the top,
                // ahead of (and without disturbing) that nested content.
                let rule_indent = indent_of_line(css, inner_start);
                let decl_indent = format!("{rule_indent}  ");
                let ins = format!("\n{decl_indent}{property}: {v};");
                let mut out = String::with_capacity(css.len() + ins.len());
                out.push_str(&css[..inner_start]);
                out.push_str(&ins);
                out.push_str(&css[inner_start..]);
                out
            }
        }
        // Nothing to remove.
        (None, None) => css.to_string(),
    }
}

/// Render a new rule (optionally wrapped in an `@media` block) ready to append.
fn build_rule_text(
    selector: &str,
    declarations: &[Declaration],
    min_px: Option<u32>,
    at_prelude: Option<&str>,
) -> String {
    // The rule is wrapped (and so indented) when it sits inside an at-rule — either an
    // explicit `at_prelude` (`@media (max-width: …)`, `@container`, `@supports`) or the
    // `min_px` shorthand that builds a `@media (min-width: …)`.
    let wrapped = at_prelude.is_some() || min_px.is_some();
    let (base, decl_indent) = if wrapped { ("  ", "    ") } else { ("", "  ") };
    let mut body = String::new();
    body.push_str(base);
    body.push_str(selector);
    body.push_str(" {\n");
    for d in declarations {
        body.push_str(decl_indent);
        body.push_str(&d.property);
        body.push_str(": ");
        body.push_str(&d.value);
        if d.important {
            body.push_str(" !important");
        }
        body.push_str(";\n");
    }
    body.push_str(base);
    body.push('}');

    if let Some(prelude) = at_prelude {
        format!("{} {{\n{body}\n}}", prelude.trim())
    } else if let Some(px) = min_px {
        format!("@media (min-width: {px}px) {{\n{body}\n}}")
    } else {
        body
    }
}

// ───────────────────────── Resolution core (pure) ─────────────────────────

/// Pick the class token the user means to edit.
fn pick_class(sig: &CssSignature) -> Option<String> {
    if let Some(t) = sig.target_class.as_ref().map(|s| s.trim()) {
        if !t.is_empty() {
            return Some(t.trim_start_matches('.').to_string());
        }
    }
    let toks: Vec<&str> = sig.class_name.split_whitespace().collect();
    toks.last().map(|s| s.to_string())
}

/// Resolve against already-indexed stylesheets — the testable core of
/// [`resolve_css_rule`], free of filesystem and path validation. Filters the
/// pre-parsed rules (no re-parse), so a click is an in-memory scan.
fn resolve_in_sheets(sheets: &[SheetIndex], sig: &CssSignature, bp: Option<u32>) -> CssResolution {
    let class = match pick_class(sig) {
        Some(c) => c,
        None => {
            return if sig.has_inline_style {
                CssResolution::Inline {
                    reason: "styled inline; add a class to edit it as a rule".into(),
                }
            } else {
                CssResolution::NeedsClass {
                    reason: "no class to anchor a rule to".into(),
                }
            };
        }
    };
    let selector = format!(".{class}{}", pseudo_suffix(sig));

    let mut hits: Vec<(&str, &str, &RuleSpan)> = Vec::new();
    for sheet in sheets {
        for rule in &sheet.rules {
            if selector_has_part(&rule.selector, &selector) && media_matches(&rule.media, bp) {
                hits.push((sheet.rel.as_str(), sheet.content.as_str(), rule));
            }
        }
    }

    match hits.len() {
        0 => CssResolution::NotFound { selector },
        1 => {
            let (rel, content, rule) = &hits[0];
            CssResolution::Resolved {
                file: (*rel).to_string(),
                selector,
                line: rule.selector_line,
                media_min_px: rule.media.as_deref().and_then(media_min_px),
                declarations: declarations_in(content, rule),
            }
        }
        _ => CssResolution::Multiple {
            selector,
            locations: hits
                .iter()
                .map(|(rel, _, rule)| Location {
                    file: (*rel).to_string(),
                    line: rule.selector_line,
                    column: 1,
                })
                .collect(),
        },
    }
}

/// Apply a declaration edit to one stylesheet's source — the testable core of
/// [`set_css_declaration`]. Errors (fail-closed) when the rule can't be pinned
/// to a single block.
fn apply_declaration_to_source(
    src: &str,
    selector: &str,
    bp: Option<u32>,
    property: &str,
    value: Option<&str>,
) -> Result<String, CommandError> {
    let matches: Vec<RuleSpan> = index_rules(src)
        .into_iter()
        .filter(|r| selector_has_part(&r.selector, selector) && media_matches(&r.media, bp))
        .collect();

    match matches.len() {
        0 => Err(CommandError::Validation {
            field: "selector".into(),
            reason: "rule no longer matches — reselect the element".into(),
        }),
        1 => Ok(set_declaration_in_block(
            src,
            matches[0].block_inner_start,
            matches[0].block_inner_end,
            property,
            value,
        )),
        _ => Err(CommandError::Validation {
            field: "selector".into(),
            reason: "class is defined by multiple rules — not editable".into(),
        }),
    }
}

// ───────────────────────── Stylesheet discovery ─────────────────────────

/// Walk the project for hand-authored `.css` files (skipping build output and
/// oversized/minified bundles), returning `(project-relative POSIX path,
/// contents)` for each.
fn discover_stylesheets(root: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    // Use the `ignore` walker — it honors .gitignore and skips hidden/VCS dirs,
    // the same walker the source indexer uses (`edit::index_occurrences`). A
    // hand-rolled denylist can't know about `.vercel`, `.turbo`, `.svelte-kit`,
    // asset dumps, etc., so it descended into huge generated trees and made every
    // cache-miss resolve crawl on large projects.
    // Prune build output / dependency dirs by name during the walk. `standard_filters`
    // only applies `.gitignore` inside an actual git repo, so a non-git project (e.g. a
    // freshly imported starter) would otherwise descend into `dist/` and `node_modules/`
    // — making every `src/` selector also match the built bundle → "defined in multiple
    // files" → read-only. This backstop keeps discovery correct without requiring git.
    // `SKIP_DIRS` covers `.next/` (Next.js build output — its compiled CSS bundle would
    // double-match every global-stylesheet selector); `out/` is Next's `next export`
    // output, pruned only here (it's too generic a name to hide from code mode).
    const DISCOVERY_EXTRA_SKIP_DIRS: &[&str] = &["out"];
    let walker = ignore::WalkBuilder::new(root)
        .standard_filters(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !crate::commands::code::SKIP_DIRS.contains(&name.as_ref())
                && !DISCOVERY_EXTRA_SKIP_DIRS.contains(&name.as_ref())
        })
        .build();
    for entry in walker.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str());
        // Standalone stylesheets, plus `.astro` components whose `<style>` blocks
        // are surfaced as virtual sheets (`Foo.astro?style=N`).
        let (is_css, is_astro) = (ext == Some("css"), ext == Some("astro"));
        if !is_css && !is_astro {
            continue;
        }
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if entry.metadata().map(|m| m.len()).unwrap_or(0) > MAX_CSS_BYTES {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        if is_css {
            out.push((rel, content));
        } else {
            // One virtual sheet per non-empty CSS `<style>` block; the index must
            // match `astro_style_blocks` order so `?style=N` round-trips on write.
            for (i, (s, e)) in astro_style_blocks(&content).into_iter().enumerate() {
                let css = &content[s..e];
                if css.trim().is_empty() {
                    continue;
                }
                out.push((format!("{rel}?style={i}"), css.to_string()));
            }
        }
    }
    out
}

/// Resolve `file` to an absolute path proven to live inside `root`. The `?style=N`
/// suffix that identifies an embedded `<style>` block is stripped first — it isn't
/// part of the on-disk path.
fn safe_join(root: &Path, file: &str) -> Result<std::path::PathBuf, CommandError> {
    let (path, _) = parse_style_ref(file);
    let abs = root.join(path);
    let canon_root = root.canonicalize().map_err(CommandError::from)?;
    let canon_file = abs.canonicalize().map_err(CommandError::from)?;
    if !canon_file.starts_with(&canon_root) {
        return Err(CommandError::Validation {
            field: "file".into(),
            reason: "edit target is outside the project".into(),
        });
    }
    Ok(abs)
}

// ───────────────────── Embedded `<style>` blocks (Astro) ─────────────────────
//
// A "file" the editor writes to is usually a standalone `.css`, but it can also be
// a `<style>` block embedded in an `.astro` component — addressed as
// `path/to/Foo.astro?style=N` (the Nth *CSS* block in that file). The CSS engine
// (index/edit/drift-guard) operates purely on a CSS string, so the only thing that
// differs is reading the right sub-range out of the host file and splicing the edit
// back into it. `EditableCss` captures that splice context.

/// Split a `file` identifier into its on-disk path and optional embedded-block index.
/// `"Foo.astro?style=2"` → `("Foo.astro", Some(2))`; a plain `.css` path → `(path, None)`.
fn parse_style_ref(file: &str) -> (&str, Option<usize>) {
    match file.split_once("?style=") {
        Some((path, idx)) => (path, idx.parse().ok()),
        None => (file, None),
    }
}

/// Byte offset just past a leading Astro frontmatter fence (`---\n … \n---`), so the
/// `<style>` scan never matches a `<style>` literal sitting inside frontmatter JS.
fn astro_frontmatter_end(src: &str) -> usize {
    let Some(rest) = src.strip_prefix("---") else {
        return 0;
    };
    match rest.find("\n---") {
        // 3 (opening fence) + offset of "\n---" + 4 ("\n---") = just past the close fence.
        Some(p) => 3 + p + 4,
        None => 0,
    }
}

/// Whether a `<style …>` open tag declares a non-CSS preprocessor (`lang="scss"`,
/// etc.) — those blocks aren't plain CSS, so the editor leaves them alone.
fn style_tag_is_non_css(open_tag: &str) -> bool {
    let t = open_tag.to_ascii_lowercase();
    ["scss", "sass", "less", "styl", "stylus", "postcss"]
        .iter()
        .any(|lang| {
            t.contains(&format!("lang=\"{lang}\""))
                || t.contains(&format!("lang='{lang}'"))
                || t.contains(&format!("lang={lang}"))
        })
}

/// The inner byte ranges (between `>` and `</style`) of every plain-CSS `<style>`
/// block in an Astro file, in document order. Non-CSS (`lang="scss"`) blocks are
/// skipped, so the Nth entry here is the Nth addressable CSS block (`?style=N`).
fn astro_style_blocks(src: &str) -> Vec<(usize, usize)> {
    let lower = src.to_ascii_lowercase(); // ASCII-lowercase preserves byte offsets
    let mut out = Vec::new();
    let mut search = astro_frontmatter_end(src);
    while let Some(rel) = lower[search..].find("<style") {
        let tag_start = search + rel;
        let after = tag_start + "<style".len();
        // Must be a real tag, not a prefix like `<styled-x>`: next char ends the name.
        let is_tag = match lower[after..].chars().next() {
            Some('>') | Some('/') => true,
            Some(c) => c.is_whitespace(),
            None => false,
        };
        if !is_tag {
            search = after;
            continue;
        }
        let Some(gt) = lower[after..].find('>') else {
            break;
        };
        let open_end = after + gt; // byte index of the open tag's '>'
        let inner_start = open_end + 1;
        let Some(close) = lower[inner_start..].find("</style") else {
            break;
        };
        let inner_end = inner_start + close;
        if !style_tag_is_non_css(&src[tag_start..=open_end]) {
            out.push((inner_start, inner_end));
        }
        search = inner_end + "</style".len();
    }
    out
}

/// A loaded editable CSS source plus how to write it back: either a whole `.css`
/// file, or a sub-range of an `.astro` host file (the rest preserved verbatim).
struct EditableCss {
    abs: std::path::PathBuf,
    /// The CSS text the engine operates on (whole file, or the block's inner text).
    css: String,
    /// Host-file bytes before / after the block (empty for a whole `.css` file).
    prefix: String,
    suffix: String,
    whole_file: bool,
}

impl EditableCss {
    /// Splice `new_css` back into the host file and write it (no-op if unchanged).
    fn write_back(&self, root: &Path, new_css: &str) -> Result<(), CommandError> {
        if new_css == self.css {
            return Ok(());
        }
        let out = if self.whole_file {
            new_css.to_string()
        } else {
            format!("{}{}{}", self.prefix, new_css, self.suffix)
        };
        std::fs::write(&self.abs, out).map_err(CommandError::from)?;
        invalidate_sheet_cache(root);
        Ok(())
    }
}

/// Load the editable CSS for a `file` identifier — a whole `.css` file, or one
/// embedded `<style>` block of an `.astro` host — with its write-back splice context.
fn load_editable_css(root: &Path, file: &str) -> Result<EditableCss, CommandError> {
    let (_, block) = parse_style_ref(file);
    let abs = safe_join(root, file)?;
    let host = std::fs::read_to_string(&abs).map_err(CommandError::from)?;
    match block {
        None => Ok(EditableCss {
            abs,
            css: host,
            prefix: String::new(),
            suffix: String::new(),
            whole_file: true,
        }),
        Some(idx) => {
            let (s, e) = astro_style_blocks(&host).get(idx).copied().ok_or_else(|| {
                CommandError::Validation {
                    field: "file".into(),
                    reason: "the <style> block no longer exists — reselect the element".into(),
                }
            })?;
            Ok(EditableCss {
                abs,
                css: host[s..e].to_string(),
                prefix: host[..s].to_string(),
                suffix: host[e..].to_string(),
                whole_file: false,
            })
        }
    }
}

// ───────────────────────── Write validation ─────────────────────────
//
// Edits are written verbatim and surgically, so a value/property/selector that
// contains block-structure characters (a typo, or a paste) would break out of
// the rule and corrupt the stylesheet. The engine is fail-closed: refuse them
// rather than write something that silently destroys the file.

/// A CSS property name is a plain identifier (`padding`, `--brand-color`).
fn property_is_safe(property: &str) -> bool {
    let p = property.trim();
    !p.is_empty()
        && p.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A value is safe when it can't terminate the declaration or close the block:
/// `{`/`}` never appear outside a quoted string, and `;` only inside quotes or
/// parentheses (e.g. a `url(data:…;…)` or `content: ";"`). Unbalanced quotes or
/// parens are rejected too — they'd swallow following source.
fn value_is_safe(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut i = 0usize;
    let mut quote = 0u8;
    let mut depth = 0i32;
    while i < bytes.len() {
        let c = bytes[i];
        if quote != 0 {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == quote {
                quote = 0;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' | b'\'' => quote = c,
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'{' | b'}' => return false,
            b';' if depth == 0 => return false,
            // A property VALUE never legitimately contains a CSS comment. Reject the
            // opener AND closer: an unterminated `/*` would comment out the rule's
            // closing brace and every rule after it in the file (silent corruption),
            // and a stray `*/` is equally a sign the value is structural, not a value.
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'*' => return false,
            b'*' if i + 1 < bytes.len() && bytes[i + 1] == b'/' => return false,
            _ => {}
        }
        i += 1;
    }
    quote == 0 && depth == 0
}

/// Reject a property/value pair that would corrupt the stylesheet. `None` value
/// is a removal — only the property is checked.
fn validate_declaration(property: &str, value: Option<&str>) -> Result<(), CommandError> {
    if !property_is_safe(property) {
        return Err(CommandError::Validation {
            field: "property".into(),
            reason: format!("\"{property}\" isn't a valid CSS property name"),
        });
    }
    if let Some(v) = value {
        if !value_is_safe(v) {
            return Err(CommandError::Validation {
                field: "value".into(),
                reason: "value contains characters that would break the stylesheet".into(),
            });
        }
    }
    Ok(())
}

/// A selector written into a new rule must not carry block braces.
fn validate_selector(selector: &str) -> Result<(), CommandError> {
    if selector.trim().is_empty() || selector.contains('{') || selector.contains('}') {
        return Err(CommandError::Validation {
            field: "selector".into(),
            reason: "invalid selector".into(),
        });
    }
    Ok(())
}

// ───────────────────────────── Commands ─────────────────────────────

/// Resolve a clicked element to the CSS rule that styles its class, at the
/// given breakpoint (`None` = base). Returns a typed status the UI branches on.
#[tauri::command]
#[tracing::instrument(skip(signature), fields(project = %project_path))]
pub fn resolve_css_rule(
    project_path: String,
    signature: CssSignature,
    breakpoint_min_px: Option<u32>,
) -> Result<CssResolution, CommandError> {
    let root = validate_project_path(&project_path)?;
    let sheets = cached_sheets(&root);
    Ok(resolve_in_sheets(&sheets, &signature, breakpoint_min_px))
}

/// Surgically set (or remove, when `value` is `None`) one declaration on the
/// rule for `selector` at the given breakpoint. Fail-closed if the rule can't
/// be pinned to a single block.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, file = %file, selector = %selector, property = %property))]
pub fn set_css_declaration(
    project_path: String,
    file: String,
    selector: String,
    breakpoint_min_px: Option<u32>,
    property: String,
    value: Option<String>,
) -> Result<(), CommandError> {
    validate_declaration(&property, value.as_deref())?;
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    let updated = apply_declaration_to_source(
        &ec.css,
        &selector,
        breakpoint_min_px,
        &property,
        value.as_deref(),
    )?;
    ec.write_back(&root, &updated)?;
    Ok(())
}

/// Append a new rule for `selector` to the authored stylesheet — optionally wrapped
/// in an at-rule condition: `breakpoint_min_px` is the `@media (min-width: …)`
/// shorthand, while `at_prelude` takes an arbitrary condition (`@media (max-width:
/// …)`, `@container …`, `@supports …`). The class-attribute attach on the element is
/// handled separately. Fail-closed if an identical *base* rule already exists; a
/// conditional rule is always distinct from the base, so the dup-check is skipped
/// when wrapping.
#[tauri::command]
#[tracing::instrument(skip(declarations), fields(project = %project_path, file = %file, selector = %selector))]
pub fn create_css_class(
    project_path: String,
    file: String,
    selector: String,
    declarations: Vec<Declaration>,
    breakpoint_min_px: Option<u32>,
    at_prelude: Option<String>,
) -> Result<(), CommandError> {
    validate_selector(&selector)?;
    for d in &declarations {
        validate_declaration(&d.property, Some(&d.value))?;
    }
    if let Some(p) = at_prelude.as_deref() {
        validate_at_prelude(p)?;
    }
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;

    let already = at_prelude.is_none()
        && index_rules(&ec.css).into_iter().any(|r| {
            selector_has_part(&r.selector, &selector) && media_matches(&r.media, breakpoint_min_px)
        });
    if already {
        return Err(CommandError::Validation {
            field: "selector".into(),
            reason: "a rule for this selector already exists".into(),
        });
    }

    let rule = build_rule_text(
        &selector,
        &declarations,
        breakpoint_min_px,
        at_prelude.as_deref(),
    );
    let mut out = ec.css.clone();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(&rule);
    out.push('\n');
    ec.write_back(&root, &out)?;
    Ok(())
}

/// List hand-authored stylesheets in the project (project-relative POSIX
/// paths), so the UI can offer an authored-sheet target for new rules.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn list_stylesheets(project_path: String) -> Result<Vec<String>, CommandError> {
    let root = validate_project_path(&project_path)?;
    Ok(cached_sheets(&root).iter().map(|s| s.rel.clone()).collect())
}

/// Every class name referenced in any rule selector (`.foo .bar:hover` → foo,
/// bar). Powers the class bar's search-and-create combobox.
fn class_names_in(selector: &str) -> Vec<String> {
    let bytes = selector.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'.' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-' || bytes[j] == b'_')
            {
                j += 1;
            }
            if j > start {
                out.push(selector[start..j].to_string());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// All class names defined across the project's stylesheets, sorted & unique.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn list_css_classes(project_path: String) -> Result<Vec<String>, CommandError> {
    let root = validate_project_path(&project_path)?;
    let mut set = std::collections::BTreeSet::new();
    for sheet in cached_sheets(&root).iter() {
        for rule in &sheet.rules {
            for c in class_names_in(&rule.selector) {
                set.insert(c);
            }
        }
    }
    Ok(set.into_iter().collect())
}

/// Every distinct rule selector across the project's stylesheets (full selector
/// text — `.card`, `article .feature-card`, `@keyframes reveal`), sorted & unique.
/// Powers the "Add selector" autocomplete so existing rules are discoverable and
/// re-surfaced (rather than duplicated or rejected) when you type one that exists.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn list_css_selectors(project_path: String) -> Result<Vec<String>, CommandError> {
    let root = validate_project_path(&project_path)?;
    let mut set = std::collections::BTreeSet::new();
    for sheet in cached_sheets(&root).iter() {
        for rule in &sheet.rules {
            let s = rule.selector.trim();
            if !s.is_empty() {
                set.insert(s.to_string());
            }
        }
    }
    Ok(set.into_iter().collect())
}

/// Collect CSS custom-property *definitions* (`--name:`) from raw stylesheet text.
/// A definition sits at the start of a declaration (after `{` or `;`), which lets us
/// skip `var(--name)` *usages* (preceded by `(`).
fn collect_custom_props(css: &str, set: &mut std::collections::BTreeSet<String>) {
    let b = css.as_bytes();
    let n = b.len();
    let mut i = 0;
    while i + 1 < n {
        if b[i] == b'-' && b[i + 1] == b'-' {
            // The preceding non-whitespace byte must mark a declaration boundary.
            let mut k = i;
            while k > 0 {
                k -= 1;
                if b[k].is_ascii_whitespace() {
                    continue;
                }
                break;
            }
            let at_decl_start = i == 0 || matches!(b[k], b'{' | b';');
            if at_decl_start {
                let start = i;
                let mut j = i + 2;
                while j < n && (b[j].is_ascii_alphanumeric() || b[j] == b'-' || b[j] == b'_') {
                    j += 1;
                }
                let mut m = j;
                while m < n && b[m].is_ascii_whitespace() {
                    m += 1;
                }
                if j > start + 2 && m < n && b[m] == b':' {
                    set.insert(css[start..j].to_string());
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
}

/// All CSS custom-property names (`--foo`) defined across the project's stylesheets,
/// sorted & unique — powers `var(--…)` value autocomplete in the editor.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn list_css_variables(project_path: String) -> Result<Vec<String>, CommandError> {
    let root = validate_project_path(&project_path)?;
    let mut set = std::collections::BTreeSet::new();
    for sheet in cached_sheets(&root).iter() {
        collect_custom_props(&sheet.content, &mut set);
    }
    Ok(set.into_iter().collect())
}

/// A custom-property *definition* with where it's set — backs the Variables editor.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CssVariableDef {
    /// Property name including the leading `--` (e.g. `--surface`).
    pub name: String,
    /// The declared value, verbatim.
    pub value: String,
    /// The selector it's defined on (`:root`, `.theme-dark`, …).
    pub selector: String,
    /// Project-relative stylesheet path it lives in.
    pub file: String,
}

/// Every custom-property definition across the project's stylesheets, in document
/// order (so the UI can keep last-wins semantics). `:root` tokens are the common,
/// editable case; ones scoped to other selectors are surfaced too (the UI groups
/// them by scope). Powers the Variables editor.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn get_css_variables(project_path: String) -> Result<Vec<CssVariableDef>, CommandError> {
    let root = validate_project_path(&project_path)?;
    let mut out = Vec::new();
    for sheet in cached_sheets(&root).iter() {
        for rule in &sheet.rules {
            for d in declarations_in(&sheet.content, rule) {
                if d.property.starts_with("--") {
                    out.push(CssVariableDef {
                        name: d.property,
                        value: d.value,
                        selector: rule.selector.clone(),
                        file: sheet.rel.clone(),
                    });
                }
            }
        }
    }
    Ok(out)
}

/// Map a batch of cascade matches (from the in-iframe walker) back to their source
/// rules, in the same order. Each entry is `resolved` (editable), `multiple`, or
/// `not_found` (read-only) — the code panel renders accordingly.
#[tauri::command]
#[tracing::instrument(skip(matched), fields(project = %project_path, rules = matched.len()))]
pub fn locate_css_rules(
    project_path: String,
    matched: Vec<MatchedRuleQuery>,
) -> Result<Vec<RuleLocation>, CommandError> {
    let root = validate_project_path(&project_path)?;
    let sheets = cached_sheets(&root);
    Ok(matched.iter().map(|q| locate_rule(&sheets, q)).collect())
}

/// Replace one rule's body with the user's edited source CSS, written verbatim and
/// surgically (formatting/comments outside the rule untouched). Drift-guarded
/// against `old_inner`; fail-closed if the rule isn't pinned to one block or the
/// new body would break out of it (`{`/`}` are rejected — a code panel edits the
/// declarations of a single rule, never its structure).
#[tauri::command]
#[tracing::instrument(
    skip(old_inner, new_inner),
    fields(project = %project_path, file = %file, selector = %selector)
)]
pub fn apply_css_rule_text(
    project_path: String,
    file: String,
    selector: String,
    media_text: Option<String>,
    old_inner: String,
    new_inner: String,
) -> Result<(), CommandError> {
    // Braces are allowed (nested CSS) as long as they're balanced — an unbalanced
    // body could break out of the rule and corrupt the file.
    if !braces_balanced(&new_inner) {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "unbalanced { } in the rule body".into(),
        });
    }
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    let updated =
        apply_rule_text_to_source(&ec.css, &selector, &media_text, &old_inner, &new_inner)?;
    ec.write_back(&root, &updated)?;
    Ok(())
}

/// Delete the whole rule for `selector`+`media_text` from its stylesheet,
/// drift-guarded against `old_inner`. Fail-closed if it isn't pinned to one rule.
#[tauri::command]
#[tracing::instrument(skip(old_inner), fields(project = %project_path, file = %file, selector = %selector))]
pub fn delete_css_rule(
    project_path: String,
    file: String,
    selector: String,
    media_text: Option<String>,
    old_inner: String,
) -> Result<(), CommandError> {
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    let updated = remove_rule_from_source(&ec.css, &selector, &media_text, &old_inner)?;
    ec.write_back(&root, &updated)?;
    Ok(())
}

/// Wrap the rule for `selector`+`media_text` in `at_prelude` (e.g. a `@media`
/// query), drift-guarded against `old_inner`.
#[tauri::command]
#[tracing::instrument(skip(old_inner), fields(project = %project_path, file = %file, selector = %selector, at = %at_prelude))]
pub fn wrap_css_rule(
    project_path: String,
    file: String,
    selector: String,
    media_text: Option<String>,
    at_prelude: String,
    old_inner: String,
) -> Result<(), CommandError> {
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    let updated = wrap_rule_in_source(&ec.css, &selector, &media_text, &at_prelude, &old_inner)?;
    ec.write_back(&root, &updated)?;
    Ok(())
}

/// Change the selector of the rule for `selector`+`media_text` to `new_selector`,
/// drift-guarded against `old_inner`.
#[tauri::command]
#[tracing::instrument(skip(old_inner), fields(project = %project_path, file = %file, selector = %selector, new = %new_selector))]
pub fn rename_css_selector(
    project_path: String,
    file: String,
    selector: String,
    media_text: Option<String>,
    old_inner: String,
    new_selector: String,
) -> Result<(), CommandError> {
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    let updated =
        rename_selector_in_source(&ec.css, &selector, &media_text, &old_inner, &new_selector)?;
    ec.write_back(&root, &updated)?;
    Ok(())
}

/// Change the `@media` condition enclosing the rule for `selector`+`media_text` to
/// `new_media`, drift-guarded against `old_inner`.
#[tauri::command]
#[tracing::instrument(skip(old_inner), fields(project = %project_path, file = %file, selector = %selector, new = %new_media))]
pub fn rename_css_at_rule(
    project_path: String,
    file: String,
    selector: String,
    media_text: Option<String>,
    old_inner: String,
    new_media: String,
) -> Result<(), CommandError> {
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    let updated =
        rename_at_rule_in_source(&ec.css, &selector, &media_text, &old_inner, &new_media)?;
    ec.write_back(&root, &updated)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_custom_props_finds_definitions_not_usages() {
        let css = ":root {\n  --accent: #fff;\n  --gap: 8px;\n}\n\
                   .btn { color: var(--accent); padding: var(--gap); --local: 1; }";
        let mut set = std::collections::BTreeSet::new();
        collect_custom_props(css, &mut set);
        let got: Vec<_> = set.into_iter().collect();
        // --accent, --gap, --local are definitions; the var(--accent)/var(--gap)
        // usages must NOT add duplicates or stray names.
        assert_eq!(got, vec!["--accent", "--gap", "--local"]);
    }

    fn sig(class: &str) -> CssSignature {
        CssSignature {
            class_name: class.to_string(),
            tag_name: "div".into(),
            target_class: None,
            has_inline_style: false,
            pseudo: None,
        }
    }

    /// Build the parsed sheet index `resolve_in_sheets` now takes.
    fn idx(list: Vec<(String, String)>) -> Vec<SheetIndex> {
        list.into_iter()
            .map(|(r, c)| SheetIndex::parse(r, c))
            .collect()
    }

    #[test]
    fn extracts_class_names_from_selectors() {
        assert_eq!(
            class_names_in(".hero .hero-title:hover"),
            vec!["hero", "hero-title"]
        );
        assert_eq!(class_names_in("section.cta > .btn"), vec!["cta", "btn"]);
        assert!(class_names_in("div > a:hover").is_empty());
    }

    #[test]
    fn pseudo_allows_functional_and_pseudo_elements() {
        let mut s = sig("x");
        s.pseudo = Some("nth-child(even)".into());
        assert_eq!(pseudo_suffix(&s), ":nth-child(even)");
        s.pseudo = Some("::before".into());
        assert_eq!(pseudo_suffix(&s), "::before");
        s.pseudo = Some(":not(.foo)".into());
        assert_eq!(pseudo_suffix(&s), ":not(.foo)");
        // Reject injection.
        s.pseudo = Some("hover{}body".into());
        assert_eq!(pseudo_suffix(&s), "");
    }

    #[test]
    fn pseudo_rejects_top_level_comma_and_space_but_allows_them_in_parens() {
        let mut s = sig("x");
        // Top-level comma/space would break out into a selector list.
        s.pseudo = Some("hover, .evil".into());
        assert_eq!(pseudo_suffix(&s), "");
        s.pseudo = Some("hover .evil".into());
        assert_eq!(pseudo_suffix(&s), "");
        // Inside a functional pseudo they're legal.
        s.pseudo = Some(":is(.a, .b)".into());
        assert_eq!(pseudo_suffix(&s), ":is(.a, .b)");
        s.pseudo = Some(":not(.x .y)".into());
        assert_eq!(pseudo_suffix(&s), ":not(.x .y)");
    }

    #[test]
    fn validates_property_and_value_against_block_break_out() {
        assert!(property_is_safe("padding"));
        assert!(property_is_safe("--brand-color"));
        assert!(!property_is_safe("color; }"));
        assert!(!property_is_safe(""));
        assert!(!property_is_safe("a:b"));

        assert!(value_is_safe("24px"));
        assert!(value_is_safe("rgba(0, 0, 0, 0.5)"));
        assert!(value_is_safe("url(data:image/svg+xml;base64,abc)")); // ; inside parens
        assert!(value_is_safe("\"a;b{c}\"")); // structural chars inside a string
        assert!(!value_is_safe("red }")); // closes the block
        assert!(!value_is_safe("red; .evil { color: blue")); // injects a rule
        assert!(!value_is_safe("\"unterminated")); // dangling quote
        assert!(!value_is_safe("rgb(0,0,0")); // unbalanced parens
                                              // Comment injection: an unterminated `/*` would comment out the rule's closing
                                              // brace and every following rule; a `*/` is equally structural. Both rejected.
        assert!(!value_is_safe("red /*")); // opens a comment that eats the rest of the file
        assert!(!value_is_safe("red /* x")); // ditto, with content
        assert!(!value_is_safe("red */")); // stray closer
        assert!(value_is_safe("\"a/*b*/c\"")); // comment chars inside a string are fine

        assert!(validate_declaration("color", Some("red }")).is_err());
        assert!(validate_declaration("color", Some("red /*")).is_err()); // comment vector blocked
        assert!(validate_declaration("color", Some("red")).is_ok());
        assert!(validate_declaration("color", None).is_ok());
        assert!(validate_selector(".hero:hover").is_ok());
        assert!(validate_selector(".hero { } .evil").is_err());
    }

    #[test]
    fn editing_a_value_preserves_existing_important() {
        let css = ".x {\n  color: red !important;\n}";
        let out = set_declaration_in_block(
            css,
            css.find('{').unwrap() + 1,
            css.rfind('}').unwrap(),
            "color",
            Some("blue"),
        );
        assert!(out.contains("color: blue !important;"), "got: {out}");
    }

    #[test]
    fn resolves_pseudo_class_rule() {
        let css = ".btn { color: red; }\n.btn:hover { color: blue; }";
        let sheets = idx(vec![("s.css".to_string(), css.to_string())]);
        let mut s = sig("btn");
        s.pseudo = Some("hover".into());
        match resolve_in_sheets(&sheets, &s, None) {
            CssResolution::Resolved {
                selector,
                declarations,
                ..
            } => {
                assert_eq!(selector, ".btn:hover");
                assert_eq!(declarations[0].value, "blue");
            }
            other => panic!("expected hover rule, got {other:?}"),
        }
        // Default state still resolves the base rule.
        match resolve_in_sheets(&sheets, &sig("btn"), None) {
            CssResolution::Resolved { selector, .. } => assert_eq!(selector, ".btn"),
            other => panic!("expected base rule, got {other:?}"),
        }
    }

    // ── Locator ──

    #[test]
    fn indexes_basic_rules() {
        let css = ".a { color: red; }\n.b { color: blue; }";
        let rules = index_rules(css);
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].selector, ".a");
        assert_eq!(rules[0].selector_line, 1);
        assert_eq!(rules[1].selector, ".b");
        assert_eq!(rules[1].selector_line, 2);
        assert!(rules[0].media.is_none());
    }

    #[test]
    fn indexes_media_nested_rules() {
        let css = ".a { color: red; }\n@media (min-width: 768px) {\n  .a { color: green; }\n}";
        let rules = index_rules(css);
        assert_eq!(rules.len(), 2);
        assert!(rules[0].media.is_none());
        assert_eq!(rules[1].media.as_deref(), Some("(min-width: 768px)"));
        assert_eq!(media_min_px(rules[1].media.as_deref().unwrap()), Some(768));
    }

    #[test]
    fn indexes_keyframes_as_one_rule_but_not_its_stops() {
        let css = "@keyframes spin { 0% { transform: rotate(0); } 100% { transform: rotate(360deg); } }\n.real { color: red; }";
        let rules = index_rules(css);
        // `@keyframes spin` is indexed as ONE editable block; its `0%`/`100%` stops are
        // NOT separate style rules. `.real` is indexed too.
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].selector, "@keyframes spin");
        assert!(rules[0].media.is_none());
        assert_eq!(rules[1].selector, ".real");
        // The whole stops body is captured verbatim inside the keyframes block.
        let inner = &css[rules[0].block_inner_start..rules[0].block_inner_end];
        assert!(inner.contains("0%"));
        assert!(inner.contains("100%"));
    }

    #[test]
    fn indexes_webkit_keyframes_too() {
        let css = "@-webkit-keyframes fade { from { opacity: 0; } to { opacity: 1; } }";
        let rules = index_rules(css);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].selector, "@-webkit-keyframes fade");
    }

    #[test]
    fn extracts_custom_properties_with_their_scope() {
        // Mirrors get_css_variables: every `--*` declaration, tagged with the selector
        // it's defined on (so the Variables editor can show :root vs scoped tokens).
        let css =
            ":root {\n  --surface: #fff;\n  --gap: 8px;\n  color: red;\n}\n.dark {\n  --surface: #000;\n}";
        let rules = index_rules(css);
        let mut vars = Vec::new();
        for r in &rules {
            for d in declarations_in(css, r) {
                if d.property.starts_with("--") {
                    vars.push((d.property, d.value, r.selector.clone()));
                }
            }
        }
        assert_eq!(
            vars,
            vec![
                (
                    "--surface".to_string(),
                    "#fff".to_string(),
                    ":root".to_string()
                ),
                ("--gap".to_string(), "8px".to_string(), ":root".to_string()),
                (
                    "--surface".to_string(),
                    "#000".to_string(),
                    ".dark".to_string()
                ),
            ]
        );
    }

    #[test]
    fn indexes_rules_after_statements_and_inside_grouping_at_rules() {
        // The first rule after a `;`-terminated statement must be indexed (it used to
        // be swallowed into the statement's prelude → read-only).
        for css in [
            "@import \"reset.css\";\n.real { color: red; }",
            "@charset \"utf-8\";\n.real { color: red; }",
            "@layer a, b, c;\n.real { color: red; }",
            "@import url(data:text/css;base64,abc);\n.real { color: red; }",
        ] {
            let rules = index_rules(css);
            assert_eq!(rules.len(), 1, "css: {css:?}");
            assert_eq!(rules[0].selector, ".real", "css: {css:?}");
            assert!(rules[0].media.is_none());
        }

        // Rules inside @layer / @supports / @container are now editable.
        for css in [
            "@layer base {\n  .real { color: red; }\n}",
            "@supports (display: grid) {\n  .real { color: red; }\n}",
            "@container (min-width: 400px) {\n  .real { gap: 1rem; }\n}",
        ] {
            let rules = index_rules(css);
            assert_eq!(rules.len(), 1, "css: {css:?}");
            assert_eq!(rules[0].selector, ".real", "css: {css:?}");
        }
    }

    #[test]
    fn still_skips_font_face_inner_blocks() {
        // `@font-face` stays opaque (Other); `@keyframes` is now indexed as one rule,
        // and `.real` is a normal style rule → 2 indexed rules, not 3.
        let css = "@keyframes spin { 0% { opacity: 0; } 100% { opacity: 1; } }\n\
                   @font-face { font-family: X; }\n.real { color: red; }";
        let rules = index_rules(css);
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].selector, "@keyframes spin");
        assert_eq!(rules[1].selector, ".real");
    }

    #[test]
    fn nested_media_inside_layer_keeps_the_media_condition() {
        let css = "@layer base {\n  @media (min-width: 768px) {\n    .real { color: red; }\n  }\n}";
        let rules = index_rules(css);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].selector, ".real");
        assert_eq!(rules[0].media.as_deref(), Some("(min-width: 768px)"));
    }

    #[test]
    fn ignores_braces_in_comments_and_strings() {
        let css = "/* .fake { } */\n.real { content: \"}{\"; color: red; }";
        let rules = index_rules(css);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].selector, ".real");
        let decls = declarations_in(css, &rules[0]);
        assert_eq!(decls.len(), 2);
        assert_eq!(decls[0].property, "content");
        assert_eq!(decls[0].value, "\"}{\"");
    }

    #[test]
    fn grouped_selector_matches_each_part() {
        let css = ".a, .b { color: red; }";
        let rules = index_rules(css);
        assert!(selector_has_part(&rules[0].selector, ".a"));
        assert!(selector_has_part(&rules[0].selector, ".b"));
        assert!(!selector_has_part(&rules[0].selector, ".c"));
    }

    #[test]
    fn comma_split_is_paren_and_bracket_aware() {
        // Top-level commas split; commas inside :is()/[attr] / strings do not.
        let parts = split_selector_group(".x:is(.a, .b), [data-k=\"a,b\"] .c");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].trim(), ".x:is(.a, .b)");
        assert_eq!(parts[1].trim(), "[data-k=\"a,b\"] .c");
    }

    #[test]
    fn functional_pseudo_class_matches_across_comma_spacing() {
        // Source `:is(.a,.b)` must locate against the browser's `:is(.a, .b)`.
        let css = ".card:is(.a,.b) { color: red; }";
        let rules = index_rules(css);
        assert!(rule_selector_matches(
            &rules[0].selector,
            ".card:is(.a, .b)"
        ));
        assert!(rule_selector_matches(&rules[0].selector, ".card:is(.a,.b)"));
        // …and the inverse: source spaced, browser tight.
        let css2 = ".card:not(.a, .b) { color: red; }";
        let rules2 = index_rules(css2);
        assert!(rule_selector_matches(
            &rules2[0].selector,
            ".card:not(.a,.b)"
        ));
    }

    #[test]
    fn grouped_selector_with_is_locates_the_whole_compound() {
        // A naive split(',') would shred `.x:is(.a, .b)` and fail to locate either.
        let css = ".x:is(.a, .b) { color: red; }\n";
        let sheets = vec![SheetIndex::parse("s.css".into(), css.to_string())];
        let q = MatchedRuleQuery {
            selector: ".x:is(.a, .b)".into(),
            media_text: None,
            href: None,
            layer: None,
            container: None,
            supports: None,
        };
        assert!(matches!(
            locate_rule(&sheets, &q),
            RuleLocation::Resolved { .. }
        ));
    }

    // ── Declarations ──

    #[test]
    fn parses_declarations_with_important_and_no_trailing_semicolon() {
        let css = ".a { color: red !important;\n  margin: 0 auto }";
        let rules = index_rules(css);
        let decls = declarations_in(css, &rules[0]);
        assert_eq!(decls.len(), 2);
        assert_eq!(decls[0].property, "color");
        assert_eq!(decls[0].value, "red");
        assert!(decls[0].important);
        assert_eq!(decls[1].property, "margin");
        assert_eq!(decls[1].value, "0 auto");
        assert!(!decls[1].important);
    }

    #[test]
    fn does_not_split_on_semicolons_inside_functions_or_strings() {
        let css = ".a { background: url(\"a;b.png\"); color: red; }";
        let rules = index_rules(css);
        let decls = declarations_in(css, &rules[0]);
        assert_eq!(decls.len(), 2);
        assert_eq!(decls[0].property, "background");
        assert_eq!(decls[0].value, "url(\"a;b.png\")");
    }

    // ── Nested rules / at-rules (brace-aware declaration scan) ──

    #[test]
    fn declarations_in_skips_a_nested_style_rule() {
        // CSS nesting: `&:hover { … }` is its own rule, not a flat declaration of `.card`.
        let css = ".card {\n  color: red;\n  font-size: 14px;\n  &:hover { color: blue; }\n}";
        let rules = index_rules(css);
        let decls = declarations_in(css, &rules[0]);
        assert_eq!(decls.len(), 2);
        assert_eq!(decls[0].property, "color");
        assert_eq!(decls[0].value, "red");
        assert_eq!(decls[1].property, "font-size");
        assert_eq!(decls[1].value, "14px");
    }

    #[test]
    fn declarations_in_resumes_after_a_nested_at_rule() {
        // A declaration *after* a nested `@media` must still be seen.
        let css =
            ".card {\n  color: red;\n  @media (min-width: 600px) {\n    color: blue;\n  }\n  margin: 0;\n}";
        let rules = index_rules(css);
        let decls = declarations_in(css, &rules[0]);
        assert_eq!(decls.len(), 2);
        assert_eq!(decls[0].property, "color");
        assert_eq!(decls[1].property, "margin");
        assert_eq!(decls[1].value, "0");
    }

    #[test]
    fn declarations_in_handles_multi_level_nesting() {
        let css = ".a {\n  color: red;\n  & .b {\n    & .c { color: blue; }\n  }\n  margin: 0;\n}";
        let rules = index_rules(css);
        let decls = declarations_in(css, &rules[0]);
        assert_eq!(decls.len(), 2);
        assert_eq!(decls[0].property, "color");
        assert_eq!(decls[1].property, "margin");
    }

    #[test]
    fn append_lands_before_a_nested_rule_not_inside_it() {
        // Regression: a brace-blind scan would insert the new declaration *inside*
        // `&:hover`, corrupting the source. It must land at the parent's top level.
        let css = ".card {\n  color: red;\n  &:hover { color: blue; }\n}";
        let rules = index_rules(css);
        let out = set_declaration_in_block(
            css,
            rules[0].block_inner_start,
            rules[0].block_inner_end,
            "margin",
            Some("0"),
        );
        assert_eq!(
            out,
            ".card {\n  color: red;\n  margin: 0;\n  &:hover { color: blue; }\n}"
        );
    }

    #[test]
    fn append_into_block_with_only_a_nested_rule_preserves_it() {
        // Regression: the "empty block" path replaced the whole body — wiping the
        // nested rule. A block with nested content must keep it and gain the decl on top.
        let css = ".card {\n  &:hover { color: blue; }\n}";
        let rules = index_rules(css);
        let out = set_declaration_in_block(
            css,
            rules[0].block_inner_start,
            rules[0].block_inner_end,
            "margin",
            Some("0"),
        );
        assert_eq!(out, ".card {\n  margin: 0;\n  &:hover { color: blue; }\n}");
    }

    #[test]
    fn update_top_level_decl_leaves_a_nested_rule_untouched() {
        // The nested `color: blue` must not be the one matched/edited.
        let css = ".card {\n  color: red;\n  &:hover { color: blue; }\n}";
        let rules = index_rules(css);
        let out = set_declaration_in_block(
            css,
            rules[0].block_inner_start,
            rules[0].block_inner_end,
            "color",
            Some("green"),
        );
        assert_eq!(
            out,
            ".card {\n  color: green;\n  &:hover { color: blue; }\n}"
        );
    }

    // ── Surgical writes ──

    #[test]
    fn updates_existing_declaration_in_place() {
        let css = ".hero {\n  padding: 8px;\n  color: red;\n}";
        let rules = index_rules(css);
        let out = set_declaration_in_block(
            css,
            rules[0].block_inner_start,
            rules[0].block_inner_end,
            "padding",
            Some("24px"),
        );
        assert_eq!(out, ".hero {\n  padding: 24px;\n  color: red;\n}");
    }

    #[test]
    fn property_match_is_case_insensitive() {
        let css = ".hero {\n  Padding: 8px;\n}";
        let rules = index_rules(css);
        let out = set_declaration_in_block(
            css,
            rules[0].block_inner_start,
            rules[0].block_inner_end,
            "padding",
            Some("24px"),
        );
        assert_eq!(out, ".hero {\n  Padding: 24px;\n}");
    }

    #[test]
    fn appends_new_declaration_matching_indentation() {
        let css = ".hero {\n  padding: 8px;\n}";
        let rules = index_rules(css);
        let out = set_declaration_in_block(
            css,
            rules[0].block_inner_start,
            rules[0].block_inner_end,
            "margin",
            Some("0 auto"),
        );
        assert_eq!(out, ".hero {\n  padding: 8px;\n  margin: 0 auto;\n}");
    }

    #[test]
    fn appends_into_empty_block() {
        let css = ".hero {}";
        let rules = index_rules(css);
        let out = set_declaration_in_block(
            css,
            rules[0].block_inner_start,
            rules[0].block_inner_end,
            "color",
            Some("red"),
        );
        assert_eq!(out, ".hero {\n  color: red;\n}");
    }

    #[test]
    fn appends_after_unterminated_last_declaration() {
        let css = ".hero {\n  padding: 8px\n}";
        let rules = index_rules(css);
        let out = set_declaration_in_block(
            css,
            rules[0].block_inner_start,
            rules[0].block_inner_end,
            "color",
            Some("red"),
        );
        assert_eq!(out, ".hero {\n  padding: 8px;\n  color: red;\n}");
    }

    #[test]
    fn removes_a_middle_declaration_cleanly() {
        let css = ".hero {\n  padding: 8px;\n  color: red;\n  margin: 0;\n}";
        let rules = index_rules(css);
        let out = set_declaration_in_block(
            css,
            rules[0].block_inner_start,
            rules[0].block_inner_end,
            "color",
            None,
        );
        assert_eq!(out, ".hero {\n  padding: 8px;\n  margin: 0;\n}");
    }

    #[test]
    fn removing_absent_declaration_is_noop() {
        let css = ".hero {\n  padding: 8px;\n}";
        let rules = index_rules(css);
        let out = set_declaration_in_block(
            css,
            rules[0].block_inner_start,
            rules[0].block_inner_end,
            "color",
            None,
        );
        assert_eq!(out, css);
    }

    // ── Resolution ──

    #[test]
    fn resolves_single_rule() {
        let sheets = idx(vec![(
            "styles.css".to_string(),
            ".hero { color: red; }".to_string(),
        )]);
        let res = resolve_in_sheets(&sheets, &sig("hero"), None);
        match res {
            CssResolution::Resolved {
                file,
                selector,
                declarations,
                ..
            } => {
                assert_eq!(file, "styles.css");
                assert_eq!(selector, ".hero");
                assert_eq!(declarations.len(), 1);
                assert_eq!(declarations[0].property, "color");
            }
            other => panic!("expected resolved, got {other:?}"),
        }
    }

    #[test]
    fn resolves_last_class_token_by_default() {
        let sheets = idx(vec![(
            "s.css".to_string(),
            ".card { color: red; }\n.card-title { font-weight: 700; }".to_string(),
        )]);
        let res = resolve_in_sheets(&sheets, &sig("card card-title"), None);
        match res {
            CssResolution::Resolved { selector, .. } => assert_eq!(selector, ".card-title"),
            other => panic!("expected resolved, got {other:?}"),
        }
    }

    #[test]
    fn duplicate_rules_resolve_to_multiple() {
        let sheets = idx(vec![
            ("a.css".to_string(), ".hero { color: red; }".to_string()),
            ("b.css".to_string(), ".hero { color: blue; }".to_string()),
        ]);
        let res = resolve_in_sheets(&sheets, &sig("hero"), None);
        match res {
            CssResolution::Multiple { locations, .. } => assert_eq!(locations.len(), 2),
            other => panic!("expected multiple, got {other:?}"),
        }
    }

    #[test]
    fn missing_rule_resolves_to_not_found() {
        let sheets = idx(vec![(
            "s.css".to_string(),
            ".other { color: red; }".to_string(),
        )]);
        let res = resolve_in_sheets(&sheets, &sig("hero"), None);
        assert_eq!(
            res,
            CssResolution::NotFound {
                selector: ".hero".into()
            }
        );
    }

    #[test]
    fn no_class_resolves_to_needs_class_or_inline() {
        let sheets: Vec<SheetIndex> = vec![];
        assert!(matches!(
            resolve_in_sheets(&sheets, &sig(""), None),
            CssResolution::NeedsClass { .. }
        ));
        let mut s = sig("");
        s.has_inline_style = true;
        assert!(matches!(
            resolve_in_sheets(&sheets, &s, None),
            CssResolution::Inline { .. }
        ));
    }

    #[test]
    fn breakpoint_resolves_into_matching_media_block() {
        let css =
            ".hero { color: red; }\n@media (min-width: 768px) {\n  .hero { color: green; }\n}";
        let sheets = idx(vec![("s.css".to_string(), css.to_string())]);

        let base = resolve_in_sheets(&sheets, &sig("hero"), None);
        match base {
            CssResolution::Resolved { declarations, .. } => {
                assert_eq!(declarations[0].value, "red")
            }
            other => panic!("expected base resolved, got {other:?}"),
        }
        let md = resolve_in_sheets(&sheets, &sig("hero"), Some(768));
        match md {
            CssResolution::Resolved {
                declarations,
                media_min_px,
                ..
            } => {
                assert_eq!(declarations[0].value, "green");
                assert_eq!(media_min_px, Some(768));
            }
            other => panic!("expected media resolved, got {other:?}"),
        }
    }

    // ── apply_declaration_to_source ──

    #[test]
    fn apply_to_source_updates_correct_media_layer() {
        let css =
            ".hero {\n  color: red;\n}\n@media (min-width: 768px) {\n  .hero {\n    color: green;\n  }\n}";
        let out = apply_declaration_to_source(css, ".hero", Some(768), "color", Some("blue"))
            .expect("edit applies");
        assert!(out.contains("color: red;")); // base untouched
        assert!(out.contains("color: blue;")); // media updated
        assert!(!out.contains("color: green;"));
    }

    #[test]
    fn apply_to_source_fails_closed_on_missing_rule() {
        let css = ".other { color: red; }";
        let err = apply_declaration_to_source(css, ".hero", None, "color", Some("blue"));
        assert!(matches!(err, Err(CommandError::Validation { .. })));
    }

    #[test]
    fn apply_to_source_fails_closed_on_ambiguous_rule() {
        let css = ".hero { color: red; }\n.hero { color: blue; }";
        let err = apply_declaration_to_source(css, ".hero", None, "color", Some("green"));
        assert!(matches!(err, Err(CommandError::Validation { .. })));
    }

    // ── build_rule_text ──

    #[test]
    fn builds_base_rule_text() {
        let decls = vec![
            Declaration {
                property: "color".into(),
                value: "red".into(),
                important: false,
            },
            Declaration {
                property: "padding".into(),
                value: "24px".into(),
                important: true,
            },
        ];
        let out = build_rule_text(".hero", &decls, None, None);
        assert_eq!(
            out,
            ".hero {\n  color: red;\n  padding: 24px !important;\n}"
        );
    }

    #[test]
    fn builds_media_wrapped_rule_text() {
        let decls = vec![Declaration {
            property: "color".into(),
            value: "red".into(),
            important: false,
        }];
        let out = build_rule_text(".hero", &decls, Some(768), None);
        assert_eq!(
            out,
            "@media (min-width: 768px) {\n  .hero {\n    color: red;\n  }\n}"
        );
    }

    #[test]
    fn builds_rule_wrapped_in_an_arbitrary_condition() {
        let decls = vec![Declaration {
            property: "padding".into(),
            value: "0".into(),
            important: false,
        }];
        let out = build_rule_text(".card", &decls, None, Some("@media (max-width: 768px)"));
        assert_eq!(
            out,
            "@media (max-width: 768px) {\n  .card {\n    padding: 0;\n  }\n}"
        );
    }

    // ───────────── Code-first cascade editor: locate + rule-text write ─────────────

    fn query(selector: &str, media_text: Option<&str>, href: Option<&str>) -> MatchedRuleQuery {
        MatchedRuleQuery {
            selector: selector.into(),
            media_text: media_text.map(|s| s.into()),
            href: href.map(|s| s.into()),
            layer: None,
            container: None,
            supports: None,
        }
    }

    #[test]
    fn locates_a_single_rule_with_verbatim_body() {
        let sheets = idx(vec![(
            "styles.css".into(),
            ".btn {\n  padding: 10px;\n  color: red;\n}\n".into(),
        )]);
        match locate_rule(&sheets, &query(".btn", None, None)) {
            RuleLocation::Resolved {
                file,
                line,
                inner_text,
            } => {
                assert_eq!(file, "styles.css");
                assert_eq!(line, 1);
                assert_eq!(inner_text, "\n  padding: 10px;\n  color: red;\n");
            }
            other => panic!("expected resolved, got {other:?}"),
        }
    }

    #[test]
    fn matches_selector_ignoring_combinator_whitespace() {
        // Authored `.a>.b`; browser reports `.a > .b` — they must resolve to each other.
        let sheets = idx(vec![("s.css".into(), ".a>.b {\n  gap: 1rem;\n}\n".into())]);
        assert!(matches!(
            locate_rule(&sheets, &query(".a > .b", None, None)),
            RuleLocation::Resolved { .. }
        ));
    }

    #[test]
    fn locates_media_scoped_rule_by_full_condition_not_just_min_width() {
        // Base + a MAX-width variant (the case that collided under min-width matching).
        let sheets = idx(vec![(
            "s.css".into(),
            ".x {\n  color: red;\n}\n@media (max-width: 768px) {\n  .x {\n    color: blue;\n  }\n}\n"
                .into(),
        )]);
        // Base query (no media) resolves to the base rule, NOT the media one.
        assert!(matches!(
            locate_rule(&sheets, &query(".x", None, None)),
            RuleLocation::Resolved { line, .. } if line == 1
        ));
        // The max-width variant resolves to its OWN rule (line 5), whitespace-insensitive.
        assert!(matches!(
            locate_rule(&sheets, &query(".x", Some("(max-width:768px)"), None)),
            RuleLocation::Resolved { line, .. } if line == 5
        ));
    }

    #[test]
    fn reports_not_found_for_unmapped_match() {
        let sheets = idx(vec![("s.css".into(), ".a { color: red; }".into())]);
        assert_eq!(
            locate_rule(&sheets, &query(".ghost", None, None)),
            RuleLocation::NotFound
        );
    }

    #[test]
    fn duplicate_selector_is_multiple_unless_href_disambiguates() {
        let sheets = idx(vec![
            ("a.css".into(), ".dup { color: red; }".into()),
            ("nested/b.css".into(), ".dup { color: blue; }".into()),
        ]);
        // Ambiguous without a hint.
        assert!(matches!(
            locate_rule(&sheets, &query(".dup", None, None)),
            RuleLocation::Multiple { .. }
        ));
        // The served href's basename pins exactly one file.
        match locate_rule(
            &sheets,
            &query(".dup", None, Some("http://localhost:5173/nested/b.css?v=9")),
        ) {
            RuleLocation::Resolved { file, .. } => assert_eq!(file, "nested/b.css"),
            other => panic!("expected resolved via href, got {other:?}"),
        }
    }

    #[test]
    fn writes_edited_rule_body_verbatim_when_drift_guard_holds() {
        let src = ".btn {\n  padding: 10px;\n}\n.other { color: red; }\n";
        let old_inner = "\n  padding: 10px;\n";
        let new_inner = "\n  padding: 2rem;\n  gap: 1rem;\n";
        let out = apply_rule_text_to_source(src, ".btn", &None, old_inner, new_inner).unwrap();
        assert_eq!(
            out,
            ".btn {\n  padding: 2rem;\n  gap: 1rem;\n}\n.other { color: red; }\n"
        );
    }

    #[test]
    fn edits_a_rule_inside_container_query() {
        let src = "@container (min-width: 400px) {\n  .card {\n    gap: 1rem;\n  }\n}\n";
        let out = apply_rule_text_to_source(
            src,
            ".card",
            &None,
            "\n    gap: 1rem;\n  ",
            "\n    gap: 2rem;\n  ",
        )
        .unwrap();
        assert_eq!(
            out,
            "@container (min-width: 400px) {\n  .card {\n    gap: 2rem;\n  }\n}\n"
        );
    }

    #[test]
    fn renames_to_a_complex_selector_and_stays_locatable() {
        let src = ".old {\n  color: red;\n}\n";
        let out =
            rename_selector_in_source(src, ".old", &None, "\n  color: red;\n", "h1.title:not(.x)")
                .unwrap();
        assert_eq!(out, "h1.title:not(.x) {\n  color: red;\n}\n");
        let rules = index_rules(&out);
        assert_eq!(rules[0].selector, "h1.title:not(.x)");
    }

    #[test]
    fn renames_the_media_condition_of_a_wrapped_rule() {
        let src = "@media (max-width: 768px) {\n  .a { color: red; }\n}\n";
        let out = rename_at_rule_in_source(
            src,
            ".a",
            &Some("(max-width: 768px)".into()),
            " color: red; ",
            "(max-width: 600px)",
        )
        .unwrap();
        assert_eq!(
            out,
            "@media (max-width: 600px) {\n  .a { color: red; }\n}\n"
        );
    }

    #[test]
    fn wraps_a_rule_and_it_stays_indexable_under_the_condition() {
        let src = ".hero {\n  font-size: 3rem;\n}\n";
        let out = wrap_rule_in_source(
            src,
            ".hero",
            &None,
            "@media (max-width: 600px)",
            "\n  font-size: 3rem;\n",
        )
        .unwrap();
        assert!(braces_balanced(&out));
        let rules = index_rules(&out);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].selector, ".hero");
        assert_eq!(rules[0].media.as_deref(), Some("(max-width: 600px)"));
    }

    #[test]
    fn edits_the_first_rule_after_a_charset_statement() {
        let src = "@charset \"utf-8\";\n.real {\n  color: red;\n}\n";
        let out = apply_rule_text_to_source(
            src,
            ".real",
            &None,
            "\n  color: red;\n",
            "\n  color: blue;\n",
        )
        .unwrap();
        assert_eq!(out, "@charset \"utf-8\";\n.real {\n  color: blue;\n}\n");
    }

    #[test]
    fn deletes_a_rule_inside_a_layer() {
        let src = "@layer base {\n  .a { color: red; }\n  .b { color: blue; }\n}\n";
        let out = remove_rule_from_source(src, ".a", &None, " color: red; ").unwrap();
        // .a is gone, .b remains, the layer stays intact.
        assert!(!out.contains(".a {"));
        assert!(out.contains(".b { color: blue; }"));
        assert!(out.contains("@layer base {"));
        // And the file is still valid (balanced) and re-indexable.
        assert!(braces_balanced(&out));
        assert_eq!(index_rules(&out).len(), 1);
    }

    #[test]
    fn writes_nested_css_into_a_rule_body() {
        // A rule with nested children: index_rules still finds the OUTER rule's full
        // span (its nested blocks are balanced), so a nested edit round-trips.
        let src = ".card {\n  color: red;\n}\n";
        let nested = "\n  color: red;\n  &:hover { color: blue; }\n";
        let out =
            apply_rule_text_to_source(src, ".card", &None, "\n  color: red;\n", nested).unwrap();
        assert_eq!(
            out,
            ".card {\n  color: red;\n  &:hover { color: blue; }\n}\n"
        );
        // The outer rule is still locatable after the nested write.
        assert!(matches!(
            locate_rule(
                &idx(vec![("s.css".into(), out)]),
                &query(".card", None, None)
            ),
            RuleLocation::Resolved { .. }
        ));
    }

    #[test]
    fn writes_keyframe_steps_into_a_keyframes_body() {
        // An empty `@keyframes reveal {}` (as `create_css_class` writes it) gets its
        // step blocks filled in — the keyframes rule is located by its full prelude
        // and the steps round-trip as opaque body text.
        let src = "@keyframes reveal {\n}\n";
        let steps = "\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n";
        let out = apply_rule_text_to_source(src, "@keyframes reveal", &None, "\n", steps).unwrap();
        assert_eq!(
            out,
            "@keyframes reveal {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}\n"
        );
        // Still ONE indexed rule (the keyframes block); its steps aren't separate rules.
        let reindexed = index_rules(&out);
        assert_eq!(reindexed.len(), 1);
        assert_eq!(reindexed[0].selector, "@keyframes reveal");
    }

    #[test]
    fn balanced_braces_are_allowed_unbalanced_are_not() {
        assert!(braces_balanced(
            "\n  color: red;\n  &:hover { color: blue; }\n"
        ));
        assert!(braces_balanced("\n  content: '{';\n")); // brace in a string is fine
        assert!(braces_balanced("\n  /* } */ color: red;\n")); // brace in a comment is fine
        assert!(!braces_balanced("\n  color: red;\n}\n.evil { x: y;\n")); // breaks out
        assert!(!braces_balanced("\n  & { color: red;\n")); // unclosed
                                                            // An UNTERMINATED comment is rejected — otherwise it would swallow this body's
                                                            // closing brace and the rest of the file as comment text.
        assert!(!braces_balanced("\n  color: red; /* dangling\n"));
        assert!(!braces_balanced("\n  color: red; /*")); // bare opener at EOF
        assert!(braces_balanced("\n  color: red; /* fine */\n")); // terminated is allowed
    }

    #[test]
    fn rule_text_write_refuses_a_comment_that_would_eat_the_file() {
        // `apply_css_rule_text` gates every body on `braces_balanced` before writing.
        // A body ending in an unterminated comment would comment out the rule's own
        // closing brace and every following rule — the guard must reject it.
        let eats_the_file = "\n  color: red; /* oops\n";
        assert!(!braces_balanced(eats_the_file));
        // The benign version (terminated) still writes.
        assert!(braces_balanced("\n  color: red; /* fine */\n"));
    }

    #[test]
    fn rule_text_write_is_fail_closed_on_drift() {
        let src = ".btn {\n  padding: 10px;\n}\n";
        // `old_inner` no longer matches the file → reject rather than clobber.
        let err =
            apply_rule_text_to_source(src, ".btn", &None, "\n  padding: 99px;\n", "\n  x: y;\n")
                .unwrap_err();
        assert!(matches!(err, CommandError::Validation { field, .. } if field == "css"));
    }

    #[test]
    fn deletes_a_whole_rule_with_its_line_and_trailing_newline() {
        let src = ".a { color: red; }\n.btn {\n  padding: 10px;\n}\n.c { x: y; }\n";
        let out = remove_rule_from_source(src, ".btn", &None, "\n  padding: 10px;\n").unwrap();
        assert_eq!(out, ".a { color: red; }\n.c { x: y; }\n");
    }

    #[test]
    fn deletes_a_media_scoped_rule_not_the_base() {
        let src = ".x { color: red; }\n@media (max-width: 768px) {\n  .x { color: blue; }\n}\n";
        // Delete only the media variant; the base rule stays.
        let out = remove_rule_from_source(
            src,
            ".x",
            &Some("(max-width: 768px)".into()),
            " color: blue; ",
        )
        .unwrap();
        assert!(out.contains(".x { color: red; }"));
        assert!(!out.contains("color: blue"));
    }

    #[test]
    fn wraps_a_rule_in_a_media_query_and_stays_locatable() {
        let src = ".btn {\n  padding: 10px;\n}\n";
        let out = wrap_rule_in_source(
            src,
            ".btn",
            &None,
            "@media (max-width: 768px)",
            "\n  padding: 10px;\n",
        )
        .unwrap();
        assert_eq!(
            out,
            "@media (max-width: 768px) {\n  .btn {\n    padding: 10px;\n  }\n}\n"
        );
        // The wrapped rule is still resolvable under its new media condition.
        assert!(matches!(
            locate_rule(
                &idx(vec![("s.css".into(), out)]),
                &query(".btn", Some("(max-width: 768px)"), None)
            ),
            RuleLocation::Resolved { .. }
        ));
    }

    #[test]
    fn renames_a_rule_selector_to_a_complex_one() {
        let src = ".btn {\n  padding: 10px;\n}\n";
        let out = rename_selector_in_source(
            src,
            ".btn",
            &None,
            "\n  padding: 10px;\n",
            ".card > .btn:hover",
        )
        .unwrap();
        assert_eq!(out, ".card > .btn:hover {\n  padding: 10px;\n}\n");
    }

    #[test]
    fn rename_rejects_a_selector_with_braces() {
        let src = ".btn { x: y; }";
        assert!(rename_selector_in_source(src, ".btn", &None, " x: y; ", ".a { }").is_err());
    }

    #[test]
    fn renames_an_at_rule_condition_in_place() {
        let src = "@media (max-width: 768px) {\n  .x { color: red; }\n}\n";
        let out = rename_at_rule_in_source(
            src,
            ".x",
            &Some("(max-width: 768px)".into()),
            " color: red; ",
            "(min-width: 1024px)",
        )
        .unwrap();
        assert_eq!(
            out,
            "@media (min-width: 1024px) {\n  .x { color: red; }\n}\n"
        );
    }

    #[test]
    fn rename_at_rule_fails_for_a_base_rule() {
        let src = ".x { color: red; }";
        assert!(
            rename_at_rule_in_source(src, ".x", &None, " color: red; ", "(max-width: 768px)")
                .is_err()
        );
    }

    #[test]
    fn wrap_rejects_a_non_at_prelude() {
        let src = ".btn {\n  padding: 10px;\n}\n";
        assert!(
            wrap_rule_in_source(src, ".btn", &None, ".not-an-at", "\n  padding: 10px;\n").is_err()
        );
    }

    #[test]
    fn delete_is_fail_closed_on_drift_or_ambiguity() {
        let src = ".btn {\n  padding: 10px;\n}\n";
        assert!(remove_rule_from_source(src, ".btn", &None, "\n  WRONG;\n").is_err());
        // Two same-selector rules with DIFFERENT bodies are disambiguated by old_inner
        // (so a base rule + its @container/@supports override can each be deleted).
        let dup = ".a { color: red; }\n.a { color: blue; }";
        let out = remove_rule_from_source(dup, ".a", &None, " color: red; ").unwrap();
        assert_eq!(out, ".a { color: blue; }"); // the red one removed, blue kept
                                                // But two with the SAME body are genuinely ambiguous → refused.
        let same = ".a { color: red; }\n.a { color: red; }";
        assert!(remove_rule_from_source(same, ".a", &None, " color: red; ").is_err());
    }

    #[test]
    fn rule_text_write_rejects_a_missing_or_ambiguous_rule() {
        let one = ".a { color: red; }";
        assert!(apply_rule_text_to_source(one, ".missing", &None, "", " color: blue; ").is_err());
        // Different bodies → old_inner pins the right one (base vs @container/@supports).
        let dup = ".a { color: red; }\n.a { color: blue; }";
        let out = apply_rule_text_to_source(dup, ".a", &None, " color: red; ", " color: green; ")
            .unwrap();
        assert_eq!(out, ".a { color: green; }\n.a { color: blue; }");
        // Identical bodies → genuinely ambiguous → refused.
        let same = ".a { color: red; }\n.a { color: red; }";
        assert!(
            apply_rule_text_to_source(same, ".a", &None, " color: red; ", " color: green; ")
                .is_err()
        );
    }

    // ───────────── Embedded `<style>` blocks (Astro) ─────────────

    #[test]
    fn parse_style_ref_splits_path_and_block_index() {
        assert_eq!(parse_style_ref("src/styles.css"), ("src/styles.css", None));
        assert_eq!(
            parse_style_ref("src/Foo.astro?style=0"),
            ("src/Foo.astro", Some(0))
        );
        assert_eq!(
            parse_style_ref("a/b/Foo.astro?style=3"),
            ("a/b/Foo.astro", Some(3))
        );
    }

    #[test]
    fn rel_basename_drops_dir_and_style_query() {
        assert_eq!(
            rel_basename("src/components/Foo.astro?style=0"),
            "Foo.astro"
        );
        assert_eq!(rel_basename("styles/main.css"), "main.css");
    }

    #[test]
    fn href_basename_matches_vite_dev_id_of_an_astro_block() {
        // The Vite dev-id we now pass as `href` for injected <style> tags.
        let dev_id =
            "/@fs/Users/me/app/src/components/Hero.astro?astro&type=style&index=0&lang.css";
        assert_eq!(href_basename(dev_id).as_deref(), Some("Hero.astro"));
    }

    #[test]
    fn astro_style_blocks_finds_inner_ranges() {
        let src = "---\nconst x = 1;\n---\n<h1>hi</h1>\n<style>\n.a { color: red; }\n</style>\n";
        let blocks = astro_style_blocks(src);
        assert_eq!(blocks.len(), 1);
        let (s, e) = blocks[0];
        assert_eq!(&src[s..e], "\n.a { color: red; }\n");
    }

    #[test]
    fn astro_style_blocks_handles_multiple_and_attributes() {
        let src = "<style>.a{}</style>\n<style is:global>.b{}</style>";
        let blocks = astro_style_blocks(src);
        assert_eq!(blocks.len(), 2);
        assert_eq!(&src[blocks[0].0..blocks[0].1], ".a{}");
        assert_eq!(&src[blocks[1].0..blocks[1].1], ".b{}");
    }

    #[test]
    fn astro_style_blocks_skips_non_css_lang() {
        let src = "<style lang=\"scss\">.a{ .b{} }</style>\n<style>.c{}</style>";
        let blocks = astro_style_blocks(src);
        // Only the plain-CSS block is addressable; the scss one is skipped, so the
        // plain block is index 0 (matching `discover_stylesheets`' enumerate order).
        assert_eq!(blocks.len(), 1);
        assert_eq!(&src[blocks[0].0..blocks[0].1], ".c{}");
    }

    #[test]
    fn astro_style_blocks_ignores_style_inside_frontmatter() {
        let src = "---\nconst s = \"<style>fake</style>\";\n---\n<style>.real{}</style>";
        let blocks = astro_style_blocks(src);
        assert_eq!(blocks.len(), 1);
        assert_eq!(&src[blocks[0].0..blocks[0].1], ".real{}");
    }

    #[test]
    fn discover_surfaces_astro_blocks_as_virtual_sheets() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        std::fs::write(root.join("a.css"), ".g { color: red; }").unwrap();
        std::fs::write(
            root.join("Card.astro"),
            "---\n---\n<div class=\"card\"></div>\n<style>\n.card { padding: 4px; }\n</style>\n",
        )
        .unwrap();
        let sheets = discover_stylesheets(root);
        let rels: std::collections::BTreeSet<_> = sheets.iter().map(|(r, _)| r.as_str()).collect();
        assert!(rels.contains("a.css"));
        assert!(rels.contains("Card.astro?style=0"));
    }

    #[test]
    fn edit_round_trips_into_an_astro_style_block() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        let before = "---\nconst x = 1;\n---\n<div class=\"card\"></div>\n\
                      <style>\n.card {\n  padding: 4px;\n}\n</style>\n<p>after</p>\n";
        std::fs::write(root.join("Card.astro"), before).unwrap();

        // The block's inner text is what the editor seeds `old_inner` from.
        let ec = load_editable_css(root, "Card.astro?style=0").unwrap();
        assert!(ec.css.contains(".card"));
        assert!(!ec.whole_file);
        let old_inner = "\n  padding: 4px;\n";
        let updated =
            apply_rule_text_to_source(&ec.css, ".card", &None, old_inner, "\n  padding: 8px;\n")
                .unwrap();
        ec.write_back(root, &updated).unwrap();

        let after = std::fs::read_to_string(root.join("Card.astro")).unwrap();
        // The frontmatter, markup, and trailing `<p>` are untouched; only the rule changed.
        assert!(after.contains("const x = 1;"));
        assert!(after.contains("<p>after</p>"));
        assert!(after.contains("padding: 8px;"));
        assert!(!after.contains("padding: 4px;"));
    }

    #[test]
    fn discovery_prunes_build_output_and_dependencies() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        std::fs::write(root.join("app.css"), "* { margin: 0; }").unwrap();
        // A built bundle (no .git/.gitignore present) must NOT be discovered, or every
        // src selector would also match the bundle copy → "multiple files" → read-only.
        std::fs::create_dir_all(root.join("dist/_astro")).unwrap();
        std::fs::write(root.join("dist/_astro/index.abc.css"), "* { margin: 0; }").unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/reset.css"), "* { margin: 0; }").unwrap();

        let rels: Vec<_> = discover_stylesheets(root)
            .into_iter()
            .map(|(r, _)| r)
            .collect();
        assert_eq!(rels, vec!["app.css".to_string()]);
    }

    #[test]
    fn discovery_prunes_nextjs_build_output_so_source_rules_resolve_uniquely() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        // A Next.js layout: the hand-authored global stylesheet…
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("app/globals.css"), ".title {\n  color: red;\n}\n").unwrap();
        // …and the SAME selector in the compiled `.next/` bundle and `next export`'s
        // `out/`. If either were discovered, locate would see the selector in two
        // files → Multiple → the rule turns read-only in the editor.
        std::fs::create_dir_all(root.join(".next/static/css")).unwrap();
        std::fs::write(root.join(".next/static/css/x.css"), ".title{color:red}\n").unwrap();
        std::fs::create_dir_all(root.join("out/_next/static/css")).unwrap();
        std::fs::write(
            root.join("out/_next/static/css/x.css"),
            ".title{color:red}\n",
        )
        .unwrap();

        let discovered = discover_stylesheets(root);
        let rels: Vec<_> = discovered.iter().map(|(r, _)| r.clone()).collect();
        assert_eq!(rels, vec!["app/globals.css".to_string()]);

        // End to end: the rule still resolves to the single source file, not Multiple.
        let sheets = idx(discovered);
        match locate_rule(&sheets, &query(".title", None, None)) {
            RuleLocation::Resolved { file, .. } => assert_eq!(file, "app/globals.css"),
            other => panic!("expected unique resolution to the source rule, got {other:?}"),
        }
    }

    #[test]
    fn write_back_to_a_missing_block_is_rejected() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        std::fs::write(root.join("Card.astro"), "<div></div>\n").unwrap();
        // No <style> block → index 0 doesn't exist.
        assert!(load_editable_css(root, "Card.astro?style=0").is_err());
    }

    // ───────────── Conditional rules: full lifecycle stress test ─────────────
    //
    // Mirrors the "Add selector → @media (…)" flow end to end on the pure core: build
    // the wrapped rule, index it, locate it (distinct from any base rule), then edit it
    // with the located body as the drift baseline. Run across the whole condition space
    // the UI offers so an indexing gap (e.g. `@media print`) can't slip through.

    /// The verbatim inner body of the first rule matching `selector`+`media` in `css`.
    fn inner_of<'a>(css: &'a str, selector: &str, media: &Option<String>) -> Option<&'a str> {
        index_rules(css)
            .into_iter()
            .find(|r| {
                rule_selector_matches(&r.selector, selector) && media_text_matches(&r.media, media)
            })
            .map(|r| &css[r.block_inner_start..r.block_inner_end])
    }

    const CONDITIONS: &[&str] = &[
        "@media (max-width: 768px)",
        "@media (min-width: 1024px)",
        "@media (min-width: 1440px)",
        "@media (prefers-color-scheme: dark)",
        "@media (prefers-reduced-motion: reduce)",
        "@media (hover: hover)",
        "@media (orientation: landscape)",
        "@media print",
    ];

    #[test]
    fn every_condition_indexes_locates_and_round_trip_edits() {
        for cond in CONDITIONS {
            // 1. Create (what `create_css_class` writes for an empty conditional rule).
            let css = build_rule_text(".card", &[], None, Some(cond));

            // 2. Index: exactly one `.card` rule, carrying the condition as media context.
            let rules = index_rules(&css);
            let card: Vec<_> = rules
                .iter()
                .filter(|r| rule_selector_matches(&r.selector, ".card"))
                .collect();
            assert_eq!(
                card.len(),
                1,
                "[{cond}] expected one .card rule, got {}",
                card.len()
            );
            let media = card[0].media.clone();
            assert!(
                media.is_some(),
                "[{cond}] should set a media context (none → unlocatable)"
            );

            // 3. The empty body the UI pins must equal what create wrote (drift baseline
            //    matches → first edit never trips the guard). This is the re-locate path.
            let inner = inner_of(&css, ".card", &media).expect("[cond] locate empty rule");

            // 4. Edit: add a declaration, drift-guarded against that exact inner.
            let edited =
                apply_rule_text_to_source(&css, ".card", &media, inner, "\n    color: red;\n  ")
                    .unwrap_or_else(|e| panic!("[{cond}] first edit failed: {e:?}"));
            assert!(edited.contains("color: red;"), "[{cond}] edit didn't land");
            assert!(
                edited.contains(cond),
                "[{cond}] condition must survive the edit"
            );
            assert!(
                braces_balanced(&edited),
                "[{cond}] edit left unbalanced braces"
            );
        }
    }

    #[test]
    fn base_and_conditional_for_same_selector_locate_distinctly() {
        // A base rule and a conditional rule for the SAME selector must each resolve to
        // their own rule — never collide into "multiple" (the bug that made new @media
        // rules uneditable / vanish).
        let css = ".card {\n  color: blue;\n}\n@media (max-width: 768px) {\n  .card {\n    color: red;\n  }\n}\n";
        let sheets = idx(vec![("s.css".into(), css.to_string())]);

        match locate_rule(&sheets, &query(".card", None, None)) {
            RuleLocation::Resolved { inner_text, .. } => assert!(inner_text.contains("blue")),
            o => panic!("base .card should resolve, got {o:?}"),
        }
        match locate_rule(&sheets, &query(".card", Some("(max-width: 768px)"), None)) {
            RuleLocation::Resolved { inner_text, .. } => assert!(inner_text.contains("red")),
            o => panic!("conditional .card should resolve, got {o:?}"),
        }
    }

    #[test]
    fn creating_a_conditional_rule_in_an_astro_block_round_trips() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        let before =
            "---\n---\n<h1 class=\"hero\">x</h1>\n<style>\n.hero {\n  color: blue;\n}\n</style>\n";
        std::fs::write(root.join("Hero.astro"), before).unwrap();

        // Append a conditional rule the way create_css_class does (into the block).
        let ec = load_editable_css(root, "Hero.astro?style=0").unwrap();
        let rule = build_rule_text(".hero", &[], None, Some("@media (max-width: 768px)"));
        ec.write_back(root, &format!("{}\n\n{rule}\n", ec.css))
            .unwrap();

        let after = std::fs::read_to_string(root.join("Hero.astro")).unwrap();
        assert!(after.contains("@media (max-width: 768px)"));
        assert!(after.contains(".hero {\n  color: blue;")); // base untouched
        assert!(after.contains("<h1 class=\"hero\">")); // markup untouched
                                                        // The new conditional rule is locatable inside the block.
        let block = load_editable_css(root, "Hero.astro?style=0").unwrap();
        assert!(inner_of(&block.css, ".hero", &Some("(max-width: 768px)".into())).is_some());
    }

    #[test]
    fn deleting_a_conditional_rule_leaves_the_base_intact() {
        let css = ".card {\n  color: blue;\n}\n\n@media (max-width: 768px) {\n  .card {\n    color: red;\n  }\n}\n";
        let inner = inner_of(&css, ".card", &Some("(max-width: 768px)".into()))
            .unwrap()
            .to_string();
        let out =
            remove_rule_from_source(&css, ".card", &Some("(max-width: 768px)".into()), &inner)
                .expect("delete conditional");
        assert!(out.contains(".card {\n  color: blue;"), "base must remain");
        assert!(
            !out.contains("max-width: 768px"),
            "conditional must be gone"
        );
        assert!(braces_balanced(&out));
    }

    #[test]
    fn scope_rule_bodies_are_indexed_and_editable() {
        // @scope used to be Frame::Other → everything inside read-only, and the @scope
        // wrap-menu action bricked the rule. Now its inner rules are indexed + editable.
        let css = "@scope (.card) to (.content) {\n  a {\n    color: blue;\n  }\n  :scope {\n    padding: 1rem;\n  }\n}\n";
        let rules = index_rules(css);
        assert!(
            rules.iter().any(|r| r.selector == "a"),
            "inner `a` should be indexed"
        );
        assert!(
            rules.iter().any(|r| r.selector == ":scope"),
            "`:scope` should be indexed"
        );
        let inner = inner_of(css, "a", &None).expect("locate `a` inside @scope");
        let out =
            apply_rule_text_to_source(css, "a", &None, inner, "\n    color: red;\n  ").unwrap();
        assert!(out.contains("color: red;"));
        assert!(
            out.contains("@scope (.card) to (.content)"),
            "scope wrapper intact"
        );
        assert!(braces_balanced(&out));
    }

    #[test]
    fn container_and_supports_conditions_disambiguate_same_selector() {
        // The canonical container-query / progressive-enhancement idioms: a base rule plus
        // an override inside @container / @supports for the SAME selector, same file. These
        // used to collide into Multiple → read-only; the context tie-break resolves each.
        let css = ".card {\n  padding: 12px;\n}\n\
                   @container sidebar (min-width: 400px) {\n  .card {\n    padding: 24px;\n  }\n}\n\
                   @supports (display: grid) {\n  .card {\n    display: grid;\n  }\n}\n";
        let rules = index_rules(css);
        let card: Vec<_> = rules
            .iter()
            .filter(|r| rule_selector_matches(&r.selector, ".card"))
            .collect();
        assert_eq!(card.len(), 3);
        assert!(card
            .iter()
            .any(|r| r.container.as_deref() == Some("sidebar (min-width: 400px)")));
        assert!(card
            .iter()
            .any(|r| r.supports.as_deref() == Some("(display: grid)")));

        let sheets = idx(vec![("s.css".into(), css.to_string())]);
        let q = |container: Option<&str>, supports: Option<&str>| MatchedRuleQuery {
            selector: ".card".into(),
            media_text: None,
            href: None,
            layer: None,
            container: container.map(|s| s.into()),
            supports: supports.map(|s| s.into()),
        };
        // base
        match locate_rule(&sheets, &q(None, None)) {
            RuleLocation::Resolved { inner_text, .. } => assert!(inner_text.contains("12px")),
            o => panic!("base .card should resolve, got {o:?}"),
        }
        // container
        match locate_rule(&sheets, &q(Some("sidebar (min-width: 400px)"), None)) {
            RuleLocation::Resolved { inner_text, .. } => assert!(inner_text.contains("24px")),
            o => panic!("@container .card should resolve, got {o:?}"),
        }
        // supports
        match locate_rule(&sheets, &q(None, Some("(display: grid)"))) {
            RuleLocation::Resolved { inner_text, .. } => assert!(inner_text.contains("grid")),
            o => panic!("@supports .card should resolve, got {o:?}"),
        }
    }

    #[test]
    fn same_selector_in_two_layers_indexes_the_layer_and_locates_by_it() {
        let css = "@layer base {\n  .btn {\n    color: blue;\n  }\n}\n@layer theme {\n  .btn {\n    color: red;\n  }\n}\n";
        // Both .btn rules carry their layer name.
        let rules = index_rules(css);
        let layers: Vec<_> = rules
            .iter()
            .filter(|r| rule_selector_matches(&r.selector, ".btn"))
            .map(|r| r.layer.clone())
            .collect();
        assert_eq!(
            layers,
            vec![Some("base".to_string()), Some("theme".to_string())]
        );

        // Locating with the layer tie-break resolves each distinctly (not Multiple).
        let sheets = idx(vec![("s.css".into(), css.to_string())]);
        let q_base = MatchedRuleQuery {
            selector: ".btn".into(),
            media_text: None,
            href: None,
            layer: Some("base".into()),
            container: None,
            supports: None,
        };
        match locate_rule(&sheets, &q_base) {
            RuleLocation::Resolved { inner_text, .. } => assert!(inner_text.contains("blue")),
            o => panic!("layer base .btn should resolve, got {o:?}"),
        }
        let q_theme = MatchedRuleQuery {
            selector: ".btn".into(),
            media_text: None,
            href: None,
            layer: Some("theme".into()),
            container: None,
            supports: None,
        };
        match locate_rule(&sheets, &q_theme) {
            RuleLocation::Resolved { inner_text, .. } => assert!(inner_text.contains("red")),
            o => panic!("layer theme .btn should resolve, got {o:?}"),
        }
    }

    #[test]
    fn deleting_one_of_several_rules_keeps_the_shared_media_wrapper() {
        // Two rules share one `@media`; deleting one must NOT take the wrapper (the
        // other rule still needs it). Guards against over-eager wrapper removal.
        let css = "@media (max-width: 768px) {\n  .a {\n    color: red;\n  }\n  .b {\n    color: blue;\n  }\n}\n";
        let inner = inner_of(&css, ".a", &Some("(max-width: 768px)".into()))
            .unwrap()
            .to_string();
        let out = remove_rule_from_source(&css, ".a", &Some("(max-width: 768px)".into()), &inner)
            .unwrap();
        assert!(!out.contains(".a"), ".a should be gone");
        assert!(out.contains(".b"), ".b must remain");
        assert!(
            out.contains("max-width: 768px"),
            "wrapper must remain for .b"
        );
        assert!(braces_balanced(&out));
    }

    #[test]
    fn repeated_create_then_edit_never_corrupts_the_sheet() {
        // Stack several conditional rules for different selectors, editing each — the
        // sheet must stay valid CSS throughout (no drift/offset corruption).
        let mut css = String::new();
        for (i, cond) in CONDITIONS.iter().enumerate() {
            let sel = format!(".s{i}");
            let rule = build_rule_text(&sel, &[], None, Some(cond));
            css = if css.is_empty() {
                rule
            } else {
                format!("{css}\n\n{rule}")
            };
        }
        // Edit every rule once.
        for (i, cond) in CONDITIONS.iter().enumerate() {
            let sel = format!(".s{i}");
            let media = cond.strip_prefix("@media").map(|s| s.trim().to_string());
            let inner = inner_of(&css, &sel, &media).expect("locate").to_string();
            css = apply_rule_text_to_source(&css, &sel, &media, &inner, "\n    gap: 1px;\n  ")
                .unwrap_or_else(|e| panic!("[{sel} {cond}] edit failed: {e:?}"));
        }
        assert!(braces_balanced(&css));
        // All edits present, all conditions intact.
        for (i, cond) in CONDITIONS.iter().enumerate() {
            assert!(css.contains(&format!(".s{i}")), "lost selector .s{i}");
            assert!(css.contains(cond), "lost condition {cond}");
        }
        assert_eq!(css.matches("gap: 1px;").count(), CONDITIONS.len());
    }
}
