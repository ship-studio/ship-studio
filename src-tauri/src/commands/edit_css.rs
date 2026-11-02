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

use super::css_rule_mutations::{
    self, CssConsolidationCandidate, CssConsolidationReview, CssRuleSourceIdentity,
};
use crate::commands::edit::Location;
use crate::errors::CommandError;
use crate::utils::validate_project_path;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
    selectors: HashMap<String, Vec<usize>>,
}

impl SheetIndex {
    fn parse(rel: String, content: String) -> Self {
        let rules = index_rules(&content);
        // Normalize once per snapshot, not every rule for every clicked element.
        let mut selectors: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, rule) in rules.iter().enumerate() {
            for part in normalized_selector_parts(&rule.selector) {
                let entries = selectors.entry(part).or_default();
                // A repeated member in a selector group still names just one rule.
                if entries.last() != Some(&index) {
                    entries.push(index);
                }
            }
        }
        Self {
            rel,
            content,
            rules,
            selectors,
        }
    }
}

#[allow(clippy::type_complexity)]
static SHEET_CACHE: LazyLock<Mutex<HashMap<PathBuf, (Instant, Arc<Vec<SheetIndex>>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Serializes CSS snapshot validation and write-back across this CSS mutation command path.
/// External editors do not participate in this lock, so the filesystem still cannot
/// provide a universal compare-and-write guarantee here.
static EDITABLE_CSS_WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

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
        // Sweep expired roots before inserting. Entries were only ever read
        // past their TTL, never removed, so every project visited in a session
        // kept its whole parsed stylesheet set alive for the life of the
        // process — data that stopped being usable ten seconds after it was
        // written. Opportunistic on write, the same pattern the hosting status
        // cache uses.
        let now = Instant::now();
        cache.retain(|_, (at, _)| now.duration_since(*at) < SHEET_CACHE_TTL);
        cache.insert(root.to_path_buf(), (now, sheets.clone()));
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
    /// The served stylesheet URL (`rule.parentStyleSheet.href`) or Vite's
    /// `data-vite-dev-id`. Full local paths and embedded Astro style indexes are
    /// used as identity; remote and unsupported URL schemes remain read-only.
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
    /// The exact CSSOM selector-list member matched by this element.
    #[serde(default)]
    pub selector_member_index: Option<usize>,
    /// Full enclosing at-rule path; `Some([])` proves a top-level rule.
    #[serde(default)]
    pub context_path: Option<Vec<String>>,
    /// CSSOM-serialized declarations from this exact CSSRule.
    #[serde(default)]
    pub identity_declarations: Option<Vec<Declaration>>,
    /// Browser-only CSSOM path and fingerprint used by exact preview targeting.
    #[serde(default)]
    pub runtime_identity: Option<CssRulePreviewIdentity>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CssRulePreviewIdentity {
    pub stylesheet_index: usize,
    pub rule_path: Vec<usize>,
    pub href: Option<String>,
    #[serde(default)]
    pub root_href: Option<String>,
    pub selector_list: String,
    pub selector_member_index: usize,
    pub declarations: Vec<Declaration>,
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
        /// Present only when the backend verified this rule against an authored module
        /// and the exact generated stylesheet that serves it.
        #[serde(skip_serializing_if = "Option::is_none")]
        generated_css_output: Option<String>,
        /// Exact authored occurrence identity, required by all source mutations.
        #[serde(skip_serializing_if = "Option::is_none")]
        source_identity: Option<CssRuleSourceIdentity>,
    },
    /// The selector resolves to more than one source rule — read-only (we never
    /// guess which one the browser painted). `files` is the distinct set of
    /// source references; `candidates` retains each matching rule for navigation.
    Multiple {
        files: Vec<String>,
        rule_count: usize,
        candidates: Vec<RuleSourceCandidate>,
    },
    /// No unique safe project source maps to this match (for example UA, inline,
    /// or a generated rule without an exact authored-module counterpart) — read-only.
    NotFound,
}

/// One possible source rule for an ambiguous cascade match. Its line is the
/// physical host-file line where that rule starts, when the file is still readable.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RuleSourceCandidate {
    pub file: String,
    pub line: Option<usize>,
}

/// One located style rule and the byte span of its declaration block.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct RuleSpan {
    /// Full selector prelude, trimmed (may be a comma group).
    pub(super) selector: String,
    /// `@media` prelude (e.g. `(min-width: 768px)`) if nested, else `None`.
    pub(super) media: Option<String>,
    /// Byte range of the enclosing `@media` condition text (for editing the at-rule),
    /// if the rule is inside one.
    pub(super) media_prelude: Option<(usize, usize)>,
    /// The name of the enclosing `@layer` (innermost), if any. Distinguishes the same
    /// selector declared in different cascade layers so locate doesn't collide them.
    pub(super) layer: Option<String>,
    /// The enclosing `@container` condition (innermost), if any — same disambiguation role.
    pub(super) container: Option<String>,
    /// The enclosing `@supports` condition (innermost), if any — same disambiguation role.
    pub(super) supports: Option<String>,
    /// Complete enclosing grouping-rule chain, including contexts without a control.
    pub(super) context_path: Vec<String>,
    /// Byte offset of the first significant byte of the selector (for delete/wrap,
    /// which need the rule's start, not just its block).
    pub(super) selector_start: usize,
    /// Byte offset just inside the opening `{`.
    pub(super) block_inner_start: usize,
    /// Byte offset of the closing `}`.
    pub(super) block_inner_end: usize,
    /// 1-based line of the selector.
    pub(super) selector_line: usize,
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

/// Leading whitespace of the line containing `pos`.
pub(super) fn indent_of_line(src: &str, pos: usize) -> String {
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
pub(super) fn css_selector_escape_end(sel: &str, index: usize, end: usize) -> usize {
    let bytes = sel.as_bytes();
    let mut next = (index + 1).min(end);
    if next >= end {
        return end;
    }
    if bytes[next].is_ascii_hexdigit() {
        let mut digits = 0;
        while next < end && digits < 6 && bytes[next].is_ascii_hexdigit() {
            next += 1;
            digits += 1;
        }
        if next < end && bytes[next].is_ascii_whitespace() {
            if bytes[next] == b'\r' && bytes.get(next + 1) == Some(&b'\n') {
                next += 2;
            } else {
                next += 1;
            }
        }
        return next;
    }
    if bytes[next] == b'\r' && bytes.get(next + 1) == Some(&b'\n') {
        return (next + 2).min(end);
    }
    let first = bytes[next];
    let width = if first < 0x80 {
        1
    } else if first < 0xE0 {
        2
    } else if first < 0xF0 {
        3
    } else {
        4
    };
    (next + width).min(end)
}

/// Split a grouped selector on top-level commas while keeping escaped identifiers,
/// functional pseudos, attribute strings, and CSS comments intact.
pub(super) fn split_selector_group(sel: &str) -> Vec<&str> {
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
                i = css_selector_escape_end(sel, i, bytes.len());
                continue;
            }
            if c == quote {
                quote = 0;
            }
            i += 1;
            continue;
        }
        if c == b'\\' {
            i = css_selector_escape_end(sel, i, bytes.len());
            continue;
        }
        if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            if let Some(end) = sel[i + 2..].find("*/") {
                i += end + 4;
                continue;
            }
            break;
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

/// Validate selector-list structure before the exact source prelude is replaced.
/// CSS grammar support still comes from the project's browser/parser; this check keeps
/// malformed delimiters and block/statement injection out of the source mutation path.
pub(super) fn validate_selector_list(selector: &str) -> Result<(), CommandError> {
    let invalid = || CommandError::Validation {
        field: "selector".into(),
        reason:
            "enter a valid CSS selector or selector list without braces, semicolons, or comments"
                .into(),
    };
    if selector.trim().is_empty() {
        return Err(invalid());
    }
    let bytes = selector.as_bytes();
    let mut stack = Vec::new();
    let mut quote = 0u8;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if quote != 0 {
            if byte == b'\\' {
                index = css_selector_escape_end(selector, index, bytes.len());
                continue;
            }
            if byte == quote {
                quote = 0;
            }
            index += 1;
            continue;
        }
        if byte == b'\\' {
            let escaped = css_selector_escape_end(selector, index, bytes.len());
            if escaped == index + 1 {
                return Err(invalid());
            }
            index = escaped;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            return Err(invalid());
        }
        match byte {
            b'"' | b'\'' => quote = byte,
            b'(' => stack.push(b')'),
            b'[' => stack.push(b']'),
            b')' | b']' if stack.pop() != Some(byte) => return Err(invalid()),
            b'{' | b'}' | b';' => return Err(invalid()),
            _ => {}
        }
        index += 1;
    }
    if quote != 0
        || !stack.is_empty()
        || split_selector_group(selector)
            .iter()
            .any(|member| member.trim().is_empty())
    {
        return Err(invalid());
    }
    Ok(())
}

/// Unwrap Astro's `:global(...)` authoring syntax for comparisons with the
/// compiled selector text exposed by CSSOM. The returned flag is true only when all
/// wrappers were balanced; malformed input is kept verbatim and cannot accidentally
/// become a match. This is comparison-only — edits still target the original source
/// selector and its declaration-block span.
fn unwrap_astro_global(s: &str) -> (String, bool) {
    let mut out = String::with_capacity(s.len());
    let mut parens: Vec<bool> = Vec::new();
    let mut quote = None;
    let mut bracket_depth = 0usize;
    let mut saw_global = false;
    let mut i = 0usize;

    while i < s.len() {
        if quote.is_none()
            && bracket_depth == 0
            && s[i..]
                .get(..8)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(":global("))
        {
            parens.push(true);
            saw_global = true;
            i += 8;
            continue;
        }

        // CSS comments can contain selector-looking text; preserve them without
        // treating a `:global(` inside a comment as authoring syntax.
        if quote.is_none() && s[i..].starts_with("/*") {
            if let Some(end) = s[i + 2..].find("*/") {
                let end = i + 2 + end + 2;
                out.push_str(&s[i..end]);
                i = end;
                continue;
            }
            out.push_str(&s[i..]);
            break;
        }

        let ch = s[i..].chars().next().expect("i is a character boundary");
        let next = i + ch.len_utf8();

        if ch == '\\' {
            out.push(ch);
            i = next;
            if i < s.len() {
                let escaped = s[i..].chars().next().expect("i is a character boundary");
                out.push(escaped);
                i += escaped.len_utf8();
            }
            continue;
        }

        if let Some(delimiter) = quote {
            out.push(ch);
            if ch == delimiter {
                quote = None;
            }
            i = next;
            continue;
        }

        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                out.push(ch);
            }
            '[' => {
                bracket_depth += 1;
                out.push(ch);
            }
            ']' => {
                bracket_depth = bracket_depth.saturating_sub(1);
                out.push(ch);
            }
            '(' => {
                parens.push(false);
                out.push(ch);
            }
            ')' => match parens.pop() {
                Some(true) => {}
                Some(false) | None => out.push(ch),
            },
            _ => out.push(ch),
        }
        i = next;
    }

    if parens.iter().any(|is_global| *is_global) {
        (s.to_string(), false)
    } else {
        (out, saw_global)
    }
}

/// Normalize selectors for cross-source comparison: collapse whitespace, drop spaces
/// around combinators, canonicalize functional-pseudo comma spacing, and unwrap Astro
/// `:global(...)` wrappers because CSSOM reports the compiled selector without them.
/// Comparison-only — the original source prelude is never rewritten by this normalizer.
pub(super) fn norm_selector(s: &str) -> String {
    let (unwrapped, _) = unwrap_astro_global(s);
    let collapsed = unwrapped.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .replace(" > ", ">")
        .replace(" + ", "+")
        .replace(" ~ ", "~")
        .replace(", ", ",")
        .replace(" ,", ",")
}

/// Split source selectors after unwrapping Astro globals. This also exposes commas
/// that were inside a `:global(...)` wrapper as top-level selector-list separators.
pub(super) fn normalized_selector_parts(selector: &str) -> Vec<String> {
    let (unwrapped, _) = unwrap_astro_global(selector);
    split_selector_group(&unwrapped)
        .into_iter()
        .map(norm_selector)
        .collect()
}

/// Does a source selector list contain `target` as one normalized member?
fn selector_has_part(selector: &str, target: &str) -> bool {
    let target = norm_selector(target);
    normalized_selector_parts(selector)
        .iter()
        .any(|part| part == &target)
}

/// Like [`selector_has_part`] but documented for the browser's compound-selector
/// query. Both sides are normalized through the same Astro and whitespace rules.
fn rule_selector_matches(rule_selector: &str, target: &str) -> bool {
    let target = norm_selector(target);
    normalized_selector_parts(rule_selector)
        .iter()
        .any(|part| part == &target)
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

/// Find the closing parenthesis for one media-query group, respecting quoted strings
/// and comments. Nested groups are returned as a whole so only simple feature groups
/// are eligible for legacy width-range canonicalization.
fn media_group_end(condition: &str, start: usize) -> Option<usize> {
    let bytes = condition.as_bytes();
    let mut depth = 0usize;
    let mut quote = 0u8;
    let mut index = start;

    while index < bytes.len() {
        let byte = bytes[index];
        if quote != 0 {
            if byte == b'\\' {
                index += 2;
                continue;
            }
            if byte == quote {
                quote = 0;
            }
            index += 1;
            continue;
        }

        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            if index + 1 >= bytes.len() {
                return None;
            }
            index += 2;
            continue;
        }

        match byte {
            b'\'' | b'"' => quote = byte,
            b'(' => depth += 1,
            b')' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }

    None
}

/// A small CSS dimension grammar for the exact feature forms handled below.
/// Functions, percentages, and unitless values stay untouched and therefore fail
/// closed if CSSOM serializes them differently.
fn is_simple_css_dimension(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0usize;
    if matches!(bytes.first().copied(), Some(b'+') | Some(b'-')) {
        index += 1;
    }

    let mut has_integer_digits = false;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        has_integer_digits = true;
        index += 1;
    }

    let mut has_fraction_digits = false;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            has_fraction_digits = true;
            index += 1;
        }
    }
    if !has_integer_digits && !has_fraction_digits {
        return false;
    }

    if matches!(bytes.get(index).copied(), Some(b'e') | Some(b'E')) {
        index += 1;
        if matches!(bytes.get(index).copied(), Some(b'+') | Some(b'-')) {
            index += 1;
        }
        let exponent_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == exponent_start {
            return false;
        }
    }

    index < bytes.len() && bytes[index..].iter().all(u8::is_ascii_alphabetic)
}

/// Convert only legacy width features whose CSS meaning is exactly an inclusive
/// range: `max-width: Nunit` ↔ `width <= Nunit`, and the corresponding lower bound.
/// Media types, logical operators, strict comparisons, values, and units are preserved.
fn canonical_width_feature(group: &str) -> Option<String> {
    let (value, operator) = if let Some(value) = group.strip_prefix("max-width:") {
        (value, "<=")
    } else if let Some(value) = group.strip_prefix("min-width:") {
        (value, ">=")
    } else {
        return None;
    };

    is_simple_css_dimension(value).then(|| format!("width{operator}{value}"))
}

/// Normalize media-query text for CSSOM/source comparison. Besides whitespace and
/// ASCII case, canonicalize only simple inclusive legacy width features. This is
/// comparison-only: source writes continue to use the authored prelude verbatim.
fn norm_media_cond(condition: &str) -> String {
    let compact = norm_cond(condition);
    let mut normalized = String::with_capacity(compact.len());
    let bytes = compact.as_bytes();
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'(' {
            if let Some(end) = media_group_end(&compact, index) {
                let group = &compact[index + 1..end];
                if let Some(range) = canonical_width_feature(group) {
                    normalized.push('(');
                    normalized.push_str(&range);
                    normalized.push(')');
                } else {
                    normalized.push_str(&compact[index..=end]);
                }
                index = end + 1;
                continue;
            }
        }

        let character = compact[index..]
            .chars()
            .next()
            .expect("index is a character boundary");
        normalized.push(character);
        index += character.len_utf8();
    }

    normalized
}

fn media_text_matches(rule_media: &Option<String>, query: &Option<String>) -> bool {
    let rule = rule_media
        .as_deref()
        .map(norm_media_cond)
        .unwrap_or_default();
    let query = query.as_deref().map(norm_media_cond).unwrap_or_default();
    rule == query
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

/// A source identity carried by a stylesheet URL or Vite style element id.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CssSourceIdentity {
    /// Project-relative POSIX path without the embedded-style query.
    path: String,
    /// Astro/Vite style index or Ship Studio's `?style=N` index, when present.
    style_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CssSourceHint {
    /// No path identity was supplied, so selector-only matching may run.
    Unavailable,
    /// The identity maps to an indexed source path and can restrict candidates.
    Project(CssSourceIdentity),
    /// A generated public bundle maps to its authored modules; rule bodies must also match.
    Generated {
        output_path: String,
        source_paths: Vec<String>,
    },
    /// A path-shaped identity was present but could not map to an indexed source.
    /// Do not fall back to an unrelated selector hit.
    Unmapped,
}

/// Percent-decode a URL path without interpreting `+` as a space.
fn percent_decode_path(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1)?;
            let low = *bytes.get(index + 2)?;
            let digit = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            decoded.push(digit(high)? * 16 + digit(low)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// Normalize a relative source path while rejecting attempts to walk above the project.
fn normalize_project_rel_path(path: &str) -> Option<String> {
    let mut parts = Vec::new();
    let normalized = path.replace('\\', "/");
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ if parts.is_empty() && part.ends_with(':') => return None,
            _ => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn absolute_project_rel_path(root: &Path, path: &str) -> Option<String> {
    let path = path
        .strip_prefix('/')
        .filter(|path| is_windows_absolute_path(path))
        .unwrap_or(path);
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let candidate = Path::new(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path));
    let relative = candidate.strip_prefix(&root).ok()?;
    normalize_project_rel_path(&relative.to_string_lossy())
}

fn sheet_matches_source_identity(rel: &str, identity: &CssSourceIdentity) -> bool {
    let (path, style_index) = parse_style_ref(rel);
    path == identity.path
        && identity
            .style_index
            .map_or(true, |expected| style_index == Some(expected))
}

fn is_generated_public_site(root: &Path, output_path: &str) -> bool {
    const OUTPUT_PATH: &str = "public/styles/site.css";
    const GENERATED_HEADER: &str =
        "/* Generated by scripts/build-styles.mjs. Edit the source modules instead. */";

    if output_path != OUTPUT_PATH {
        return false;
    }
    safe_join(root, OUTPUT_PATH)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .is_some_and(|content| content.starts_with(GENERATED_HEADER))
}

fn generated_public_site_sources(
    root: &Path,
    sheets: &[SheetIndex],
    output_path: &str,
) -> Option<Vec<String>> {
    const OUTPUT_PATH: &str = "public/styles/site.css";
    const GENERATED_HEADER: &str =
        "/* Generated by scripts/build-styles.mjs. Edit the source modules instead. */";
    const LEGACY_SOURCE_MANIFEST: &str = "const sourceFiles = [";
    const CURRENT_SOURCE_MANIFEST: &str = "export const SOURCE_FILES = Object.freeze([";
    const LEGACY_REQUIRED_SCRIPT_FRAGMENTS: &[&str] = &[
        "const stylesDirectory = new URL('../public/styles/', import.meta.url);",
        "const stylesheet = [",
        "  '/* Generated by scripts/build-styles.mjs. Edit the source modules instead. */',",
        "  ...sourceFiles.map((file) => readFileSync(new URL(file, stylesDirectory), 'utf8').trim()),",
        "].join('\\n\\n') + '\\n';",
        "writeFileSync(new URL('site.css', stylesDirectory), stylesheet);",
    ];
    const CURRENT_REQUIRED_SCRIPT_FRAGMENTS: &[&str] = &[
        "export const STYLES_DIRECTORY = fileURLToPath(new URL('../public/styles/', import.meta.url));",
        "export function buildStyles(stylesDirectory = STYLES_DIRECTORY) {",
        "const stylesheet = [",
        "'/* Generated by scripts/build-styles.mjs. Edit the source modules instead. */',",
        "...SOURCE_FILES.map((file) => readFileSync(resolve(stylesDirectory, file), 'utf8').trim()),",
        "].join('\\n\\n') + '\\n';",
        "writeFileSync(resolve(stylesDirectory, 'site.css'), stylesheet);",
    ];

    if output_path != OUTPUT_PATH {
        return None;
    }
    let script_path = safe_join(root, "scripts/build-styles.mjs").ok()?;
    let script = std::fs::read_to_string(script_path).ok()?;
    // Recognize the original self-running script and the current exported builder shape.
    // Any other generator stays unmapped until its output contract is verified here.
    let (manifest_start, manifest_end, required_fragments) = match (
        script.matches(LEGACY_SOURCE_MANIFEST).count(),
        script.matches(CURRENT_SOURCE_MANIFEST).count(),
    ) {
        (1, 0) => (
            LEGACY_SOURCE_MANIFEST,
            "];",
            LEGACY_REQUIRED_SCRIPT_FRAGMENTS,
        ),
        (0, 1) => (
            CURRENT_SOURCE_MANIFEST,
            "]);",
            CURRENT_REQUIRED_SCRIPT_FRAGMENTS,
        ),
        _ => return None,
    };
    if required_fragments
        .iter()
        .any(|fragment| !script.contains(fragment))
    {
        return None;
    }

    let source_list = script.split_once(manifest_start)?.1;
    let (entries, _) = source_list.split_once(manifest_end)?;
    let mut source_paths = Vec::new();
    let mut seen = HashSet::new();
    for line in entries
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let name = line.strip_prefix('\'')?.strip_suffix("',")?;
        if !name.ends_with(".css")
            || name == "site.css"
            || name.contains("..")
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            || !seen.insert(name.to_string())
        {
            return None;
        }
        source_paths.push(format!("public/styles/{name}"));
    }
    if source_paths.is_empty() {
        return None;
    }

    let output_sheet = sheets.iter().find(|sheet| sheet.rel == OUTPUT_PATH)?;
    let output_file = safe_join(root, OUTPUT_PATH).ok()?;
    let output_content = std::fs::read_to_string(output_file).ok()?;
    if output_content != output_sheet.content || !output_content.starts_with(GENERATED_HEADER) {
        return None;
    }

    for source_path in &source_paths {
        let source_sheet = sheets.iter().find(|sheet| sheet.rel == *source_path)?;
        let source_file = safe_join(root, source_path).ok()?;
        let source_content = std::fs::read_to_string(source_file).ok()?;
        if source_content != source_sheet.content {
            return None;
        }
    }
    Some(source_paths)
}

fn source_hint_for_identity(
    root: Option<&Path>,
    sheets: &[SheetIndex],
    identity: CssSourceIdentity,
) -> CssSourceHint {
    if identity.style_index.is_none() {
        if let Some(root) = root {
            if is_generated_public_site(root, &identity.path) {
                if let Some(source_paths) =
                    generated_public_site_sources(root, sheets, &identity.path)
                {
                    return CssSourceHint::Generated {
                        output_path: identity.path,
                        source_paths,
                    };
                }
                return CssSourceHint::Unmapped;
            }
        }
    }
    CssSourceHint::Project(identity)
}

/// Extract the exact project path and embedded style index from a browser or Vite source id.
/// Query cache keys such as `?t=...` are ignored; Astro's `index=N` maps to the same original
/// style-block index used in the virtual sheet id.
fn css_source_hint(root: Option<&Path>, sheets: &[SheetIndex], href: &str) -> CssSourceHint {
    let href = href.trim();
    if href.is_empty() {
        return CssSourceHint::Unavailable;
    }
    let no_fragment = href.split('#').next().unwrap_or(href);

    let (raw_path, query, served_url, file_url, vite_fs_path, trusted_origin) = if let Some(rest) =
        no_fragment
            .strip_prefix("http://")
            .or_else(|| no_fragment.strip_prefix("https://"))
    {
        let path_start = rest.find('/').unwrap_or(rest.len());
        let host = &rest[..path_start];
        let path_query = if path_start == rest.len() {
            "/"
        } else {
            &rest[path_start..]
        };
        let (path, query) = path_query.split_once('?').unwrap_or((path_query, ""));
        (
            path,
            query,
            true,
            false,
            path.starts_with("/@fs/"),
            is_local_dev_host(host),
        )
    } else if let Some(rest) = no_fragment.strip_prefix("file://") {
        let local_path = match rest.strip_prefix("localhost") {
            Some("") => "",
            Some(path) if path.starts_with('/') || path.starts_with('?') => path,
            _ => rest,
        };
        let (path, query) = local_path.split_once('?').unwrap_or((local_path, ""));
        (path, query, false, true, false, false)
    } else if no_fragment.contains("://")
        || no_fragment.starts_with("data:")
        || no_fragment.starts_with("blob:")
    {
        // An explicit non-project scheme is evidence that this stylesheet did not
        // come from one of the indexed project paths. Never let its basename select
        // an unrelated local rule.
        return CssSourceHint::Unmapped;
    } else {
        let (path, query) = no_fragment.split_once('?').unwrap_or((no_fragment, ""));
        (path, query, false, false, path.starts_with("/@fs/"), false)
    };

    if served_url && !trusted_origin {
        return CssSourceHint::Unmapped;
    }

    let style_index = match css_style_index(query) {
        Ok(index) => index,
        Err(()) => return CssSourceHint::Unmapped,
    };
    let Some(decoded_path) = percent_decode_path(raw_path) else {
        return CssSourceHint::Unmapped;
    };

    let path = if vite_fs_path {
        let Some(root) = root else {
            return CssSourceHint::Unmapped;
        };
        let fs_path = decoded_path.strip_prefix("/@fs/").unwrap_or(&decoded_path);
        let fs_path = if is_windows_absolute_path(fs_path) {
            fs_path.to_string()
        } else {
            format!("/{fs_path}")
        };
        let Some(relative) = absolute_project_rel_path(root, &fs_path) else {
            return CssSourceHint::Unmapped;
        };
        relative
    } else if file_url
        || root.is_some_and(|root| absolute_project_rel_path(root, &decoded_path).is_some())
        || is_windows_absolute_path(&decoded_path)
        || (!served_url && looks_like_absolute_filesystem_path(&decoded_path))
    {
        let Some(root) = root else {
            return CssSourceHint::Unmapped;
        };
        let Some(relative) = absolute_project_rel_path(root, &decoded_path) else {
            return CssSourceHint::Unmapped;
        };
        relative
    } else {
        // A leading slash in a served Vite URL or bare Vite module id is rooted at
        // the project's dev-server URL, not at the host filesystem root.
        let relative = decoded_path.strip_prefix('/').unwrap_or(&decoded_path);
        let Some(relative) = normalize_project_rel_path(relative) else {
            return CssSourceHint::Unmapped;
        };
        relative
    };

    let identity = CssSourceIdentity { path, style_index };
    let direct_match = sheets
        .iter()
        .any(|sheet| sheet_matches_source_identity(&sheet.rel, &identity));
    // Vite/Astro serve files in `public/` from the URL root, omitting that source
    // directory from the browser URL. Consider this alias only for ordinary local
    // HTTP stylesheet URLs (not `/@fs/`, file URLs, or embedded Astro block IDs).
    let public_identity = if served_url
        && !file_url
        && !vite_fs_path
        && identity.style_index.is_none()
        && !identity.path.starts_with("public/")
    {
        normalize_project_rel_path(&format!("public/{}", identity.path)).map(|path| {
            CssSourceIdentity {
                path,
                style_index: None,
            }
        })
    } else {
        None
    };
    let public_match = public_identity.as_ref().is_some_and(|public| {
        sheets
            .iter()
            .any(|sheet| sheet_matches_source_identity(&sheet.rel, public))
    });

    match (direct_match, public_match) {
        (true, false) => source_hint_for_identity(root, sheets, identity),
        (false, true) => {
            source_hint_for_identity(root, sheets, public_identity.expect("matched public path"))
        }
        // If both on-disk paths could have produced the same browser URL, the URL
        // alone cannot safely choose a write target. Keep it read-only.
        (true, true) | (false, false) => {
            // A full, path-shaped id without one exact indexed source is evidence
            // against the selector-only result, not permission to pick another file.
            CssSourceHint::Unmapped
        }
    }
}

fn looks_like_absolute_filesystem_path(path: &str) -> bool {
    let path = path.replace('\\', "/");
    [
        "/Users/",
        "/home/",
        "/private/",
        "/var/",
        "/tmp/",
        "/Volumes/",
        "/opt/",
        "/workspace/",
        "/mnt/",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
        || is_windows_absolute_path(&path)
}

fn is_windows_absolute_path(path: &str) -> bool {
    let path = path.strip_prefix('/').unwrap_or(path);
    path.len() >= 3
        && path.as_bytes()[0].is_ascii_alphabetic()
        && path.as_bytes()[1] == b':'
        && matches!(path.as_bytes()[2], b'/' | b'\\')
}

fn is_local_dev_host(authority: &str) -> bool {
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = if authority.starts_with('[') {
        authority
            .find(']')
            .map(|end| &authority[1..end])
            .unwrap_or(authority)
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    let host = host.to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(address)) => {
            address.is_loopback() || address.is_private() || address.is_link_local()
        }
        Ok(std::net::IpAddr::V6(address)) => {
            address.is_loopback() || (address.segments()[0] & 0xfe00 == 0xfc00)
        }
        Err(_) => false,
    }
}

fn css_style_index(query: &str) -> Result<Option<usize>, ()> {
    let mut style_ref = None;
    let mut astro_index = None;
    let astro_style_request = query.split('&').any(|part| part == "astro")
        && query.split('&').any(|part| part == "type=style");
    for pair in query.split('&').filter(|part| !part.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key {
            "style" => {
                let index = value.parse::<usize>().map_err(|_| ())?;
                if style_ref.is_some_and(|previous| previous != index) {
                    return Err(());
                }
                style_ref = Some(index);
            }
            "index" if astro_style_request => {
                let index = value.parse::<usize>().map_err(|_| ())?;
                if astro_index.is_some_and(|previous| previous != index) {
                    return Err(());
                }
                astro_index = Some(index);
            }
            _ => {}
        }
    }
    match (style_ref, astro_index) {
        (Some(a), Some(b)) if a != b => Err(()),
        (Some(index), _) | (_, Some(index)) => Ok(Some(index)),
        _ => Ok(None),
    }
}

/// Map one cascade match to its source rule across the pre-indexed sheets.
fn locate_rule(sheets: &[SheetIndex], q: &MatchedRuleQuery) -> RuleLocation {
    locate_rule_with_root(None, sheets, q)
}

fn locate_rule_in_project(
    root: &Path,
    sheets: &[SheetIndex],
    q: &MatchedRuleQuery,
) -> RuleLocation {
    locate_rule_with_root(Some(root), sheets, q)
}

fn context_path_matches(source: &[String], runtime: Option<&[String]>) -> bool {
    let Some(runtime) = runtime else { return true };
    source.len() == runtime.len()
        && source.iter().zip(runtime).all(|(source, runtime)| {
            let source = source.trim();
            let runtime = runtime.trim();
            let source_kind = source.split_whitespace().next().unwrap_or("");
            let runtime_kind = runtime.split_whitespace().next().unwrap_or("");
            if !source_kind.eq_ignore_ascii_case(runtime_kind) {
                return false;
            }
            if source_kind.eq_ignore_ascii_case("@media") {
                let source_query = source.strip_prefix(source_kind).unwrap_or("").trim();
                let runtime_query = runtime.strip_prefix(runtime_kind).unwrap_or("").trim();
                media_text_matches(
                    &Some(source_query.to_string()),
                    &Some(runtime_query.to_string()),
                )
            } else {
                norm_cond(source) == norm_cond(runtime)
            }
        })
}

fn normalized_evidence_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut quote = None;
    let mut pending_space = false;
    let mut escape_next = false;
    for character in value.trim().chars() {
        if escape_next {
            out.push(character);
            escape_next = false;
            continue;
        }
        if let Some(delimiter) = quote {
            out.push(character);
            if character == '\\' {
                escape_next = true;
            } else if character == delimiter {
                quote = None;
            }
            continue;
        }
        match character {
            '\\' => {
                if pending_space && !out.is_empty() {
                    out.push(' ');
                }
                pending_space = false;
                out.push(character);
                escape_next = true;
            }
            '\'' | '"' => {
                if pending_space && !out.is_empty() {
                    out.push(' ');
                }
                pending_space = false;
                quote = Some(character);
                out.push(character);
            }
            c if c.is_whitespace() => pending_space = true,
            _ => {
                if pending_space && !out.is_empty() {
                    out.push(' ');
                }
                pending_space = false;
                out.push(character);
            }
        }
    }
    out
}

fn css_wide_keyword(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "inherit" => Some("inherit"),
        "initial" => Some("initial"),
        "unset" => Some("unset"),
        "revert" => Some("revert"),
        "revert-layer" => Some("revert-layer"),
        _ => None,
    }
}

fn is_font_evidence_property(property: &str) -> bool {
    property.starts_with("font-") || property == "line-height"
}

fn is_known_font_longhand(property: &str) -> bool {
    matches!(
        property,
        "font-style"
            | "font-variant"
            | "font-variant-alternates"
            | "font-variant-caps"
            | "font-variant-east-asian"
            | "font-variant-emoji"
            | "font-variant-ligatures"
            | "font-variant-numeric"
            | "font-variant-position"
            | "font-weight"
            | "font-stretch"
            | "font-width"
            | "font-size"
            | "line-height"
            | "font-family"
            | "font-size-adjust"
            | "font-kerning"
            | "font-feature-settings"
            | "font-optical-sizing"
            | "font-variation-settings"
    )
}

/// Collapse the CSSOM's expanded font longhands only when they are a complete,
/// contiguous CSS-wide font value. The core font members must all be present;
/// optional longhands vary with WebKit support, while mixed values, priorities,
/// duplicate/unknown properties, or interrupted groups remain unmatched.
fn normalize_font_cssom_evidence(declarations: &[Declaration]) -> Option<Vec<Declaration>> {
    let font_indices: Vec<_> = declarations
        .iter()
        .enumerate()
        .filter_map(|(index, declaration)| {
            is_font_evidence_property(&declaration.property.to_ascii_lowercase()).then_some(index)
        })
        .collect();

    let Some(&first) = font_indices.first() else {
        let mut normalized = declarations.to_vec();
        for declaration in &mut normalized {
            if declaration.property.eq_ignore_ascii_case("font") {
                if let Some(keyword) = css_wide_keyword(&declaration.value) {
                    declaration.value = keyword.to_string();
                }
            }
        }
        return Some(normalized);
    };
    let last = *font_indices.last()?;
    if font_indices.len() != last - first + 1 {
        return None;
    }

    let mut seen = HashSet::new();
    let mut keyword = None;
    let mut important = None;
    for declaration in &declarations[first..=last] {
        let property = declaration.property.to_ascii_lowercase();
        if !is_font_evidence_property(&property) || !is_known_font_longhand(&property) {
            return None;
        }
        let canonical_property = match property.as_str() {
            // `font-width` is the modern name for the same longhand as
            // `font-stretch`; a browser should expose one spelling, never both.
            "font-stretch" => "font-width".to_string(),
            _ => property.clone(),
        };
        if !seen.insert(canonical_property) {
            return None;
        }
        let current_keyword = css_wide_keyword(&declaration.value)?;
        if keyword.is_some_and(|previous| previous != current_keyword)
            || important.is_some_and(|previous| previous != declaration.important)
        {
            return None;
        }
        keyword = Some(current_keyword);
        important = Some(declaration.important);
    }

    for required in [
        "font-style",
        "font-weight",
        "font-size",
        "line-height",
        "font-family",
    ] {
        if !seen.contains(required) {
            return None;
        }
    }

    let mut normalized = Vec::with_capacity(declarations.len() - (last - first));
    normalized.extend_from_slice(&declarations[..first]);
    normalized.push(Declaration {
        property: "font".into(),
        value: keyword?.into(),
        important: important?,
    });
    normalized.extend_from_slice(&declarations[last + 1..]);
    Some(normalized)
}

fn authored_declaration_evidence(css: &str, rule: &RuleSpan) -> Vec<Declaration> {
    declarations_in(css, rule)
        .into_iter()
        .flat_map(|declaration| {
            let property = declaration.property.to_ascii_lowercase();
            let value = normalized_evidence_value(&declaration.value);
            if property == "white-space" {
                let (collapse, wrapping) = match value.as_str() {
                    "normal" => ("collapse", "wrap"),
                    "nowrap" => ("collapse", "nowrap"),
                    "pre" => ("preserve", "nowrap"),
                    "pre-wrap" => ("preserve", "wrap"),
                    "pre-line" => ("preserve-breaks", "wrap"),
                    "break-spaces" => ("break-spaces", "wrap"),
                    _ => return Vec::new(),
                };
                vec![
                    Declaration {
                        property: "white-space-collapse".into(),
                        value: collapse.into(),
                        important: declaration.important,
                    },
                    Declaration {
                        property: "text-wrap-mode".into(),
                        value: wrapping.into(),
                        important: declaration.important,
                    },
                ]
            } else {
                let value = if property == "font" {
                    css_wide_keyword(&value).unwrap_or(&value).to_string()
                } else {
                    value
                };
                vec![Declaration {
                    property,
                    value,
                    important: declaration.important,
                }]
            }
        })
        .collect()
}

fn declaration_evidence_matches(
    css: &str,
    rule: &RuleSpan,
    runtime: Option<&[Declaration]>,
) -> bool {
    let Some(runtime) = runtime else { return true };
    let authored = authored_declaration_evidence(css, rule);
    let declarations_match = |left: &[Declaration], right: &[Declaration]| {
        left.len() == right.len()
            && left.iter().zip(right).all(|(left, right)| {
                left.property.eq_ignore_ascii_case(&right.property)
                    && normalized_evidence_value(&left.value)
                        == normalized_evidence_value(&right.value)
                    && left.important == right.important
            })
    };
    if declarations_match(&authored, runtime) {
        return true;
    }
    let Some(runtime) = normalize_font_cssom_evidence(runtime) else {
        return false;
    };
    declarations_match(&authored, &runtime)
}

/// Use declaration evidence to narrow structurally safe candidates only when it
/// identifies at least one. CSSOM can expand shorthands or serialize values
/// differently, so no evidence match is not proof that a unique source rule is absent.
/// Ambiguous candidates remain ambiguous when their evidence cannot distinguish them.
fn prefer_declaration_evidence<'a>(
    hits: Vec<(&'a str, &'a str, &'a RuleSpan)>,
    runtime: Option<&[Declaration]>,
) -> Vec<(&'a str, &'a str, &'a RuleSpan)> {
    let Some(runtime) = runtime else { return hits };
    let matching: Vec<_> = hits
        .iter()
        .copied()
        .filter(|(_, css, rule)| declaration_evidence_matches(css, rule, Some(runtime)))
        .collect();
    if matching.is_empty() {
        hits
    } else {
        matching
    }
}

fn matched_member_index(rule: &RuleSpan, query: &MatchedRuleQuery) -> Option<usize> {
    let parts = normalized_selector_parts(&rule.selector);
    if let Some(index) = query.selector_member_index {
        return (parts.get(index).map(String::as_str)
            == Some(norm_selector(&query.selector).as_str()))
        .then_some(index);
    }
    let target = norm_selector(&query.selector);
    let matches: Vec<_> = parts
        .iter()
        .enumerate()
        .filter_map(|(index, part)| (part == &target).then_some(index))
        .collect();
    if matches.len() == 1 {
        Some(matches[0])
    } else {
        None
    }
}

fn rule_matches_query(rule: &RuleSpan, query: &MatchedRuleQuery) -> bool {
    let parts = normalized_selector_parts(&rule.selector);
    if let Some(index) = query.selector_member_index {
        return parts.get(index).map(String::as_str)
            == Some(norm_selector(&query.selector).as_str());
    }
    let target = norm_selector(&query.selector);
    parts.iter().any(|part| part == &target)
}

fn candidate_line_offset(root: Option<&Path>, file: &str, cached_content: &str) -> Option<usize> {
    let Some(root) = root else {
        return Some(0);
    };
    let editable = load_editable_css(root, file).ok()?;
    if editable.css != cached_content {
        return None;
    }
    Some(
        editable
            .prefix
            .as_bytes()
            .iter()
            .filter(|byte| **byte == b'\n')
            .count(),
    )
}

fn locate_rule_with_root(
    root: Option<&Path>,
    sheets: &[SheetIndex],
    q: &MatchedRuleQuery,
) -> RuleLocation {
    let resolved = |rel: &str,
                    content: &str,
                    rule: &RuleSpan,
                    generated_css_output: Option<String>| {
        let Some(member_index) = matched_member_index(rule, q) else {
            return RuleLocation::NotFound;
        };
        let Some(source_identity) =
            css_rule_mutations::identity_for_rule(rel, content, rule, member_index, &q.selector)
        else {
            return RuleLocation::NotFound;
        };
        RuleLocation::Resolved {
            file: rel.to_string(),
            line: rule.selector_line,
            inner_text: content[rule.block_inner_start..rule.block_inner_end].to_string(),
            generated_css_output,
            source_identity: Some(source_identity),
        }
    };

    let mut hits: Vec<(&str, &str, &RuleSpan)> = Vec::new();
    let selector = norm_selector(&q.selector);
    for sheet in sheets {
        let Some(indices) = sheet.selectors.get(&selector) else {
            continue;
        };
        for &index in indices {
            let rule = &sheet.rules[index];
            if media_text_matches(&rule.media, &q.media_text)
                && rule_matches_query(rule, q)
                && q.context_path.as_deref().map_or(true, |path| {
                    context_path_matches(&rule.context_path, Some(path))
                })
            {
                hits.push((sheet.rel.as_str(), sheet.content.as_str(), rule));
            }
        }
    }

    let source_hint = q
        .href
        .as_deref()
        .map(|href| css_source_hint(root, sheets, href))
        .unwrap_or(CssSourceHint::Unavailable);
    if q.runtime_identity
        .as_ref()
        .is_some_and(|runtime| runtime.href != q.href)
        || (q.runtime_identity.is_some() && matches!(&source_hint, CssSourceHint::Unavailable))
    {
        return RuleLocation::NotFound;
    }
    match &source_hint {
        CssSourceHint::Project(identity) => {
            hits.retain(|(rel, _, _)| sheet_matches_source_identity(rel, identity));
            hits = prefer_declaration_evidence(hits, q.identity_declarations.as_deref());
        }
        CssSourceHint::Generated {
            output_path,
            source_paths,
        } => {
            let output_hits: Vec<_> = hits
                .iter()
                .copied()
                .filter(|(rel, _, _)| *rel == output_path.as_str())
                .collect();
            let output_hits =
                prefer_declaration_evidence(output_hits, q.identity_declarations.as_deref());
            if output_hits.is_empty() {
                return RuleLocation::NotFound;
            }

            let same_context = |a: &Option<String>, b: &Option<String>| match (a, b) {
                (Some(left), Some(right)) => norm_cond(left) == norm_cond(right),
                (None, None) => true,
                _ => false,
            };
            let source_hits: Vec<_> = hits
                .iter()
                .copied()
                .filter(|(rel, _, _)| {
                    source_paths
                        .iter()
                        .any(|source_path| *rel == source_path.as_str())
                })
                .collect();
            let source_hits =
                prefer_declaration_evidence(source_hits, q.identity_declarations.as_deref());
            let mut mapped_hits = Vec::new();
            let mut seen = HashSet::new();
            for (_, output_content, output_rule) in output_hits.iter().copied() {
                for (source_path, source_content, source_rule) in source_hits.iter().copied() {
                    let same_rule = output_rule.selector == source_rule.selector
                        && media_text_matches(&output_rule.media, &source_rule.media)
                        && same_context(&output_rule.layer, &source_rule.layer)
                        && same_context(&output_rule.container, &source_rule.container)
                        && same_context(&output_rule.supports, &source_rule.supports)
                        && output_content
                            [output_rule.block_inner_start..output_rule.block_inner_end]
                            == source_content
                                [source_rule.block_inner_start..source_rule.block_inner_end];
                    if same_rule
                        && seen.insert((source_path.to_string(), source_rule.selector_start))
                    {
                        mapped_hits.push((source_path, source_content, source_rule));
                    }
                }
            }

            match mapped_hits.len() {
                0 => return RuleLocation::NotFound,
                1 => {
                    let (rel, content, rule) = mapped_hits[0];
                    return resolved(rel, content, rule, Some(output_path.clone()));
                }
                _ => {
                    let mut line_offsets = HashMap::new();
                    let candidates: Vec<_> = mapped_hits
                        .iter()
                        .map(|(rel, content, rule)| {
                            let offset = *line_offsets
                                .entry((*rel).to_string())
                                .or_insert_with(|| candidate_line_offset(root, rel, content));
                            RuleSourceCandidate {
                                file: (*rel).to_string(),
                                line: offset.map(|offset| offset + rule.selector_line),
                            }
                        })
                        .collect();
                    return RuleLocation::Multiple {
                        files: mapped_hits
                            .iter()
                            .map(|(rel, _, _)| rel.to_string())
                            .collect::<std::collections::BTreeSet<_>>()
                            .into_iter()
                            .collect(),
                        rule_count: mapped_hits.len(),
                        candidates,
                    };
                }
            }
        }
        CssSourceHint::Unmapped => return RuleLocation::NotFound,
        CssSourceHint::Unavailable => {
            hits = prefer_declaration_evidence(hits, q.identity_declarations.as_deref());
        }
    }

    match hits.len() {
        0 => RuleLocation::NotFound,
        1 => {
            let (rel, content, rule) = hits[0];
            resolved(rel, content, rule, None)
        }
        _ => {
            // Several rules share this selector + media. The exact source path/style index
            // above is the strongest evidence. A basename is only retained as a legacy
            // fallback when no usable path identity was available. At-rule context can
            // distinguish genuinely separate authored rules; unresolved ties stay read-only.
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
                    resolved(rel, content, rule, None)
                };
            } else if !by_ctx.is_empty() && by_ctx.len() < hits.len() {
                by_ctx
            } else {
                hits.clone()
            };
            let mut line_offsets = HashMap::new();
            let candidates = pool
                .iter()
                .map(|(rel, content, rule)| {
                    let offset = *line_offsets
                        .entry((*rel).to_string())
                        .or_insert_with(|| candidate_line_offset(root, rel, content));
                    RuleSourceCandidate {
                        file: (*rel).to_string(),
                        line: offset.map(|offset| offset + rule.selector_line),
                    }
                })
                .collect();
            RuleLocation::Multiple {
                files: pool
                    .iter()
                    .map(|(rel, _, _)| rel.to_string())
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect(),
                rule_count: pool.len(),
                candidates,
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

/// True when an Astro `:global(...)` wrapper spans one entire selector-list member.
fn astro_global_wraps_entire_group(group: &str) -> bool {
    let group = group.trim();
    if !group
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(":global("))
    {
        return false;
    }

    let bytes = group.as_bytes();
    let mut depth = 1i32;
    let mut quote = 0u8;
    let mut i = 8usize;
    while i < bytes.len() {
        let byte = bytes[i];
        if quote != 0 {
            if byte == b'\\' {
                i += 2;
                continue;
            }
            if byte == quote {
                quote = 0;
            }
            i += 1;
            continue;
        }
        if byte == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 >= bytes.len() {
                return false;
            }
            i += 2;
            continue;
        }
        match byte {
            b'\'' | b'"' => quote = byte,
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return group[i + 1..].trim().is_empty();
                }
            }
            _ => {}
        }
        i += 1;
    }
    false
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
    let source_parts = split_selector_group(&rule.selector);
    let has_global = source_parts.iter().any(|part| unwrap_astro_global(part).1);
    let all_parts_are_global = source_parts
        .iter()
        .all(|part| astro_global_wraps_entire_group(part));
    let replacement = if has_global {
        if !all_parts_are_global {
            return Err(CommandError::Validation {
                field: "selector".into(),
                reason: "this Astro selector mixes :global() and scoped parts; rename it in source to preserve Astro scoping".into(),
            });
        }
        if unwrap_astro_global(new_selector).1 {
            new_selector.trim().to_string()
        } else {
            format!(":global({})", new_selector.trim())
        }
    } else {
        new_selector.trim().to_string()
    };
    let brace = rule.block_inner_start - 1; // the opening `{`
    let mut out = String::with_capacity(src.len() + replacement.len());
    out.push_str(&src[..rule.selector_start]);
    out.push_str(&replacement);
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
pub(super) fn index_rules(css: &str) -> Vec<RuleSpan> {
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
        /// `@scope` is retained in source identity, even though its editing UI is limited.
        Scope(String),
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

    fn enclosing_context_path(stack: &[Frame]) -> Vec<String> {
        stack
            .iter()
            .filter_map(|frame| match frame {
                Frame::Media(media, ..) => Some(format!("@media {media}")),
                Frame::Group(GroupKind::Layer(name)) => Some(if name.is_empty() {
                    "@layer".to_string()
                } else {
                    format!("@layer {name}")
                }),
                Frame::Group(GroupKind::Container(condition)) => {
                    Some(format!("@container {condition}"))
                }
                Frame::Group(GroupKind::Supports(condition)) => {
                    Some(format!("@supports {condition}"))
                }
                Frame::Group(GroupKind::Scope(condition)) => Some(format!("@scope {condition}")),
                Frame::Group(GroupKind::Anonymous) => Some("@layer".to_string()),
                Frame::Rule(_) | Frame::Other => None,
            })
            .collect()
    }

    let bytes = css.as_bytes();
    let n = bytes.len();
    // Previously each rule rescanned css[..selector_start] to count newlines:
    // quadratic work that took seconds on ordinary exported stylesheets.
    let line_breaks: Vec<usize> = bytes
        .iter()
        .enumerate()
        .filter_map(|(i, b)| (*b == b'\n').then_some(i))
        .collect();
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

        // Escaped CSS punctuation is part of an identifier/string token, not a
        // structural delimiter in the stylesheet scanner.
        if c == b'\\' {
            i = css_selector_escape_end(css, i, n);
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
                        _ => GroupKind::Scope(cond.to_string()),
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
                    let selector_line =
                        line_breaks.partition_point(|&pos| pos < selector_start) + 1;
                    let idx = rules.len();
                    rules.push(RuleSpan {
                        selector: prelude.to_string(),
                        media,
                        media_prelude,
                        layer,
                        container,
                        supports,
                        context_path: enclosing_context_path(&stack),
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
                let selector_line = line_breaks.partition_point(|&pos| pos < selector_start) + 1;
                let idx = rules.len();
                rules.push(RuleSpan {
                    selector: prelude.to_string(),
                    media,
                    media_prelude,
                    layer,
                    container,
                    supports,
                    context_path: enclosing_context_path(&stack),
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
        // Comments between declarations belong to the surrounding source, not
        // to the next property's name. Skip only leading comments here; their
        // bytes remain untouched because `decl_start` begins at the property.
        let mut significant_start = seg_start;
        loop {
            let (candidate, _) = trim_range(css, significant_start, seg_end);
            if candidate + 1 >= seg_end || bytes[candidate] != b'/' || bytes[candidate + 1] != b'*'
            {
                significant_start = candidate;
                break;
            }
            let Some(close) = css[candidate + 2..seg_end].find("*/") else {
                return;
            };
            significant_start = candidate + 2 + close + 2;
        }
        let (ds, de) = trim_range(css, significant_start, seg_end);
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
            let (rs, re) = declaration_removal_range(css, d, inner_start, inner_end);
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

/// Byte range covering an entire declaration, including its indentation and one
/// adjacent newline when available. Shared by single-declaration edits and the
/// project-wide custom-property removal flow.
fn declaration_removal_range(
    css: &str,
    declaration: &DeclSpan,
    inner_start: usize,
    inner_end: usize,
) -> (usize, usize) {
    let bytes = css.as_bytes();
    let mut start = declaration.decl_start;
    while start > inner_start && matches!(bytes[start - 1], b' ' | b'\t') {
        start -= 1;
    }

    let mut end = declaration.decl_end;
    while end < inner_end && matches!(bytes[end], b' ' | b'\t') {
        end += 1;
    }
    if end < inner_end && bytes[end] == b'\n' {
        end += 1;
    } else if start > inner_start && bytes[start - 1] == b'\n' {
        start -= 1;
    }
    (start, end)
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

/// Add a custom property to the project's base `:root` scope. Unlike an ordinary
/// declaration edit, adding a new token is safe when a stylesheet has several base
/// `:root` blocks: append to the last one so the token is available at the stylesheet's
/// final base cascade position. Media-scoped `:root` blocks are intentionally ignored;
/// if there is no base block, a new base block is created instead.
fn add_custom_property_to_source(
    src: &str,
    property: &str,
    value: &str,
) -> Result<String, CommandError> {
    let rules = index_rules(src);

    // One predicate for both the duplicate check and the insertion target: they
    // used to disagree, the check scanning every `:root` while insertion only
    // ever wrote to a base one. A `--token` defined solely inside, say,
    // `@media (prefers-color-scheme: dark) { :root { … } }` is not a duplicate
    // of a base definition — it's the *reason* you'd add the base one — yet the
    // add was refused, which also made the "create a base :root" fallback below
    // unreachable for that name.
    let is_base_root = |r: &&RuleSpan| r.media.is_none() && selector_has_part(&r.selector, ":root");

    if rules.iter().filter(is_base_root).any(|r| {
        declarations_in(src, r)
            .iter()
            .any(|d| d.property == property)
    }) {
        return Err(CommandError::Validation {
            field: "property".into(),
            reason: "a variable with this name already exists".into(),
        });
    }

    if let Some(root) = rules.iter().rfind(is_base_root) {
        return Ok(set_declaration_in_block(
            src,
            root.block_inner_start,
            root.block_inner_end,
            property,
            Some(value),
        ));
    }

    let rule = build_rule_text(
        ":root",
        &[Declaration {
            property: property.to_string(),
            value: value.to_string(),
            important: false,
        }],
        None,
        None,
    );
    let mut out = src.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(&rule);
    out.push('\n');
    Ok(out)
}

/// Update one existing custom-property definition, pinned to the selector line
/// returned by `get_css_variables`. When several same-selector rules share a line,
/// the property name must still identify exactly one declaration across them.
fn set_custom_property_in_source(
    src: &str,
    selector: &str,
    line: usize,
    property: &str,
    value: &str,
) -> Result<String, CommandError> {
    let rules: Vec<RuleSpan> = index_rules(src)
        .into_iter()
        .filter(|rule| rule.selector_line == line && rule.selector == selector)
        .collect();
    let mut definitions = Vec::new();
    for rule in &rules {
        for definition in locate_declarations(src, rule.block_inner_start, rule.block_inner_end)
            .into_iter()
            .filter(|declaration| declaration.property == property)
        {
            definitions.push((rule, definition));
        }
    }
    if definitions.len() != 1 {
        return Err(CommandError::Validation {
            field: "variable".into(),
            reason: "definition is missing or ambiguous at its source location — not editable"
                .into(),
        });
    }

    let (rule, definition) = &definitions[0];
    let existing = src[definition.value_start..definition.value_end].trim_end();
    let keep_important = existing.to_ascii_lowercase().ends_with("!important")
        && !value.to_ascii_lowercase().contains("!important");
    let mut out = String::with_capacity(src.len() - existing.len() + value.len());
    out.push_str(&src[..definition.value_start]);
    out.push_str(value);
    if keep_important {
        out.push_str(" !important");
    }
    out.push_str(&src[definition.value_end..]);
    Ok(out)
}

/// A custom-property identity supplied by the Variables panel when committing a
/// projected order. Every identity must point back to the same source rule.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CssVariableOrderEntry {
    pub name: String,
    pub file: String,
    pub selector: String,
    pub line: usize,
}

/// Reorder only custom-property declaration text within one exact rule. The
/// surrounding bytes — including comments, whitespace, non-variable
/// declarations, declaration spelling/value and `!important` — are left in
/// place. This is intentionally a slot replacement rather than a rule
/// reserializer so a reorder remains a small, reviewable source diff.
fn reorder_custom_properties_in_source(
    src: &str,
    selector: &str,
    line: usize,
    ordered: &[CssVariableOrderEntry],
) -> Result<String, CommandError> {
    let matches: Vec<RuleSpan> = index_rules(src)
        .into_iter()
        .filter(|rule| rule.selector == selector && rule.selector_line == line)
        .collect();
    if matches.len() != 1 {
        return Err(CommandError::Validation {
            field: "variable".into(),
            reason:
                "the :root rule moved or is ambiguous — reload the variables panel and try again"
                    .into(),
        });
    }
    let rule = &matches[0];
    let declarations: Vec<DeclSpan> =
        locate_declarations(src, rule.block_inner_start, rule.block_inner_end);
    let variable_declarations: Vec<&DeclSpan> = declarations
        .iter()
        .filter(|declaration| declaration.property.starts_with("--"))
        .collect();
    if variable_declarations.is_empty() {
        return Err(CommandError::Validation {
            field: "variable".into(),
            reason: "the source rule has no custom-property definitions — reload the variables panel and try again".into(),
        });
    }

    let mut existing_by_name: HashMap<&str, &DeclSpan> = HashMap::new();
    for declaration in &variable_declarations {
        if existing_by_name
            .insert(declaration.property.as_str(), declaration)
            .is_some()
        {
            return Err(CommandError::Validation {
                field: "variable".into(),
                reason:
                    "a custom-property definition is duplicated in its source rule — not editable"
                        .into(),
            });
        }
    }
    let mut requested_names = HashSet::with_capacity(ordered.len());
    for entry in ordered {
        validate_custom_property(&entry.name)?;
        if !requested_names.insert(entry.name.as_str()) {
            return Err(CommandError::Validation {
                field: "ordered".into(),
                reason: "the requested variable order contains a duplicate definition".into(),
            });
        }
        if !existing_by_name.contains_key(entry.name.as_str()) {
            return Err(CommandError::Validation {
                field: "ordered".into(),
                reason:
                    "the requested variable order is stale — a definition is missing or was added"
                        .into(),
            });
        }
    }
    if requested_names.len() != existing_by_name.len() {
        return Err(CommandError::Validation {
            field: "ordered".into(),
            reason: "the requested variable order is stale — a definition is missing or was added"
                .into(),
        });
    }

    let mut out = String::with_capacity(src.len());
    let mut cursor = 0usize;
    // The destination slots are the existing custom-property spans in source
    // order. Only their declaration text changes; every other source span is
    // copied directly from the original string.
    for (destination, entry) in variable_declarations.iter().zip(ordered) {
        let source = existing_by_name[entry.name.as_str()];
        out.push_str(&src[cursor..destination.decl_start]);
        out.push_str(&src[source.decl_start..source.decl_end]);
        cursor = destination.decl_end;
    }
    out.push_str(&src[cursor..]);
    Ok(out)
}

fn validate_variable_order_entries(
    file: &str,
    selector: &str,
    line: usize,
    ordered: &[CssVariableOrderEntry],
) -> Result<(), CommandError> {
    if ordered.is_empty() {
        return Err(CommandError::Validation {
            field: "ordered".into(),
            reason: "at least one variable definition is required".into(),
        });
    }
    if ordered
        .iter()
        .any(|entry| entry.file != file || entry.selector != selector || entry.line != line)
    {
        return Err(CommandError::Validation {
            field: "ordered".into(),
            reason: "the requested variable order crosses source rules".into(),
        });
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CssVariableDeleteImpact {
    pub usage_count: usize,
    pub rule_count: usize,
    pub file_count: usize,
    pub definition_count: usize,
    pub replacement_value: String,
}

/// Replace complete `var(--name[, fallback])` functions while ignoring comments
/// and quoted strings. CSS custom-property names are case-sensitive; the `var`
/// function itself is ASCII case-insensitive.
fn replace_custom_property_references(
    css: &str,
    property: &str,
    replacement: &str,
) -> (String, usize) {
    let bytes = css.as_bytes();
    let property_bytes = property.as_bytes();
    let mut out = String::with_capacity(css.len());
    let mut last = 0usize;
    let mut i = 0usize;
    let mut count = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        if matches!(bytes[i], b'\'' | b'"') {
            let quote = bytes[i];
            i += 1;
            while i < bytes.len() && bytes[i] != quote {
                if bytes[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(bytes.len());
            continue;
        }

        let is_var = i + 3 <= bytes.len()
            && bytes[i..i + 3].eq_ignore_ascii_case(b"var")
            && (i == 0
                || !matches!(
                    bytes[i - 1],
                    b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'-'
                ));
        if !is_var {
            i += 1;
            continue;
        }

        let mut open = i + 3;
        while open < bytes.len() && bytes[open].is_ascii_whitespace() {
            open += 1;
        }
        if open >= bytes.len() || bytes[open] != b'(' {
            i += 3;
            continue;
        }

        let mut name_start = open + 1;
        while name_start < bytes.len() && bytes[name_start].is_ascii_whitespace() {
            name_start += 1;
        }
        let name_end = name_start.saturating_add(property_bytes.len());
        if name_end > bytes.len()
            || &bytes[name_start..name_end] != property_bytes
            || (name_end < bytes.len()
                && !bytes[name_end].is_ascii_whitespace()
                && !matches!(bytes[name_end], b',' | b')'))
        {
            i = open + 1;
            continue;
        }

        let mut cursor = open + 1;
        let mut depth = 1usize;
        let mut close = None;
        while cursor < bytes.len() {
            if bytes[cursor] == b'/' && cursor + 1 < bytes.len() && bytes[cursor + 1] == b'*' {
                cursor += 2;
                while cursor + 1 < bytes.len()
                    && !(bytes[cursor] == b'*' && bytes[cursor + 1] == b'/')
                {
                    cursor += 1;
                }
                cursor = (cursor + 2).min(bytes.len());
                continue;
            }
            if matches!(bytes[cursor], b'\'' | b'"') {
                let quote = bytes[cursor];
                cursor += 1;
                while cursor < bytes.len() && bytes[cursor] != quote {
                    if bytes[cursor] == b'\\' {
                        cursor += 1;
                    }
                    cursor += 1;
                }
                cursor = (cursor + 1).min(bytes.len());
                continue;
            }
            match bytes[cursor] {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(cursor + 1);
                        break;
                    }
                }
                _ => {}
            }
            cursor += 1;
        }

        let Some(end) = close else {
            i = open + 1;
            continue;
        };
        out.push_str(&css[last..i]);
        out.push_str(replacement);
        last = end;
        i = end;
        count += 1;
    }

    if count == 0 {
        return (css.to_string(), 0);
    }
    out.push_str(&css[last..]);
    (out, count)
}

/// Inline a custom-property reference in static class/className literals.
/// Tailwind arbitrary values use underscores for spaces, so the replacement is
/// encoded for a class token before it is inserted. Dynamic class expressions
/// are intentionally left alone because the source resolver cannot safely
/// rewrite them either.
fn replace_custom_property_in_class_literals(
    source: &str,
    file: &str,
    property: &str,
    replacement: &str,
) -> (String, usize, Vec<String>) {
    let class_replacement = replacement.split_whitespace().collect::<Vec<_>>().join("_");
    let spans =
        crate::commands::edit::find_attr_spans(source, crate::commands::edit::attrs_for_path(file));
    let mut updates = Vec::new();
    let mut usage_count = 0usize;
    let mut rule_tokens = std::collections::BTreeSet::new();

    for span in spans {
        let (updated, usages) =
            replace_custom_property_references(&span.value, property, &class_replacement);
        if usages == 0 {
            continue;
        }
        usage_count += usages;
        for token in span.value.split_whitespace() {
            if replace_custom_property_references(token, property, &class_replacement).1 > 0 {
                rule_tokens.insert(token.to_string());
            }
        }
        updates.push((span.value_start, span.value_end, updated));
    }

    if updates.is_empty() {
        return (source.to_string(), 0, Vec::new());
    }

    let mut out = source.to_string();
    for (start, end, updated) in updates.into_iter().rev() {
        out.replace_range(start..end, &updated);
    }
    (out, usage_count, rule_tokens.into_iter().collect())
}

/// Return the value spans of code-level `@apply` statements. The spans exclude
/// the directive and its terminating semicolon, and remain valid byte ranges
/// for reverse-order replacements.
fn apply_value_ranges(css: &str) -> Vec<(usize, usize)> {
    let bytes = css.as_bytes();
    let mut ranges = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        if matches!(bytes[i], b'\'' | b'"') {
            let quote = bytes[i];
            i += 1;
            while i < bytes.len() && bytes[i] != quote {
                if bytes[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(bytes.len());
            continue;
        }
        let is_apply = i + 6 <= bytes.len()
            && &bytes[i..i + 6] == b"@apply"
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric())
            && (i + 6 == bytes.len() || !bytes[i + 6].is_ascii_alphanumeric());
        if !is_apply {
            i += 1;
            continue;
        }

        let start = i + 6;
        let mut j = start;
        let mut depth = 0i32;
        let mut end = bytes.len();
        while j < bytes.len() {
            if bytes[j] == b'/' && j + 1 < bytes.len() && bytes[j + 1] == b'*' {
                j += 2;
                while j + 1 < bytes.len() && !(bytes[j] == b'*' && bytes[j + 1] == b'/') {
                    j += 1;
                }
                j = (j + 2).min(bytes.len());
                continue;
            }
            if matches!(bytes[j], b'\'' | b'"') {
                let quote = bytes[j];
                j += 1;
                while j < bytes.len() && bytes[j] != quote {
                    if bytes[j] == b'\\' {
                        j += 1;
                    }
                    j += 1;
                }
                j = (j + 1).min(bytes.len());
                continue;
            }
            match bytes[j] {
                b'[' | b'(' => depth += 1,
                b']' | b')' => depth = (depth - 1).max(0),
                b';' | b'}' if depth == 0 => {
                    end = j;
                    break;
                }
                _ => {}
            }
            j += 1;
        }
        ranges.push((start, end));
        i = end.max(start + 1);
    }
    ranges
}

/// Replace target references inside `@apply` values using Tailwind's class
/// encoding, leaving ordinary CSS declarations to use the raw replacement.
fn replace_custom_property_references_in_apply(
    css: &str,
    property: &str,
    replacement: &str,
) -> (String, usize) {
    let class_replacement = replacement.split_whitespace().collect::<Vec<_>>().join("_");
    let mut out = css.to_string();
    let mut usage_count = 0usize;
    for (start, end) in apply_value_ranges(css).into_iter().rev() {
        let (updated, usages) =
            replace_custom_property_references(&css[start..end], property, &class_replacement);
        if usages > 0 {
            out.replace_range(start..end, &updated);
            usage_count += usages;
        }
    }
    (out, usage_count)
}

/// Remove every definition of one custom property, then inline its authored raw
/// value into every remaining reference in this stylesheet.
fn inline_and_remove_custom_property(
    css: &str,
    property: &str,
    replacement: &str,
) -> (String, usize, usize, usize, Vec<String>) {
    let rules = index_rules(css);
    let mut removals = Vec::new();
    let mut definition_values = Vec::new();

    for rule in &rules {
        for declaration in locate_declarations(css, rule.block_inner_start, rule.block_inner_end) {
            if declaration.property == property {
                let raw = css[declaration.value_start..declaration.value_end].trim();
                let value = raw
                    .to_ascii_lowercase()
                    .rfind("!important")
                    .map(|index| raw[..index].trim())
                    .unwrap_or(raw);
                definition_values.push(value.to_string());
                removals.push(declaration_removal_range(
                    css,
                    &declaration,
                    rule.block_inner_start,
                    rule.block_inner_end,
                ));
            }
        }
    }

    removals.sort_unstable_by_key(|(start, _)| *start);
    let mut without_definitions = css.to_string();
    for (start, end) in removals.iter().rev() {
        without_definitions.replace_range(*start..*end, "");
    }

    let rule_count = index_rules(&without_definitions)
        .iter()
        .filter(|rule| {
            let body = &without_definitions[rule.block_inner_start..rule.block_inner_end];
            declarations_in(&without_definitions, rule)
                .iter()
                .any(|declaration| {
                    replace_custom_property_references(&declaration.value, property, replacement).1
                        > 0
                })
                || apply_value_ranges(body).into_iter().any(|(start, end)| {
                    replace_custom_property_references(&body[start..end], property, replacement).1
                        > 0
                })
        })
        .count();
    let (without_apply_references, apply_usage_count) =
        replace_custom_property_references_in_apply(&without_definitions, property, replacement);
    let (updated, other_usage_count) =
        replace_custom_property_references(&without_apply_references, property, replacement);
    (
        updated,
        apply_usage_count + other_usage_count,
        rule_count,
        removals.len(),
        definition_values,
    )
}

struct CssVariableDeleteChange {
    path: PathBuf,
    original: String,
    updated: String,
}

fn prepare_css_variable_deletion(
    root: &Path,
    property: &str,
    replacement: &str,
) -> Result<(CssVariableDeleteImpact, Vec<CssVariableDeleteChange>), CommandError> {
    let sheets = discover_stylesheets(root);
    let mut usage_count = 0usize;
    let mut rule_count = 0usize;
    let mut definition_count = 0usize;
    let mut usage_files = std::collections::BTreeSet::new();
    let mut class_rule_tokens = std::collections::BTreeSet::new();
    let mut definition_values = Vec::new();
    let mut sheet_updates: HashMap<String, Vec<(Option<usize>, String)>> = HashMap::new();
    let mut source_updates: HashMap<String, String> = HashMap::new();

    for (style_ref, css) in sheets {
        let (updated, usages, rules, definitions, values) =
            inline_and_remove_custom_property(&css, property, replacement);
        let (physical, block) = parse_style_ref(&style_ref);
        usage_count += usages;
        rule_count += rules;
        definition_count += definitions;
        definition_values.extend(values);
        if usages > 0 {
            usage_files.insert(physical.to_string());
        }
        if updated != css {
            sheet_updates
                .entry(physical.to_string())
                .or_default()
                .push((block, updated));
        }
    }

    // Tailwind usages are authored in component markup as arbitrary-value
    // utilities, for example text-[var(--brand)]. They do not appear in the
    // generated CSS files and therefore need their own source pass.
    for (relative, source) in crate::commands::edit::source_files(root) {
        let (updated, usages, rules) =
            replace_custom_property_in_class_literals(&source, &relative, property, replacement);
        if usages > 0 {
            usage_count += usages;
            usage_files.insert(relative.clone());
            class_rule_tokens.extend(rules);
        }
        if updated != source {
            source_updates.insert(relative, updated);
        }
    }

    if definition_count == 0 {
        return Err(CommandError::Validation {
            field: "property".into(),
            reason: "the variable definition no longer exists — refresh the panel".into(),
        });
    }
    if definition_values.iter().any(|value| value != replacement) {
        return Err(CommandError::Validation {
            field: "property".into(),
            reason: "the variable has conflicting definitions — make their values match before deleting it"
                .into(),
        });
    }

    let mut changes = Vec::new();
    for (relative, mut updates) in sheet_updates {
        let path = safe_join(root, &relative)?;
        let original = std::fs::read_to_string(&path).map_err(CommandError::from)?;
        // An Astro file can contain both a class literal and an embedded style
        // block. Apply the markup edit first, then recalculate style block
        // offsets before applying the CSS edit.
        let mut updated_host = source_updates
            .remove(&relative)
            .unwrap_or_else(|| original.clone());
        if updates.iter().any(|(block, _)| block.is_none()) {
            let (_, updated) = updates
                .pop()
                .expect("a whole-file stylesheet update must contain one entry");
            updated_host = updated;
        } else {
            updates.sort_unstable_by_key(|(block, _)| block.unwrap_or(0));
            for (block, updated_css) in updates.into_iter().rev() {
                let index = block.expect("Astro updates always carry a style-block index");
                let (start, end) = astro_style_block(&updated_host, index).ok_or_else(|| {
                    CommandError::Validation {
                        field: "file".into(),
                        reason: "a <style> block changed while preparing the deletion — try again"
                            .into(),
                    }
                })?;
                updated_host.replace_range(start..end, &updated_css);
            }
        }
        if updated_host != original {
            changes.push(CssVariableDeleteChange {
                path,
                original,
                updated: updated_host,
            });
        }
    }

    // Remaining updates are component/template files without an embedded CSS
    // block, such as TSX, JSX, or plain HTML.
    for (relative, updated) in source_updates {
        let path = safe_join(root, &relative)?;
        let original = std::fs::read_to_string(&path).map_err(CommandError::from)?;
        if updated != original {
            changes.push(CssVariableDeleteChange {
                path,
                original,
                updated,
            });
        }
    }

    Ok((
        CssVariableDeleteImpact {
            usage_count,
            rule_count: rule_count + class_rule_tokens.len(),
            file_count: usage_files.len(),
            definition_count,
            replacement_value: replacement.to_string(),
        },
        changes,
    ))
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
            // One virtual sheet per non-empty plain-CSS `<style>` block. Preserve
            // Astro's original index (including gaps for preprocessor blocks) so
            // Vite's `index=N` maps back to the same host block.
            for (style_index, (s, e)) in astro_style_blocks_with_indices(&content) {
                let css = &content[s..e];
                if css.trim().is_empty() {
                    continue;
                }
                out.push((format!("{rel}?style={style_index}"), css.to_string()));
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
// `path/to/Foo.astro?style=N` (Astro's original compiled-style index). The CSS engine
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

/// Whether Astro leaves this block inline instead of adding it to the compiled
/// CSS modules. Inline blocks have no Vite `index=N` virtual stylesheet.
fn style_tag_is_inline(open_tag: &str) -> bool {
    let lower = open_tag.to_ascii_lowercase();
    lower
        .strip_prefix("<style")
        .unwrap_or(&lower)
        .trim_end_matches('>')
        .split_whitespace()
        .any(|attribute| {
            let attribute = attribute.trim_end_matches('/');
            attribute == "is:inline" || attribute.starts_with("is:inline=")
        })
}

/// The original Astro style index and inner byte range for every addressable
/// plain-CSS `<style>` block. Preprocessor blocks consume an Astro index and
/// inline blocks do not, so returned indexes can have gaps.
fn astro_style_blocks_with_indices(src: &str) -> Vec<(usize, (usize, usize))> {
    let lower = src.to_ascii_lowercase(); // ASCII-lowercase preserves byte offsets
    let mut out = Vec::new();
    let mut search = astro_frontmatter_end(src);
    let mut style_index = 0usize;
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
        let open_tag = &src[tag_start..=open_end];
        if !style_tag_is_inline(open_tag) {
            let current_index = style_index;
            style_index += 1;
            if !style_tag_is_non_css(open_tag) {
                out.push((current_index, (inner_start, inner_end)));
            }
        }
        search = inner_end + "</style".len();
    }
    out
}

/// CSS-only style ranges in document order, kept for callers that don't need
/// Astro's source-block index (for example, parser-focused unit tests).
fn astro_style_blocks(src: &str) -> Vec<(usize, usize)> {
    astro_style_blocks_with_indices(src)
        .into_iter()
        .map(|(_, range)| range)
        .collect()
}

fn astro_style_block(src: &str, style_index: usize) -> Option<(usize, usize)> {
    astro_style_blocks_with_indices(src)
        .into_iter()
        .find_map(|(index, range)| (index == style_index).then_some(range))
}

/// A loaded editable CSS source plus how to write it back: either a whole `.css`
/// file, or a sub-range of an `.astro` host file (the rest preserved verbatim).
struct EditableCss {
    abs: std::path::PathBuf,
    /// Complete host-file snapshot verified again immediately before write-back.
    original_host: String,
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
        let _write_guard = EDITABLE_CSS_WRITE_LOCK
            .lock()
            .map_err(|_| CommandError::Other {
                message: "CSS write coordination lock was poisoned".into(),
            })?;
        let current_host = std::fs::read_to_string(&self.abs).map_err(CommandError::from)?;
        if current_host != self.original_host {
            return Err(CommandError::Validation {
                field: "css".into(),
                reason: "source changed before the edit could be written — reselect to edit".into(),
            });
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
            original_host: host.clone(),
            css: host,
            prefix: String::new(),
            suffix: String::new(),
            whole_file: true,
        }),
        Some(idx) => {
            let (s, e) = astro_style_block(&host, idx).ok_or_else(|| CommandError::Validation {
                field: "file".into(),
                reason: "the <style> block no longer exists — reselect the element".into(),
            })?;
            Ok(EditableCss {
                abs,
                original_host: host.clone(),
                css: host[s..e].to_string(),
                prefix: host[..s].to_string(),
                suffix: host[e..].to_string(),
                whole_file: false,
            })
        }
    }
}

/// Resolve a cascade match inside one exact source file and convert the parsed
/// CSS line into a physical host-file line for embedded Astro style blocks.
fn resolve_css_source_line_in_file(
    root: &Path,
    file: &str,
    matched: &MatchedRuleQuery,
) -> Result<usize, CommandError> {
    resolve_css_source_line_in_file_at_source_line(root, file, matched, None)
}

/// Resolve a CSS rule at its indexed source line when the caller has an exact
/// source identity (for example, a custom-property definition). This avoids
/// choosing another same-selector rule when a Variables row already carries
/// the rule's line. The returned line is still translated to the physical host
/// line for an embedded Astro style block.
fn resolve_css_source_line_in_file_at_source_line(
    root: &Path,
    file: &str,
    matched: &MatchedRuleQuery,
    source_line: Option<usize>,
) -> Result<usize, CommandError> {
    let editable = load_editable_css(root, file)?;
    let prefix_line_count = editable
        .prefix
        .as_bytes()
        .iter()
        .filter(|byte| **byte == b'\n')
        .count();
    let sheet = SheetIndex::parse(file.to_string(), editable.css);

    if let Some(source_line) = source_line {
        let selector = norm_selector(&matched.selector);
        let source_rule_exists = sheet.rules.iter().any(|rule| {
            rule.selector_line == source_line && norm_selector(&rule.selector) == selector
        });
        return if source_rule_exists {
            Ok(prefix_line_count + source_line)
        } else {
            Err(CommandError::Validation {
                field: "matched".into(),
                reason: format!(
                    "No matching CSS rule was found at line {source_line} in {file}; the source may have changed."
                ),
            })
        };
    }

    let mut pinned_match = matched.clone();
    pinned_match.href = None;
    pinned_match.runtime_identity = None;
    match locate_rule_in_project(root, &[sheet], &pinned_match) {
        RuleLocation::Resolved { line, .. } => Ok(prefix_line_count + line),
        RuleLocation::Multiple { .. } => Err(CommandError::Validation {
            field: "matched".into(),
            reason: format!(
                "More than one matching rule remains in {file}; its exact source line cannot be pinned. Reselect the element and try again."
            ),
        }),
        RuleLocation::NotFound => Err(CommandError::Validation {
            field: "matched".into(),
            reason: format!(
                "No matching CSS rule was found in {file}; the source may have changed. Reselect the element and try again."
            ),
        }),
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

/// Validate the stricter name contract for the variables editor's custom-property
/// creation command. Custom properties must begin with `--` and contain an identifier.
fn validate_custom_property(property: &str) -> Result<(), CommandError> {
    if property.len() <= 2 || !property.starts_with("--") || !property_is_safe(property) {
        return Err(CommandError::Validation {
            field: "property".into(),
            reason: format!("\"{property}\" isn't a valid CSS custom property name"),
        });
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

/// Add a new custom property to the base `:root` scope. Existing base `:root` blocks
/// are reused, including when there is more than one; a new block is created only
/// when the stylesheet has no base `:root` rule.
#[tauri::command]
#[tracing::instrument(skip(value), fields(project = %project_path, file = %file, property = %property))]
pub fn add_css_variable(
    project_path: String,
    file: String,
    property: String,
    value: String,
) -> Result<(), CommandError> {
    validate_custom_property(&property)?;
    validate_declaration(&property, Some(&value))?;
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    let updated = add_custom_property_to_source(&ec.css, &property, &value)?;
    ec.write_back(&root, &updated)?;
    Ok(())
}

/// Update one existing custom property at the exact source rule reported by the
/// variables index, without requiring its selector to be unique in the file.
#[tauri::command]
#[tracing::instrument(skip(value), fields(project = %project_path, file = %file, selector = %selector, line, property = %property))]
pub fn set_css_variable(
    project_path: String,
    file: String,
    selector: String,
    line: usize,
    property: String,
    value: String,
) -> Result<(), CommandError> {
    validate_custom_property(&property)?;
    validate_declaration(&property, Some(&value))?;
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    let updated = set_custom_property_in_source(&ec.css, &selector, line, &property, &value)?;
    ec.write_back(&root, &updated)?;
    Ok(())
}

/// Reorder custom-property declarations within the exact `:root` rule reported
/// by `get_css_variables`. It never moves declarations across source rules.
#[tauri::command]
#[tracing::instrument(skip(ordered), fields(project = %project_path, file = %file, selector = %selector, line))]
pub fn reorder_css_variables(
    project_path: String,
    file: String,
    selector: String,
    line: usize,
    ordered: Vec<CssVariableOrderEntry>,
) -> Result<(), CommandError> {
    if selector != ":root" {
        return Err(CommandError::Validation {
            field: "selector".into(),
            reason: "only variables defined on an exact :root rule can be reordered".into(),
        });
    }
    validate_variable_order_entries(&file, &selector, line, &ordered)?;
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    let updated = reorder_custom_properties_in_source(&ec.css, &selector, line, &ordered)?;
    ec.write_back(&root, &updated)?;
    Ok(())
}

/// Count the authored impact of deleting a project CSS variable without changing
/// any files. The replacement value comes from the selected Variables-panel row
/// and is checked against every definition so conflicting cascade values fail closed.
#[tauri::command]
#[tracing::instrument(skip(replacement_value), fields(project = %project_path, property = %property))]
pub fn analyze_css_variable_deletion(
    project_path: String,
    property: String,
    replacement_value: String,
) -> Result<CssVariableDeleteImpact, CommandError> {
    validate_custom_property(&property)?;
    validate_declaration(&property, Some(&replacement_value))?;
    let root = validate_project_path(&project_path)?;
    let (impact, _) = prepare_css_variable_deletion(&root, &property, &replacement_value)?;
    Ok(impact)
}

/// Inline a custom property's raw value at every authored `var()` reference and
/// remove all of its definitions. Files are prepared before any write; if a write
/// fails, already-written files are restored from their in-memory originals.
#[tauri::command]
#[tracing::instrument(skip(replacement_value), fields(project = %project_path, property = %property))]
pub fn delete_css_variable(
    project_path: String,
    property: String,
    replacement_value: String,
    expected_usage_count: usize,
    expected_definition_count: usize,
) -> Result<CssVariableDeleteImpact, CommandError> {
    validate_custom_property(&property)?;
    validate_declaration(&property, Some(&replacement_value))?;
    let root = validate_project_path(&project_path)?;
    let (impact, changes) = prepare_css_variable_deletion(&root, &property, &replacement_value)?;
    if impact.usage_count != expected_usage_count
        || impact.definition_count != expected_definition_count
    {
        return Err(CommandError::Validation {
            field: "property".into(),
            reason: "the variable changed after the confirmation opened — review the updated impact and try again"
                .into(),
        });
    }

    let _write_guard = EDITABLE_CSS_WRITE_LOCK
        .lock()
        .map_err(|_| CommandError::Other {
            message: "CSS write coordination lock was poisoned".into(),
        })?;
    for change in &changes {
        let current = std::fs::read_to_string(&change.path).map_err(CommandError::from)?;
        if current != change.original {
            return Err(CommandError::Validation {
                field: "css".into(),
                reason: "source changed before the edit could be written — review the impact again"
                    .into(),
            });
        }
    }

    let mut written = Vec::new();
    for change in &changes {
        if let Err(error) = std::fs::write(&change.path, &change.updated) {
            for completed in written.into_iter().rev() {
                let completed: &CssVariableDeleteChange = completed;
                let _ = std::fs::write(&completed.path, &completed.original);
            }
            return Err(CommandError::from(error));
        }
        written.push(change);
    }
    invalidate_sheet_cache(&root);
    crate::commands::edit::invalidate_index_cache(&root);
    Ok(impact)
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
) -> Result<CssRuleSourceIdentity, CommandError> {
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
    let target = norm_selector(&selector);
    let identity = index_rules(&out)
        .into_iter()
        .filter(|candidate| candidate.selector_start >= ec.css.len())
        .find_map(|candidate| {
            let members = normalized_selector_parts(&candidate.selector);
            if members.len() != 1 || members.first() != Some(&target) {
                return None;
            }
            css_rule_mutations::identity_for_rule(&file, &out, &candidate, 0, &selector)
        })
        .ok_or_else(|| CommandError::Validation {
            field: "selector".into(),
            reason: "new rules must use one selector-list member so later edits stay pinned".into(),
        })?;
    ec.write_back(&root, &out)?;
    Ok(identity)
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

/// True when `class` is defined by any rule in the project's stylesheets — the
/// stylesheet half of the generated-class collision check
/// (see `edit_structure::generate_class`; the class-literal index is the other half).
pub(crate) fn css_class_exists(root: &Path, class: &str) -> bool {
    cached_sheets(root).iter().any(|sheet| {
        sheet
            .rules
            .iter()
            .any(|rule| class_names_in(&rule.selector).iter().any(|c| c == class))
    })
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
    /// One-based selector line, used to pin edits to this exact source rule.
    pub line: usize,
}

/// Every custom-property definition across the project's stylesheets, in document
/// order (so the UI can keep last-wins semantics). `:root` and selector-scoped
/// definitions can be edited by exact source identity; structural actions stay
/// with root definitions in the Variables editor.
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
                        line: rule.selector_line,
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
pub async fn locate_css_rules(
    project_path: String,
    matched: Vec<MatchedRuleQuery>,
) -> Result<Vec<RuleLocation>, CommandError> {
    let root = validate_project_path(&project_path)?;
    // Filesystem discovery and parsing must not block Tauri's UI thread.
    tokio::task::spawn_blocking(move || {
        let sheets = cached_sheets(&root);
        matched
            .iter()
            .map(|q| locate_rule_in_project(&root, &sheets, q))
            .collect()
    })
    .await
    .map_err(|e| CommandError::Other {
        message: format!("CSS rule lookup task failed: {e}"),
    })
}

/// Resolve one displayed cascade match in a specific candidate source file.
/// Embedded Astro CSS returns the selector's physical line in the `.astro` host.
#[tauri::command]
#[tracing::instrument(
    skip(matched),
    fields(project = %project_path, file = %file, selector = %matched.selector)
)]
pub async fn resolve_css_source_line(
    project_path: String,
    file: String,
    matched: MatchedRuleQuery,
    source_line: Option<usize>,
) -> Result<usize, CommandError> {
    let root = validate_project_path(&project_path)?;
    tokio::task::spawn_blocking(move || {
        resolve_css_source_line_in_file_at_source_line(&root, &file, &matched, source_line)
    })
    .await
    .map_err(|e| CommandError::Other {
        message: format!("CSS source line lookup task failed: {e}"),
    })?
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
    source_identity: CssRuleSourceIdentity,
) -> Result<CssRuleSourceIdentity, CommandError> {
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
    if source_identity.inner_text != old_inner
        || norm_selector(&selector) != source_identity.matched_selector
    {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the selected rule identity changed — reselect to edit".into(),
        });
    }
    let target = css_rule_mutations::resolve_identity(&file, &ec.css, &source_identity)?;
    if !rule_selector_matches(&target.selector, &selector)
        || !media_text_matches(&target.media, &media_text)
    {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the selected source occurrence no longer matches this rule".into(),
        });
    }
    let (updated, next_identity) =
        css_rule_mutations::apply_body(&file, &ec.css, &source_identity, &new_inner)?;
    ec.write_back(&root, &updated)?;
    Ok(next_identity)
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
    source_identity: CssRuleSourceIdentity,
    remove_member_only: bool,
) -> Result<(), CommandError> {
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    if source_identity.inner_text != old_inner
        || norm_selector(&selector) != source_identity.matched_selector
    {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the selected rule identity changed — reselect to edit".into(),
        });
    }
    let target = css_rule_mutations::resolve_identity(&file, &ec.css, &source_identity)?;
    if !rule_selector_matches(&target.selector, &selector)
        || !media_text_matches(&target.media, &media_text)
    {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the selected source occurrence no longer matches this rule".into(),
        });
    }
    let updated = if remove_member_only {
        css_rule_mutations::remove_member(&file, &ec.css, &source_identity)?.0
    } else {
        css_rule_mutations::delete_rule(&file, &ec.css, &source_identity)?
    };
    ec.write_back(&root, &updated)?;
    Ok(())
}

/// Delete an exact batch from one unchanged sheet snapshot. A media-group delete
/// is one atomic source edit so each member identity is validated before offsets move.
#[tauri::command]
#[tracing::instrument(skip(source_identities), fields(project = %project_path, file = %file))]
pub fn delete_css_rules(
    project_path: String,
    file: String,
    source_identities: Vec<CssRuleSourceIdentity>,
) -> Result<(), CommandError> {
    let root = validate_project_path(&project_path)?;
    let editable = load_editable_css(&root, &file)?;
    let updated = css_rule_mutations::delete_rules(&file, &editable.css, &source_identities)?;
    editable.write_back(&root, &updated)?;
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
    source_identity: CssRuleSourceIdentity,
) -> Result<CssRuleSourceIdentity, CommandError> {
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    if source_identity.inner_text != old_inner
        || norm_selector(&selector) != source_identity.matched_selector
    {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the selected rule identity changed — reselect to edit".into(),
        });
    }
    let target = css_rule_mutations::resolve_identity(&file, &ec.css, &source_identity)?;
    if !rule_selector_matches(&target.selector, &selector)
        || !media_text_matches(&target.media, &media_text)
    {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the selected source occurrence no longer matches this rule".into(),
        });
    }
    let (updated, next_identity) =
        css_rule_mutations::wrap_rule(&file, &ec.css, &source_identity, &at_prelude)?;
    ec.write_back(&root, &updated)?;
    Ok(next_identity)
}

/// Change the full selector list of the exact rule, drift-guarded against its source identity.
#[tauri::command]
#[tracing::instrument(skip(old_inner), fields(project = %project_path, file = %file, selector = %selector, new = %new_selector))]
pub fn rename_css_selector(
    project_path: String,
    file: String,
    selector: String,
    media_text: Option<String>,
    old_inner: String,
    new_selector: String,
    source_identity: CssRuleSourceIdentity,
) -> Result<CssRuleSourceIdentity, CommandError> {
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    if source_identity.inner_text != old_inner
        || norm_selector(&selector) != source_identity.matched_selector
    {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the selected rule identity changed — reselect to edit".into(),
        });
    }
    let target = css_rule_mutations::resolve_identity(&file, &ec.css, &source_identity)?;
    if !rule_selector_matches(&target.selector, &selector)
        || !media_text_matches(&target.media, &media_text)
    {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the selected source occurrence no longer matches this rule".into(),
        });
    }
    let (updated, next_identity) =
        css_rule_mutations::replace_selector_list(&file, &ec.css, &source_identity, &new_selector)?;
    ec.write_back(&root, &updated)?;
    Ok(next_identity)
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
    source_identity: CssRuleSourceIdentity,
) -> Result<css_rule_mutations::CssAtRuleRenameResult, CommandError> {
    let root = validate_project_path(&project_path)?;
    let ec = load_editable_css(&root, &file)?;
    if source_identity.inner_text != old_inner
        || norm_selector(&selector) != source_identity.matched_selector
    {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the selected rule identity changed — reselect to edit".into(),
        });
    }
    let target = css_rule_mutations::resolve_identity(&file, &ec.css, &source_identity)?;
    if !rule_selector_matches(&target.selector, &selector)
        || !media_text_matches(&target.media, &media_text)
    {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the selected source occurrence no longer matches this rule".into(),
        });
    }
    let (updated, rename_result) =
        css_rule_mutations::rename_media(&file, &ec.css, &source_identity, &new_media)?;
    ec.write_back(&root, &updated)?;
    Ok(rename_result)
}

/// Separate one selector-list member into an adjacent rule with the same body and context.
#[tauri::command]
#[tracing::instrument(skip(source_identity), fields(project = %project_path, file = %file, selector = %selector))]
pub fn make_css_selector_independent(
    project_path: String,
    file: String,
    selector: String,
    source_identity: CssRuleSourceIdentity,
) -> Result<CssRuleSourceIdentity, CommandError> {
    let root = validate_project_path(&project_path)?;
    let editable = load_editable_css(&root, &file)?;
    if norm_selector(&selector) != source_identity.matched_selector {
        return Err(CommandError::Validation {
            field: "selector".into(),
            reason: "the selected selector changed — reselect to edit".into(),
        });
    }
    let (updated, identity) =
        css_rule_mutations::make_independent(&file, &editable.css, &source_identity)?;
    editable.write_back(&root, &updated)?;
    Ok(identity)
}

/// Split every selector in one exact selector list into adjacent source rules.
#[tauri::command]
#[tracing::instrument(skip(source_identity), fields(project = %project_path, file = %file))]
pub fn split_css_selector_list(
    project_path: String,
    file: String,
    source_identity: CssRuleSourceIdentity,
) -> Result<css_rule_mutations::CssRuleSelectorListSplitResult, CommandError> {
    let root = validate_project_path(&project_path)?;
    let editable = load_editable_css(&root, &file)?;
    let (updated, result) =
        css_rule_mutations::split_selector_list(&file, &editable.css, &source_identity)?;
    editable.write_back(&root, &updated)?;
    Ok(result)
}

/// Prepare safe, reviewable adjacent-rule consolidations for plain CSS files.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn review_css_consolidations(
    project_path: String,
) -> Result<CssConsolidationReview, CommandError> {
    let root = validate_project_path(&project_path)?;
    let sheets = cached_sheets(&root);
    let mut candidates = Vec::new();
    for sheet in sheets.iter() {
        if !sheet.rel.ends_with(".css")
            || sheet.rel.contains('?')
            || is_generated_public_site(&root, &sheet.rel)
        {
            continue;
        }
        candidates.extend(
            css_rule_mutations::review_consolidations(&sheet.rel, &sheet.content).candidates,
        );
    }
    let unavailable_reason = candidates.is_empty().then(|| {
        "No safe adjacent rules were found. Review supports only exact selector lists in plain, unlayered stylesheets with declaration-only bodies.".to_string()
    });
    Ok(CssConsolidationReview {
        candidates,
        unavailable_reason,
    })
}

/// Atomically apply one reviewed consolidation after revalidating its complete source snapshot.
#[tauri::command]
#[tracing::instrument(skip(candidate), fields(project = %project_path, file = %candidate.file))]
pub fn apply_css_consolidation(
    project_path: String,
    candidate: CssConsolidationCandidate,
) -> Result<(), CommandError> {
    let root = validate_project_path(&project_path)?;
    if !candidate.file.ends_with(".css")
        || candidate.file.contains('?')
        || is_generated_public_site(&root, &candidate.file)
    {
        return Err(CommandError::Validation {
            field: "file".into(),
            reason: "safe consolidation is available only for authored plain CSS files".into(),
        });
    }
    let editable = load_editable_css(&root, &candidate.file)?;
    let updated =
        css_rule_mutations::apply_consolidation(&candidate.file, &editable.css, &candidate)?;
    editable.write_back(&root, &updated)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_custom_props_finds_definitions_not_usages() {
        let css = ":root {\n  --accent: #fff;\n  --gap: 8px;\n}\n\
                   .btn { color: var(--accent-active); padding: var(--gap); --local: 1; }";
        let mut set = std::collections::BTreeSet::new();
        collect_custom_props(css, &mut set);
        let got: Vec<_> = set.into_iter().collect();
        // --accent, --gap, --local are definitions; the var(--accent-active)/var(--gap)
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
    fn selection_lookup_preserves_lines_and_bodies_in_large_stylesheets() {
        let mut css = String::from("/* heading\n   café */\n");
        for i in 0..4000 {
            css.push_str(&format!(
                "@media (min-width: 768px) {{\n/* rule */\n.r{i} {{ color: red; }}\n}}\n"
            ));
        }
        let sheet = SheetIndex::parse("large.css".into(), css.clone());
        assert_eq!(sheet.rules.len(), 4000);
        for (i, rule) in sheet.rules.iter().enumerate() {
            assert_eq!(rule.selector_line, 5 + i * 4);
            assert_eq!(
                &css[rule.block_inner_start..rule.block_inner_end],
                " color: red; "
            );
        }
        assert!(matches!(
            locate_rule(&[sheet], &query(".r3999", Some("(min-width:768px)"), None)),
            RuleLocation::Resolved { line: 16001, .. }
        ));
    }

    #[test]
    fn selection_lookup_indexes_groups_without_duplicating_rules() {
        let sheets = idx(vec![(
            "site.css".into(),
            ".a>.b, .a > .b, :is(.x,.y) { color: red; }\n.a>.b { color: blue; }".into(),
        )]);
        assert_eq!(sheets[0].selectors[".a>.b"], vec![0, 1]);
        assert!(matches!(
            locate_rule(&sheets, &query(".a > .b", None, None)),
            RuleLocation::Multiple { .. }
        ));
        assert!(matches!(
            locate_rule(&sheets, &query(":is(.x, .y)", None, None)),
            RuleLocation::Resolved { line: 1, .. }
        ));
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

    fn variable_order_entry(name: &str, line: usize) -> CssVariableOrderEntry {
        CssVariableOrderEntry {
            name: name.into(),
            file: "styles.css".into(),
            selector: ":root".into(),
            line,
        }
    }

    #[test]
    fn reorders_variables_without_reserializing_other_source() {
        let css = ":root {\n  /* keep this comment */\n  --first: red !important;\n  color: red;\n\n  --second : blue;\n}";
        let out = reorder_custom_properties_in_source(
            css,
            ":root",
            1,
            &[
                variable_order_entry("--second", 1),
                variable_order_entry("--first", 1),
            ],
        )
        .unwrap();
        assert_eq!(
            out,
            ":root {\n  /* keep this comment */\n  --second : blue;\n  color: red;\n\n  --first: red !important;\n}"
        );
    }

    #[test]
    fn rejects_stale_duplicate_and_ambiguous_variable_orders() {
        let css = ":root { --first: red; --second: blue; }";
        let stale = reorder_custom_properties_in_source(
            css,
            ":root",
            1,
            &[variable_order_entry("--first", 1)],
        )
        .unwrap_err();
        assert!(matches!(stale, CommandError::Validation { field, .. } if field == "ordered"));

        let added = reorder_custom_properties_in_source(
            css,
            ":root",
            1,
            &[
                variable_order_entry("--first", 1),
                variable_order_entry("--new", 1),
            ],
        )
        .unwrap_err();
        assert!(matches!(added, CommandError::Validation { field, .. } if field == "ordered"));

        let duplicate = reorder_custom_properties_in_source(
            css,
            ":root",
            1,
            &[
                variable_order_entry("--first", 1),
                variable_order_entry("--first", 1),
            ],
        )
        .unwrap_err();
        assert!(matches!(duplicate, CommandError::Validation { field, .. } if field == "ordered"));

        let ambiguous = reorder_custom_properties_in_source(
            ":root { --first: red; } :root { --second: blue; }",
            ":root",
            1,
            &[variable_order_entry("--first", 1)],
        )
        .unwrap_err();
        assert!(matches!(ambiguous, CommandError::Validation { field, .. } if field == "variable"));
    }

    #[test]
    fn rejects_an_order_that_crosses_source_rules() {
        let mut cross_rule = variable_order_entry("--second", 1);
        cross_rule.line = 2;
        let err = validate_variable_order_entries(
            "styles.css",
            ":root",
            1,
            &[variable_order_entry("--first", 1), cross_rule],
        )
        .unwrap_err();
        assert!(matches!(err, CommandError::Validation { field, .. } if field == "ordered"));
    }

    #[test]
    fn rejects_duplicate_source_definitions() {
        let err = reorder_custom_properties_in_source(
            ":root { --first: red; --first: blue; }",
            ":root",
            1,
            &[
                variable_order_entry("--first", 1),
                variable_order_entry("--first", 1),
            ],
        )
        .unwrap_err();
        assert!(matches!(err, CommandError::Validation { field, .. } if field == "variable"));
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
            selector_member_index: None,
            context_path: None,
            identity_declarations: None,
            runtime_identity: None,
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

    #[test]
    fn adds_a_variable_to_the_last_base_root_rule_when_roots_are_duplicated() {
        let css = ":root {\n  --first: red;\n}\n\
                   @media (prefers-color-scheme: dark) {\n  :root {\n    --dark: black;\n  }\n}\n\
                   :root {\n  --second: blue;\n}";
        let out = add_custom_property_to_source(css, "--new", "green").unwrap();
        assert_eq!(
            out,
            ":root {\n  --first: red;\n}\n\
             @media (prefers-color-scheme: dark) {\n  :root {\n    --dark: black;\n  }\n}\n\
             :root {\n  --second: blue;\n  --new: green;\n}"
        );
    }

    #[test]
    fn creates_a_base_root_rule_when_only_conditional_root_exists() {
        let css = "@media (prefers-color-scheme: dark) { :root { --dark: black; } }";
        let out = add_custom_property_to_source(css, "--new", "green").unwrap();
        assert_eq!(
            out,
            "@media (prefers-color-scheme: dark) { :root { --dark: black; } }\n\n\
             :root {\n  --new: green;\n}\n"
        );
    }

    #[test]
    fn refuses_to_add_a_duplicate_root_variable() {
        let css = ":root { --existing: red; }\n:root { --other: blue; }";
        let err = add_custom_property_to_source(css, "--existing", "green").unwrap_err();
        assert!(matches!(
            err,
            CommandError::Validation { field, reason }
                if field == "property" && reason == "a variable with this name already exists"
        ));
    }

    #[test]
    fn adds_a_base_definition_for_a_variable_that_only_exists_under_media() {
        // The duplicate check used to scan media-scoped `:root` blocks that the
        // insertion never writes to, so a dark-mode-only token could never be
        // given the base definition the UI was offering to add.
        let css = "@media (prefers-color-scheme: dark) {\n  :root {\n    --brand: black;\n  }\n}\n\
                   :root {\n  --other: blue;\n}\n";
        let out = add_custom_property_to_source(css, "--brand", "white").unwrap();
        assert_eq!(
            out,
            "@media (prefers-color-scheme: dark) {\n  :root {\n    --brand: black;\n  }\n}\n\
             :root {\n  --other: blue;\n  --brand: white;\n}\n"
        );
    }

    #[test]
    fn creates_a_base_root_for_a_variable_that_only_exists_under_media() {
        // Same divergence, taken to the point where it made the "no base
        // `:root` at all" fallback unreachable.
        let css = "@media (prefers-color-scheme: dark) { :root { --dark: black; } }";
        let out = add_custom_property_to_source(css, "--dark", "white").unwrap();
        assert_eq!(
            out,
            "@media (prefers-color-scheme: dark) { :root { --dark: black; } }\n\n\
             :root {\n  --dark: white;\n}\n"
        );
    }

    #[test]
    fn updates_a_variable_in_its_pinned_root_rule() {
        let css = ":root {\n  --first: red;\n}\n:root {\n  --second: white;\n}";
        let second_root_line = index_rules(css)[1].selector_line;
        let out = set_custom_property_in_source(
            css,
            ":root",
            second_root_line,
            "--second",
            "transparent",
        )
        .unwrap();

        assert!(out.contains("--first: red;"));
        assert!(out.contains("--second: transparent;"));
        assert!(!out.contains("--second: white;"));
    }

    #[test]
    fn updates_a_scoped_variable_in_its_pinned_media_rule() {
        let css = ".theme { --surface: white; }\n\
                   @media (prefers-color-scheme: dark) {\n\
                     .theme { --surface: black; }\n\
                   }";
        let dark_rule = index_rules(css)
            .into_iter()
            .find(|rule| rule.selector == ".theme" && rule.selector_line > 1)
            .unwrap();
        let out = set_custom_property_in_source(
            css,
            ".theme",
            dark_rule.selector_line,
            "--surface",
            "#101010",
        )
        .unwrap();

        assert!(out.contains(".theme { --surface: white; }"));
        assert!(out.contains(".theme { --surface: #101010; }"));
        assert!(!out.contains("--surface: black;"));
    }

    #[test]
    fn refuses_to_update_same_line_duplicate_selector_rules() {
        let css = ".theme { --surface: white; } .theme { --surface: black; }";
        let line = index_rules(css)[0].selector_line;
        let error =
            set_custom_property_in_source(css, ".theme", line, "--surface", "blue").unwrap_err();

        assert!(matches!(error, CommandError::Validation { field, .. } if field == "variable"));
        assert!(css.contains("--surface: white;") && css.contains("--surface: black;"));
    }

    #[test]
    fn distinguishes_different_properties_in_same_line_selector_rules() {
        let css = ".theme { --light: white; } .theme { --dark: black; }";
        let line = index_rules(css)[0].selector_line;
        let out = set_custom_property_in_source(css, ".theme", line, "--dark", "charcoal").unwrap();

        assert!(out.contains(".theme { --light: white; }"));
        assert!(out.contains(".theme { --dark: charcoal; }"));
    }

    #[test]
    fn inlines_complete_var_functions_and_removes_the_definition() {
        let css = ":root {\n  --space: 8px;\n}\n\
                   .card { gap: var(--space); content: \"var(--space)\"; }\n\
                   .stack { margin: calc(var( --space, 2px) * 2); }\n\
                   /* var(--space) */";
        let (out, usages, rules, definitions, values) =
            inline_and_remove_custom_property(css, "--space", "8px");

        assert_eq!(usages, 2);
        assert_eq!(rules, 2);
        assert_eq!(definitions, 1);
        assert_eq!(values, vec!["8px"]);
        assert_eq!(
            out,
            ":root {\n}\n\
             .card { gap: 8px; content: \"var(--space)\"; }\n\
             .stack { margin: calc(8px * 2); }\n\
             /* var(--space) */"
        );
    }

    #[test]
    fn inlines_custom_property_references_in_static_class_literals() {
        let source = r#"<div className="text-[var(--accent)] md:bg-[var(--accent)]">Hello</div>
<p className="text-[var(--accent)]">World</p>"#;
        let (out, usages, rules) = replace_custom_property_in_class_literals(
            source,
            "src/Page.tsx",
            "--accent",
            "hsla(0, 100%, 50%, 0.8)",
        );

        assert_eq!(usages, 3);
        assert_eq!(rules.len(), 2);
        assert!(out.contains("text-[hsla(0,_100%,_50%,_0.8)]"));
        assert!(out.contains("md:bg-[hsla(0,_100%,_50%,_0.8)]"));
        assert!(!out.contains("var(--accent)"));
    }

    #[test]
    fn inlines_custom_property_references_in_tailwind_apply_values() {
        let css = ".button { @apply text-[var(--accent)]; }";
        let (out, usages, rules, definitions, values) =
            inline_and_remove_custom_property(css, "--accent", "hsl(0, 100%, 50%)");

        assert_eq!(usages, 1);
        assert_eq!(rules, 1);
        assert_eq!(definitions, 0);
        assert!(values.is_empty());
        assert!(out.contains("text-[hsl(0,_100%,_50%)]"));
    }

    #[test]
    fn deletion_preparation_includes_tailwind_markup_usage() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("styles.css"),
            ":root { --accent: hsl(0, 100%, 50%); }\n",
        )
        .unwrap();
        std::fs::write(
            root.join("src/Page.tsx"),
            r#"export function Page() {
  return <div className="text-[var(--accent)]">Hello</div>;
}
"#,
        )
        .unwrap();

        let (impact, changes) =
            prepare_css_variable_deletion(root, "--accent", "hsl(0, 100%, 50%)").unwrap();

        assert_eq!(impact.usage_count, 1);
        assert_eq!(impact.rule_count, 1);
        assert_eq!(impact.file_count, 1);
        assert_eq!(impact.definition_count, 1);
        let source = changes
            .iter()
            .find(|change| change.path.ends_with("src/Page.tsx"))
            .expect("component source should be rewritten");
        assert!(source.updated.contains("text-[hsl(0,_100%,_50%)]"));
        assert!(!source.updated.contains("var(--accent)"));
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
            selector_member_index: None,
            context_path: None,
            identity_declarations: None,
            runtime_identity: None,
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
                ..
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
    fn cssom_declaration_evidence_is_a_conservative_tiebreaker() {
        let declaration = |property: &str, value: &str, important| Declaration {
            property: property.into(),
            value: value.into(),
            important,
        };

        // Value whitespace outside strings is normalized, while meaningful quoted
        // whitespace and escaped quotes remain part of the evidence.
        let whitespace_css = ".text { font-family:  'Geist  Mono'   ,   sans-serif; }\n";
        let whitespace_rule = index_rules(whitespace_css).remove(0);
        assert!(declaration_evidence_matches(
            whitespace_css,
            &whitespace_rule,
            Some(&[declaration(
                "font-family",
                "'Geist  Mono' , sans-serif",
                false,
            )]),
        ));
        let escaped_css = r#".escaped { content: 'a\'  b'; }"#;
        let escaped_rule = index_rules(escaped_css).remove(0);
        assert!(declaration_evidence_matches(
            escaped_css,
            &escaped_rule,
            Some(&[declaration("content", r#"'a\'  b'"#, false)]),
        ));

        // The CSSOM may expand a shorthand such as `font` into a longer longhand
        // list. A unique selector/context candidate still resolves without inventing
        // a property-specific expansion table.
        let font_css = ".font { font: italic 400 16px/1.5 Geist, sans-serif; }\n";
        let font_runtime = vec![
            declaration("font-style", "italic", false),
            declaration("font-weight", "400", false),
            declaration("font-size", "16px", false),
            declaration("line-height", "1.5", false),
            declaration("font-family", "Geist, sans-serif", false),
        ];
        let font_rule = index_rules(font_css).remove(0);
        assert!(!declaration_evidence_matches(
            font_css,
            &font_rule,
            Some(&font_runtime),
        ));
        let mut font_query = query(".font", None, None);
        font_query.selector_member_index = Some(0);
        font_query.context_path = Some(Vec::new());
        font_query.identity_declarations = Some(font_runtime);
        assert!(matches!(
            locate_rule(
                &idx(vec![("font.css".into(), font_css.into())]),
                &font_query
            ),
            RuleLocation::Resolved { .. }
        ));

        // Evidence still distinguishes duplicates when it matches a real candidate,
        // including the important bit; if it matches none, identical structural
        // candidates remain read-only instead of choosing by order.
        let priority_css = ".priority { color: red; }\n.priority { color: red !important; }\n";
        let mut priority_query = query(".priority", None, None);
        priority_query.selector_member_index = Some(0);
        priority_query.context_path = Some(Vec::new());
        priority_query.identity_declarations = Some(vec![declaration("color", "red", true)]);
        assert!(matches!(
            locate_rule(
                &idx(vec![("priority.css".into(), priority_css.into())]),
                &priority_query
            ),
            RuleLocation::Resolved { line: 2, .. }
        ));
        priority_query.identity_declarations = Some(vec![declaration("color", "blue", false)]);
        assert!(matches!(
            locate_rule(
                &idx(vec![("priority.css".into(), priority_css.into())]),
                &priority_query
            ),
            RuleLocation::Multiple { rule_count: 2, .. }
        ));

        // A selector-list member index is preserved independently of which rule's
        // declaration evidence wins the duplicate-selector tie.
        let grouped_css = ".item, .peer { color: red; }\n.item { color: blue; }\n";
        let mut item_query = query(".item", None, None);
        item_query.selector_member_index = Some(0);
        item_query.context_path = Some(Vec::new());
        item_query.identity_declarations = Some(vec![declaration("color", "blue", false)]);
        let grouped_sheet = idx(vec![("grouped.css".into(), grouped_css.into())]);
        let item_identity = match locate_rule(&grouped_sheet, &item_query) {
            RuleLocation::Resolved {
                source_identity: Some(identity),
                ..
            } => identity,
            other => panic!("matching declarations should identify the .item rule, got {other:?}"),
        };
        assert_eq!(
            item_identity.selector_offset,
            grouped_css.rfind(".item").unwrap()
        );
        assert_eq!(item_identity.selector_member_index, 0);

        let mut peer_query = query(".peer", None, None);
        peer_query.selector_member_index = Some(1);
        peer_query.context_path = Some(Vec::new());
        peer_query.identity_declarations = Some(vec![declaration("color", "red", false)]);
        let peer_identity = match locate_rule(&grouped_sheet, &peer_query) {
            RuleLocation::Resolved {
                source_identity: Some(identity),
                ..
            } => identity,
            other => panic!("the indexed selector-list member should resolve, got {other:?}"),
        };
        assert_eq!(peer_identity.selector_member_index, 1);
        assert_eq!(peer_identity.selector_members, vec![".item", ".peer"]);

        // An all-mismatch shorthand family with two exact selector/context hits is
        // deliberately ambiguous, not NotFound and not an arbitrary source choice.
        let duplicate_gap_css = ".top-stack { gap: 100px; }\n.top-stack { gap: 100px; }\n";
        let mut gap_query = query(".top-stack", None, None);
        gap_query.selector_member_index = Some(0);
        gap_query.context_path = Some(Vec::new());
        gap_query.identity_declarations = Some(vec![
            declaration("row-gap", "100px", false),
            declaration("column-gap", "100px", false),
        ]);
        assert!(matches!(
            locate_rule(
                &idx(vec![("duplicate-gap.css".into(), duplicate_gap_css.into())]),
                &gap_query
            ),
            RuleLocation::Multiple { rule_count: 2, .. }
        ));
    }

    #[test]
    fn cssom_inherited_font_evidence_selects_the_exact_grouped_source_rule() {
        const SELECTOR_LIST: &str = ".su-button, .su-input, .su-textarea, .su-select, .su-checkbox, .su-radio, .su-switch, .su-tab, .su-dialog__close";
        const CSSOM_FONT_LONGHANDS: &[&str] = &[
            "font-style",
            "font-variant-caps",
            "font-weight",
            "font-width",
            "font-size",
            "line-height",
            "font-family",
            "font-size-adjust",
            "font-kerning",
            "font-variant-alternates",
            "font-variant-ligatures",
            "font-variant-numeric",
            "font-variant-east-asian",
            "font-feature-settings",
            "font-optical-sizing",
            "font-variation-settings",
        ];
        let runtime_evidence: Vec<_> = CSSOM_FONT_LONGHANDS
            .iter()
            .map(|property| Declaration {
                property: (*property).into(),
                value: "inherit".into(),
                important: false,
            })
            .collect();
        let source = concat!(
            "@import \"@somacra/tokens/styles.css\";\n\n",
            ".su-button, .su-input, .su-textarea, .su-select, .su-checkbox, .su-radio, .su-switch, .su-tab, .su-dialog__close { font: inherit; }\n",
            ".su-button { display: inline-flex; min-height: 40px; align-items: center; justify-content: center; gap: var(--space-2); padding: 0 var(--space-4); border: 1px solid transparent; border-radius: var(--radius-sm); line-height: 1; text-decoration: none; cursor: pointer; transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast); }\n",
        );
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        let source_path = root.join("packages/ui/src/styles.css");
        std::fs::create_dir_all(source_path.parent().unwrap()).unwrap();
        std::fs::write(&source_path, source).unwrap();
        let href = format!("http://localhost:43127/@fs{}?direct", source_path.display());
        let mut matched = query(".su-button", None, Some(&href));
        matched.selector_member_index = Some(0);
        matched.context_path = Some(Vec::new());
        matched.identity_declarations = Some(runtime_evidence.clone());

        let sheets = idx(discover_stylesheets(root));
        let identity = match locate_rule_in_project(root, &sheets, &matched) {
            RuleLocation::Resolved {
                file,
                line,
                inner_text,
                source_identity: Some(identity),
                ..
            } => {
                assert_eq!(file, "packages/ui/src/styles.css");
                assert_eq!(line, 3);
                assert_eq!(inner_text, " font: inherit; ");
                identity
            }
            other => panic!(
                "the CSSOM font expansion should select the grouped source rule, got {other:?}"
            ),
        };
        assert_eq!(identity.selector, SELECTOR_LIST);
        assert_eq!(identity.selector_member_index, 0);
        assert_eq!(identity.matched_selector, ".su-button");

        // Property enumeration order may vary, and browsers can omit optional font
        // longhands. The core font members remain required and every observed member
        // must still carry the same CSS-wide value and priority.
        let grouped_rule = index_rules(source)
            .into_iter()
            .find(|rule| rule.selector == SELECTOR_LIST)
            .unwrap();
        let mut reordered = runtime_evidence.clone();
        reordered.reverse();
        assert!(declaration_evidence_matches(
            source,
            &grouped_rule,
            Some(&reordered)
        ));
        let without_optional: Vec<_> = runtime_evidence
            .iter()
            .filter(|declaration| {
                !matches!(
                    declaration.property.as_str(),
                    "font-size-adjust" | "font-variant-alternates"
                )
            })
            .cloned()
            .collect();
        assert!(declaration_evidence_matches(
            source,
            &grouped_rule,
            Some(&without_optional)
        ));
        let mut wrong_priority = runtime_evidence.clone();
        wrong_priority[0].important = true;
        assert!(!declaration_evidence_matches(
            source,
            &grouped_rule,
            Some(&wrong_priority)
        ));
        let mut all_important = runtime_evidence.clone();
        for declaration in &mut all_important {
            declaration.important = true;
        }
        let important_source = ".font { font: inherit !important; }";
        let important_rule = index_rules(important_source).remove(0);
        assert!(declaration_evidence_matches(
            important_source,
            &important_rule,
            Some(&all_important)
        ));
        let explicit_longhands = concat!(
            ".font { font-style: inherit; font-weight: inherit; font-size: inherit; ",
            "line-height: inherit; font-family: inherit; }"
        );
        let explicit_rule = index_rules(explicit_longhands).remove(0);
        assert!(!declaration_evidence_matches(
            explicit_longhands,
            &explicit_rule,
            Some(&runtime_evidence)
        ));
        let without_core: Vec<_> = runtime_evidence
            .iter()
            .filter(|declaration| declaration.property != "font-family")
            .cloned()
            .collect();
        assert!(!declaration_evidence_matches(
            source,
            &grouped_rule,
            Some(&without_core)
        ));

        // Matching declaration evidence still cannot choose between identical source
        // occurrences in the exact same stylesheet.
        let duplicate_source = format!(
            "@import \"@somacra/tokens/styles.css\";\n\n{SELECTOR_LIST} {{ font: inherit; }}\n{SELECTOR_LIST} {{ font: inherit; }}\n"
        );
        std::fs::write(&source_path, duplicate_source).unwrap();
        let duplicate_sheets = idx(discover_stylesheets(root));
        assert!(matches!(
            locate_rule_in_project(root, &duplicate_sheets, &matched),
            RuleLocation::Multiple { rule_count: 2, .. }
        ));
    }

    #[test]
    fn cssom_media_condition_maps_and_mutates_authored_astro_width_rule() {
        let same_media = |source: &str, browser: &str| {
            media_text_matches(&Some(source.into()), &Some(browser.into()))
        };

        // CSSOM serializes this authored inclusive upper bound as a modern range.
        assert!(same_media("(max-width: 720px)", "(width <= 720px)"));
        assert!(same_media(
            "screen and (max-width: 720px)",
            "screen and (width <= 720px)"
        ));
        assert!(same_media("(min-width: 400px)", "(width >= 400px)"));

        // The canonical form keeps strictness, direction, media type, logic, bounds,
        // and units distinct; it does not interpret or reorder arbitrary queries.
        assert!(!same_media("(max-width: 720px)", "(width < 720px)"));
        assert!(!same_media("(max-width: 720px)", "(width >= 720px)"));
        assert!(!same_media("(min-width: 720px)", "(width <= 720px)"));
        assert!(!same_media("(max-width: 720px)", "(width <= 721px)"));
        assert!(!same_media("(max-width: 720px)", "(width <= 720em)"));
        assert!(!same_media(
            "(min-width: 400px) and (max-width: 720px)",
            "(min-width: 500px) and (max-width: 720px)"
        ));
        assert!(!same_media(
            "screen and (max-width: 720px)",
            "print and (width <= 720px)"
        ));
        assert!(!same_media(
            "screen and (max-width: 720px)",
            "screen or (width <= 720px)"
        ));
        assert!(!same_media(
            "not screen and (max-width: 720px)",
            "screen and (width <= 720px)"
        ));

        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        let page = root.join("src/pages/index.astro");
        std::fs::create_dir_all(page.parent().unwrap()).unwrap();
        let source = concat!(
            "---\n",
            "const pageTitle = \"Personal site\";\n",
            "---\n",
            "<section class=\"intro\">\n",
            "  <div class=\"intro-copy\"></div>\n",
            "</section>\n",
            "<style>\n",
            "  .intro-copy { display: flex; flex-direction: column; align-items: center; gap: 32px; width: 100%; font-size: 22px; line-height: normal; letter-spacing: -0.66px; text-align: center; }\n",
            "  @media (max-width: 720px) {\n",
            "    .intro-copy { gap: 26px; font-size: clamp(18px, 4.8vw, 22px); }\n",
            "  }\n",
            "</style>\n"
        );
        std::fs::write(&page, source).unwrap();

        let sheets = idx(discover_stylesheets(root));
        let browser_match = query(".intro-copy", Some("(width <= 720px)"), None);
        let (file, original_inner) = match locate_rule_in_project(root, &sheets, &browser_match) {
            RuleLocation::Resolved {
                file, inner_text, ..
            } => (file, inner_text),
            other => panic!("expected the Astro media rule to resolve, got {other:?}"),
        };
        assert_eq!(file, "src/pages/index.astro?style=0");
        assert!(original_inner.contains("gap: 26px;"));
        assert!(original_inner.contains("font-size: clamp(18px, 4.8vw, 22px);"));

        // Source navigation returns the selector's physical line in the Astro host.
        let expected_line = source
            .lines()
            .position(|line| line.contains(".intro-copy { gap: 26px;"))
            .unwrap()
            + 1;
        assert_eq!(
            resolve_css_source_line_in_file(root, &file, &browser_match).unwrap(),
            expected_line
        );

        let authored = load_editable_css(root, &file).unwrap();
        let media = browser_match.media_text.clone();
        let edited_inner = original_inner.replace("gap: 26px", "gap: 30px");
        let edited_css = apply_rule_text_to_source(
            &authored.css,
            &browser_match.selector,
            &media,
            &original_inner,
            &edited_inner,
        )
        .unwrap();
        assert!(edited_css.contains("@media (max-width: 720px)"));
        assert!(edited_css.contains("gap: 32px;"));
        assert!(edited_css.contains("gap: 30px;"));
        assert!(!edited_css.contains("gap: 26px;"));

        // Re-locating the saved rule with the old browser string succeeds, and stale
        // editor text is still rejected by the backend's body drift guard.
        assert!(matches!(
            apply_rule_text_to_source(
                &edited_css,
                &browser_match.selector,
                &media,
                &original_inner,
                &edited_inner
            ),
            Err(CommandError::Validation { reason, .. }) if reason.contains("source changed")
        ));
        authored.write_back(root, &edited_css).unwrap();
        let saved_host = std::fs::read_to_string(&page).unwrap();
        assert!(saved_host.contains("@media (max-width: 720px)"));
        assert!(saved_host.contains("gap: 32px;"));
        assert!(saved_host.contains("gap: 30px;"));

        let reloaded = load_editable_css(root, &file).unwrap();
        let saved_sheet = SheetIndex::parse(file.clone(), reloaded.css.clone());
        match locate_rule_in_project(root, &[saved_sheet], &browser_match) {
            RuleLocation::Resolved { inner_text, .. } => assert!(inner_text.contains("gap: 30px;")),
            other => panic!("expected the edited Astro rule to remain locatable, got {other:?}"),
        }
        assert_eq!(
            resolve_css_source_line_in_file(root, &file, &browser_match).unwrap(),
            expected_line
        );

        // The same condition pin reaches delete, selector rename, wrapper, and media
        // rename paths. Each edit targets the responsive rule and keeps source syntax.
        let deleted = remove_rule_from_source(
            &authored.css,
            &browser_match.selector,
            &media,
            &original_inner,
        )
        .unwrap();
        assert!(deleted.contains("gap: 32px;"));
        assert!(!deleted.contains("@media (max-width: 720px)"));

        let renamed = rename_selector_in_source(
            &authored.css,
            &browser_match.selector,
            &media,
            &original_inner,
            ".intro-copy-mobile",
        )
        .unwrap();
        assert!(renamed.contains("@media (max-width: 720px)"));
        assert!(renamed.contains(".intro-copy-mobile { gap: 26px;"));
        assert!(renamed.contains(".intro-copy { display: flex;"));

        let wrapped = wrap_rule_in_source(
            &authored.css,
            &browser_match.selector,
            &media,
            "@supports (display: flex)",
            &original_inner,
        )
        .unwrap();
        assert!(wrapped.contains("@media (max-width: 720px)"));
        assert!(wrapped.contains("@supports (display: flex)"));
        assert!(index_rules(&wrapped).iter().any(|rule| {
            rule_selector_matches(&rule.selector, ".intro-copy")
                && media_text_matches(&rule.media, &media)
                && rule.supports.as_deref() == Some("(display: flex)")
        }));

        let renamed_media = rename_at_rule_in_source(
            &authored.css,
            &browser_match.selector,
            &media,
            &original_inner,
            "(max-width: 680px)",
        )
        .unwrap();
        assert!(renamed_media.contains("@media (max-width: 680px)"));
        assert!(renamed_media.contains("gap: 32px;"));
        assert!(renamed_media.contains("gap: 26px;"));
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
        // The served href's exact project-relative URL pins exactly one file.
        match locate_rule(
            &sheets,
            &query(".dup", None, Some("http://localhost:5173/nested/b.css?v=9")),
        ) {
            RuleLocation::Resolved { file, .. } => assert_eq!(file, "nested/b.css"),
            other => panic!("expected resolved via href, got {other:?}"),
        }
        // An unsupported URL scheme is an explicit external identity. It must not
        // select a local rule merely because the basename happens to be unique.
        assert_eq!(
            locate_rule(
                &sheets,
                &query(".dup", None, Some("legacy://dev/cache/b.css")),
            ),
            RuleLocation::NotFound
        );
    }

    #[test]
    fn source_identity_uses_full_paths_astro_indexes_and_keeps_rule_ambiguity() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src/a")).unwrap();
        std::fs::create_dir_all(root.join("src/b")).unwrap();
        std::fs::create_dir_all(root.join("src/components")).unwrap();
        std::fs::write(root.join("src/a/Theme.css"), ".dup { color: red; }\n").unwrap();
        std::fs::write(root.join("src/b/Theme.css"), ".dup { color: blue; }\n").unwrap();
        std::fs::write(
            root.join("src/repeated.css"),
            ".repeat { color: red; }\n.repeat { color: blue; }\n",
        )
        .unwrap();
        std::fs::write(root.join("src/other.css"), ".other { color: green; }\n").unwrap();
        std::fs::write(
            root.join("src/components/Page.astro"),
            concat!(
                "<style lang=\"scss\">.ignored { color: red; }</style>\n",
                "<style>.astro { color: red; }</style>\n",
                "<style>.astro { color: blue; }</style>\n"
            ),
        )
        .unwrap();

        let sheets = idx(discover_stylesheets(root));
        let served = query(
            ".dup",
            None,
            Some("http://localhost:5173/src/b/Theme.css?t=123&direct"),
        );
        match locate_rule_in_project(root, &sheets, &served) {
            RuleLocation::Resolved { file, .. } => assert_eq!(file, "src/b/Theme.css"),
            other => panic!("expected exact served path to resolve b/Theme.css, got {other:?}"),
        }

        let absolute = root.join("src/a/Theme.css").to_string_lossy().into_owned();
        match locate_rule_in_project(root, &sheets, &query(".dup", None, Some(&absolute))) {
            RuleLocation::Resolved { file, .. } => assert_eq!(file, "src/a/Theme.css"),
            other => panic!("expected absolute project path to resolve a/Theme.css, got {other:?}"),
        }

        let conflicting = query(
            ".dup",
            None,
            Some("http://localhost:5173/src/other.css?t=456"),
        );
        assert_eq!(
            locate_rule_in_project(root, &sheets, &conflicting),
            RuleLocation::NotFound,
            "a full identity for another local source must not fall back to the selector hit"
        );

        let conflicting_style_indexes = format!(
            "http://localhost:5173/@fs{}?astro&type=style&index=1&index=2&lang.css",
            root.join("src/components/Page.astro").display()
        );
        assert_eq!(
            locate_rule_in_project(
                root,
                &sheets,
                &query(".astro", None, Some(&conflicting_style_indexes)),
            ),
            RuleLocation::NotFound,
            "conflicting repeated Astro indexes must not choose the last style block"
        );

        let external = query(
            ".dup",
            None,
            Some("https://cdn.example.test/src/a/Theme.css?t=42&direct"),
        );
        assert_eq!(
            locate_rule_in_project(root, &sheets, &external),
            RuleLocation::NotFound,
            "a remote stylesheet path is not evidence for a local source file"
        );

        let astro_href = format!(
            "http://localhost:5173/@fs{}?astro&type=style&index=2&lang.css",
            root.join("src/components/Page.astro").display()
        );
        match locate_rule_in_project(root, &sheets, &query(".astro", None, Some(&astro_href))) {
            RuleLocation::Resolved { file, .. } => {
                assert_eq!(file, "src/components/Page.astro?style=2")
            }
            other => panic!("expected Astro style index 2 to resolve exactly, got {other:?}"),
        }

        let unaddressable_preprocessor = format!(
            "http://localhost:5173/@fs{}?astro&type=style&index=0&lang.scss",
            root.join("src/components/Page.astro").display()
        );
        assert_eq!(
            locate_rule_in_project(
                root,
                &sheets,
                &query(".astro", None, Some(&unaddressable_preprocessor)),
            ),
            RuleLocation::NotFound,
            "the preprocessor block index must not drift onto an editable CSS block"
        );

        match locate_rule(&sheets, &query(".repeat", None, None)) {
            RuleLocation::Multiple {
                files,
                rule_count,
                candidates,
            } => {
                assert_eq!(files, vec!["src/repeated.css"]);
                assert_eq!(rule_count, 2);
                assert_eq!(candidates.len(), 2);
                assert_eq!(candidates[0].file, "src/repeated.css");
                assert_eq!(candidates[1].file, "src/repeated.css");
                assert_ne!(candidates[0].line, candidates[1].line);
            }
            other => panic!("expected two same-file rules to stay ambiguous, got {other:?}"),
        }

        let repeated_href = "http://localhost:5173/src/repeated.css?t=789";
        match locate_rule_in_project(root, &sheets, &query(".repeat", None, Some(repeated_href))) {
            RuleLocation::Multiple {
                files, rule_count, ..
            } => {
                assert_eq!(files, vec!["src/repeated.css"]);
                assert_eq!(rule_count, 2);
            }
            other => panic!("an exact file identity must not pick one of two rules, got {other:?}"),
        }
    }

    #[test]
    fn cssom_mapping_resolves_real_astro_global_and_generated_public_css_sources() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        let astro_dir = root.join("src/pages");
        let public_styles = root.join("public/styles");
        let public_css_dir = root.join("public/css");
        std::fs::create_dir_all(&astro_dir).unwrap();
        std::fs::create_dir_all(&public_styles).unwrap();
        std::fs::create_dir_all(&public_css_dir).unwrap();
        std::fs::write(
            public_css_dir.join("theme.css"),
            ".public-theme { color: olive; }\n",
        )
        .unwrap();

        let astro_path = astro_dir.join("index.astro");
        let astro_source = concat!(
            "---\nconst pageTitle = 'home';\n---\n",
            "<div class=\"brand-link\"><span class=\"brand-label\"></span></div>\n",
            "<style>\n",
            ":global(*) { box-sizing: border-box; }\n",
            ".top-stack { display: flex; flex-direction: column; align-items: center; gap: 100px; width: 100%; }\n",
            "@media (max-width: 720px) {\n  .top-stack { gap: 72px; }\n}\n",
            ".brand-label { text-box-trim: trim-both; }\n",
            ":global(.brand-link .brand-label) { text-decoration: underline; }\n",
            ":global(.brand-link:hover .brand-label), :global(.brand-link:focus-visible .brand-label) { text-decoration-color: currentcolor; }\n",
            "</style>\n"
        );
        std::fs::write(&astro_path, astro_source).unwrap();

        let base_css = ".shared { color: red; }\n";
        let project_css = concat!(
            "h1 {\n",
            "  font-size: 5rem;\n",
            "  font-weight: 300;\n",
            "  line-height: 1.2;\n",
            "  margin-top: 20px;\n",
            "  margin-bottom: 10px;\n",
            "}\n\n",
            ".hero-title {\n",
            "  letter-spacing: -.25rem;\n",
            "  background-image: none;\n",
            "  margin-top: 1px;\n",
            "  margin-bottom: 0;\n",
            "  padding-top: 18px;\n",
            "  padding-bottom: 18px;\n",
            "  font-family: Neurial Grotesk;\n",
            "  font-size: 8vw;\n",
            "  font-weight: 400;\n",
            "  line-height: 1.1;\n",
            "  display: block;\n",
            "}\n\n",
            ".shared { color: red; }\n\n",
            "@media screen and (max-width: 767px) {\n",
            "  h1 {\n",
            "    font-size: 56px;\n",
            "  }\n",
            "}\n"
        );
        let module_contents = [
            (
                "normalise.css",
                "/* normalize module */\n* { box-sizing: border-box; }\n",
            ),
            ("base.css", base_css),
            ("project.css", project_css),
            ("platform.css", "/* platform module */\n"),
            ("page-overrides.css", "/* page override module */\n"),
            ("cms.css", "/* cms module */\n"),
        ];
        for &(name, contents) in &module_contents {
            std::fs::write(public_styles.join(name), contents).unwrap();
        }
        let build_script = r#"import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STYLES_DIRECTORY = fileURLToPath(new URL('../public/styles/', import.meta.url));

export const SOURCE_FILES = Object.freeze([
  'normalise.css',
  'base.css',
  'project.css',
  'platform.css',
  'page-overrides.css',
  'cms.css',
]);

export function buildStyles(stylesDirectory = STYLES_DIRECTORY) {
  const stylesheet = [
    '/* Generated by scripts/build-styles.mjs. Edit the source modules instead. */',
    ...SOURCE_FILES.map((file) => readFileSync(resolve(stylesDirectory, file), 'utf8').trim()),
  ].join('\n\n') + '\n';

  writeFileSync(resolve(stylesDirectory, 'site.css'), stylesheet);
  return stylesheet;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) buildStyles();
"#;
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        std::fs::write(root.join("scripts/build-styles.mjs"), build_script).unwrap();
        let mut generated_parts = vec![
            "/* Generated by scripts/build-styles.mjs. Edit the source modules instead. */"
                .to_string(),
        ];
        generated_parts.extend(
            module_contents
                .iter()
                .map(|(_, contents)| contents.trim().to_string()),
        );
        let site_css = format!("{}\n", generated_parts.join("\n\n"));
        std::fs::write(public_styles.join("site.css"), &site_css).unwrap();

        let sheets = idx(discover_stylesheets(root));
        assert!(sheets
            .iter()
            .any(|sheet| sheet.rel == "public/styles/site.css"));
        assert!(sheets
            .iter()
            .any(|sheet| sheet.rel == "public/styles/project.css"));

        let public_theme = query(
            ".public-theme",
            None,
            Some("http://localhost:43127/css/theme.css"),
        );
        assert!(matches!(
            locate_rule_in_project(root, &sheets, &public_theme),
            RuleLocation::Resolved { file, .. } if file == "public/css/theme.css"
        ));

        let astro_href = format!(
            "http://localhost:4321/@fs{}?astro&type=style&index=0&lang.css",
            astro_path.display()
        );
        let universal = query("*", None, Some(&astro_href));
        match locate_rule_in_project(root, &sheets, &universal) {
            RuleLocation::Resolved { file, .. } => {
                assert_eq!(file, "src/pages/index.astro?style=0")
            }
            other => {
                panic!("expected :global(*) to resolve to the Astro style block, got {other:?}")
            }
        }

        let declaration = |property: &str, value: &str, important| Declaration {
            property: property.into(),
            value: value.into(),
            important,
        };
        let gap_evidence = |gap: &str| {
            vec![
                declaration("display", "flex", false),
                declaration("flex-direction", "column", false),
                declaration("align-items", "center", false),
                declaration("row-gap", gap, false),
                declaration("column-gap", gap, false),
                declaration("width", "100%", false),
            ]
        };
        let scoped_selector = ".top-stack[data-astro-cid-a1b2]";
        let preview_identity =
            |rule_path: Vec<usize>, declarations: Vec<Declaration>| CssRulePreviewIdentity {
                stylesheet_index: 0,
                rule_path,
                href: Some(astro_href.clone()),
                root_href: Some(astro_href.clone()),
                selector_list: scoped_selector.into(),
                selector_member_index: 0,
                declarations,
            };
        let astro_sheet = sheets
            .iter()
            .find(|sheet| sheet.rel == "src/pages/index.astro?style=0")
            .expect("the exact Astro style index is discovered");
        let base_declarations = gap_evidence("100px");
        let base_source_rule = astro_sheet
            .rules
            .iter()
            .find(|rule| rule.selector == ".top-stack" && rule.media.is_none())
            .expect("the real base .top-stack rule is indexed");
        assert!(
            !declaration_evidence_matches(
                &astro_sheet.content,
                base_source_rule,
                Some(&base_declarations)
            ),
            "the authored gap shorthand and CSSOM row/column-gap evidence differ"
        );
        let mut base_query = query(".top-stack", None, Some(&astro_href));
        base_query.selector_member_index = Some(0);
        base_query.context_path = Some(Vec::new());
        base_query.identity_declarations = Some(base_declarations.clone());
        base_query.runtime_identity = Some(preview_identity(vec![1], base_declarations));
        let (base_identity, base_inner) = match locate_rule_in_project(root, &sheets, &base_query) {
            RuleLocation::Resolved {
                file,
                inner_text,
                source_identity: Some(identity),
                ..
            } => {
                assert_eq!(file, "src/pages/index.astro?style=0");
                (identity, inner_text)
            }
            other => panic!("the unique base .top-stack source rule must resolve, got {other:?}"),
        };
        assert!(base_inner.contains("gap: 100px"));
        assert_eq!(base_identity.selector_member_index, 0);

        let media_declarations = gap_evidence("72px");
        let media_source_rule = astro_sheet
            .rules
            .iter()
            .find(|rule| rule.selector == ".top-stack" && rule.media.is_some())
            .expect("the real media .top-stack rule is indexed");
        assert!(
            !declaration_evidence_matches(
                &astro_sheet.content,
                media_source_rule,
                Some(&media_declarations)
            ),
            "the mobile authored gap shorthand and CSSOM row/column-gap evidence differ"
        );
        let mut media_query = query(".top-stack", Some("(width <= 720px)"), Some(&astro_href));
        media_query.selector_member_index = Some(0);
        media_query.context_path = Some(vec!["@media (width <= 720px)".into()]);
        media_query.identity_declarations = Some(media_declarations.clone());
        media_query.runtime_identity = Some(preview_identity(vec![2, 0], media_declarations));
        let (media_identity, media_inner) =
            match locate_rule_in_project(root, &sheets, &media_query) {
                RuleLocation::Resolved {
                    file,
                    inner_text,
                    source_identity: Some(identity),
                    ..
                } => {
                    assert_eq!(file, "src/pages/index.astro?style=0");
                    (identity, inner_text)
                }
                other => {
                    panic!("the unique media .top-stack source rule must resolve, got {other:?}")
                }
            };
        assert!(media_inner.contains("gap: 72px"));
        assert_eq!(
            media_identity.context_path,
            vec!["@media (max-width: 720px)"]
        );

        let file = "src/pages/index.astro?style=0";
        let (saved_css, saved_identity) = css_rule_mutations::apply_body(
            file,
            &astro_sheet.content,
            &base_identity,
            "\n  gap: 104px;\n",
        )
        .unwrap();
        assert_eq!(saved_identity.inner_text, "\n  gap: 104px;\n");
        css_rule_mutations::resolve_identity(file, &saved_css, &saved_identity)
            .expect("the saved exact source identity is current");
        assert!(css_rule_mutations::resolve_identity(file, &saved_css, &base_identity).is_err());

        let (renamed_css, renamed_media) = css_rule_mutations::rename_media(
            file,
            &astro_sheet.content,
            &media_identity,
            "(max-width: 700px)",
        )
        .unwrap();
        assert_eq!(
            renamed_media.selected.context_path,
            vec!["@media (max-width: 700px)"]
        );
        css_rule_mutations::resolve_identity(file, &renamed_css, &renamed_media.selected)
            .expect("the renamed media rule has a refreshed exact identity");
        assert!(css_rule_mutations::resolve_identity(file, &renamed_css, &media_identity).is_err());

        let deleted_css =
            css_rule_mutations::delete_rule(file, &astro_sheet.content, &media_identity).unwrap();
        assert!(deleted_css.contains("gap: 100px"));
        assert!(!deleted_css.contains("gap: 72px"));
        assert!(css_rule_mutations::resolve_identity(file, &deleted_css, &media_identity).is_err());

        let mut stale_style_identity = base_query.clone();
        let stale_href = format!(
            "http://localhost:4321/@fs{}?astro&type=style&index=1&lang.css",
            astro_path.display()
        );
        stale_style_identity.href = Some(stale_href.clone());
        stale_style_identity.runtime_identity.as_mut().unwrap().href = Some(stale_href);
        assert_eq!(
            locate_rule_in_project(root, &sheets, &stale_style_identity),
            RuleLocation::NotFound,
            "a stale Astro style index must not fall back to the unique selector"
        );
        let mut stale_runtime_identity = base_query.clone();
        stale_runtime_identity
            .runtime_identity
            .as_mut()
            .unwrap()
            .href =
            Some("http://localhost:4321/src/pages/other.astro?astro&type=style&index=0".into());
        assert_eq!(
            locate_rule_in_project(root, &sheets, &stale_runtime_identity),
            RuleLocation::NotFound,
            "preview identity drift must remain fail-closed"
        );
        let mut external_source_identity = base_query.clone();
        let external_href =
            "https://cdn.example.test/src/pages/index.astro?astro&type=style&index=0&lang.css";
        external_source_identity.href = Some(external_href.into());
        external_source_identity
            .runtime_identity
            .as_mut()
            .unwrap()
            .href = Some(external_href.into());
        assert_eq!(
            locate_rule_in_project(root, &sheets, &external_source_identity),
            RuleLocation::NotFound,
            "an external stylesheet identity must not fall back to the local selector"
        );

        assert!(matches!(
            resolve_in_sheets(&sheets, &sig("brand-label"), None),
            CssResolution::Resolved { file, .. } if file == "src/pages/index.astro?style=0"
        ));

        let brand = query(".brand-link .brand-label", None, Some(&astro_href));
        let (brand_file, brand_inner) = match locate_rule_in_project(root, &sheets, &brand) {
            RuleLocation::Resolved {
                file, inner_text, ..
            } => (file, inner_text),
            other => panic!("expected global descendant selector to resolve, got {other:?}"),
        };
        assert_eq!(brand_file, "src/pages/index.astro?style=0");
        let brand_source_line = resolve_css_source_line_in_file(root, &brand_file, &brand).unwrap();
        assert_eq!(
            brand_source_line,
            astro_source
                .lines()
                .position(|line| line.contains(":global(.brand-link .brand-label)"))
                .unwrap()
                + 1
        );

        let editable_astro = load_editable_css(root, &brand_file).unwrap();
        let saved_astro = apply_rule_text_to_source(
            &editable_astro.css,
            &brand.selector,
            &brand.media_text,
            &brand_inner,
            " text-decoration: underline; text-decoration-color: transparent; ",
        )
        .unwrap();
        editable_astro.write_back(root, &saved_astro).unwrap();
        let saved_host = std::fs::read_to_string(&astro_path).unwrap();
        assert!(saved_host.contains(
            ":global(.brand-link .brand-label) { text-decoration: underline; text-decoration-color: transparent; }"
        ));

        let astro_css = &sheets
            .iter()
            .find(|sheet| sheet.rel == "src/pages/index.astro?style=0")
            .unwrap()
            .content;
        let updated_control = apply_declaration_to_source(
            astro_css,
            &brand.selector,
            None,
            "text-decoration-color",
            Some("currentcolor"),
        )
        .unwrap();
        assert!(updated_control.contains(":global(.brand-link .brand-label) {"));
        assert!(updated_control.contains("text-decoration-color: currentcolor;"));

        let renamed = rename_selector_in_source(
            astro_css,
            &brand.selector,
            &brand.media_text,
            &brand_inner,
            ".brand-link .brand-label.is-active",
        )
        .unwrap();
        assert!(renamed.contains(":global(.brand-link .brand-label.is-active) {"));
        let partially_scoped = ":global(.brand-link) .brand-label { color: red; }";
        assert!(rename_selector_in_source(
            partially_scoped,
            ".brand-link .brand-label",
            &None,
            " color: red; ",
            ".brand-link .brand-label.is-active",
        )
        .is_err());

        let hover = query(".brand-link:hover .brand-label", None, Some(&astro_href));
        let hover_inner = match locate_rule_in_project(root, &sheets, &hover) {
            RuleLocation::Resolved { inner_text, .. } => inner_text,
            other => panic!("expected Astro hover selector to resolve, got {other:?}"),
        };
        let after_delete =
            remove_rule_from_source(astro_css, &hover.selector, &hover.media_text, &hover_inner)
                .unwrap();
        assert!(!after_delete.contains(":global(.brand-link:hover .brand-label)"));
        assert!(after_delete.contains(".brand-label { text-box-trim: trim-both; }"));

        let sheet_href = "http://localhost:43127/styles/site.css";
        let base_heading = query("h1", None, Some(sheet_href));
        let (source_file, base_line) = match locate_rule_in_project(root, &sheets, &base_heading) {
            RuleLocation::Resolved {
                file,
                line,
                generated_css_output,
                ..
            } => {
                assert_eq!(
                    generated_css_output.as_deref(),
                    Some("public/styles/site.css")
                );
                (file, line)
            }
            other => panic!("expected public site.css h1 to resolve exactly, got {other:?}"),
        };
        assert_eq!(source_file, "public/styles/project.css");
        assert_eq!(
            base_line,
            project_css.lines().position(|line| line == "h1 {").unwrap() + 1
        );
        assert_eq!(
            resolve_css_source_line_in_file(root, &source_file, &base_heading).unwrap(),
            base_line
        );

        let responsive = query(
            "h1",
            Some("screen and (max-width: 767px)"),
            Some(sheet_href),
        );
        match locate_rule_in_project(root, &sheets, &responsive) {
            RuleLocation::Resolved { file, .. } => assert_eq!(file, "public/styles/project.css"),
            other => panic!("expected public responsive h1 rule to resolve, got {other:?}"),
        }
        let hero = query(".hero-title", None, Some(sheet_href));
        match locate_rule_in_project(root, &sheets, &hero) {
            RuleLocation::Resolved {
                file,
                generated_css_output,
                ..
            } => {
                assert_eq!(file, "public/styles/project.css");
                assert_eq!(
                    generated_css_output.as_deref(),
                    Some("public/styles/site.css")
                );
            }
            other => panic!("expected public hero-title rule to resolve, got {other:?}"),
        }
        let universal = query("*", None, Some(sheet_href));
        match locate_rule_in_project(root, &sheets, &universal) {
            RuleLocation::Resolved {
                file,
                generated_css_output,
                ..
            } => {
                assert_eq!(file, "public/styles/normalise.css");
                assert_eq!(
                    generated_css_output.as_deref(),
                    Some("public/styles/site.css")
                );
            }
            other => panic!("expected public universal rule to resolve, got {other:?}"),
        }
        let duplicated = query(".shared", None, Some(sheet_href));
        match locate_rule_in_project(root, &sheets, &duplicated) {
            RuleLocation::Multiple {
                files,
                rule_count,
                candidates,
            } => {
                assert_eq!(
                    files,
                    vec![
                        "public/styles/base.css".to_string(),
                        "public/styles/project.css".to_string(),
                    ]
                );
                assert_eq!(rule_count, 2);
                assert_eq!(candidates.len(), 2);
            }
            other => {
                panic!("expected duplicate generated rules to remain ambiguous, got {other:?}")
            }
        }

        let generated_only_css =
            format!("{site_css}\n.generated-only {{ color: rebeccapurple; }}\n");
        std::fs::write(public_styles.join("site.css"), &generated_only_css).unwrap();
        let generated_only_sheets = idx(discover_stylesheets(root));
        let generated_only = query(".generated-only", None, Some(sheet_href));
        assert_eq!(
            locate_rule_in_project(root, &generated_only_sheets, &generated_only),
            RuleLocation::NotFound,
            "an output-only rule must stay read-only even when the generator manifest is valid"
        );
        std::fs::write(public_styles.join("site.css"), &site_css).unwrap();

        let editable_project = load_editable_css(root, &source_file).unwrap();
        let updated_project = apply_declaration_to_source(
            &editable_project.css,
            "h1",
            None,
            "font-size",
            Some("4rem"),
        )
        .unwrap();
        editable_project.write_back(root, &updated_project).unwrap();
        assert!(std::fs::read_to_string(public_styles.join("project.css"))
            .unwrap()
            .contains("font-size: 4rem;"));
        assert!(!std::fs::read_to_string(public_styles.join("site.css"))
            .unwrap()
            .contains("font-size: 4rem;"));
        // If indexed source content drifted from disk, the generated output is no
        // longer safe to map from this snapshot and must not itself become writable.
        assert_eq!(
            locate_rule_in_project(root, &sheets, &hero),
            RuleLocation::NotFound
        );

        // If a root-level and public asset both fit the same URL, the locator
        // refuses to guess which one the dev server served.
        let root_styles = root.join("styles");
        std::fs::create_dir_all(&root_styles).unwrap();
        std::fs::write(root_styles.join("site.css"), "h1 { font-size: 3rem; }\n").unwrap();
        let ambiguous_sheets = idx(discover_stylesheets(root));
        assert_eq!(
            locate_rule_in_project(root, &ambiguous_sheets, &base_heading),
            RuleLocation::NotFound
        );
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
        // Only the plain-CSS range is addressable, but its source identity retains
        // Astro's index so the preceding preprocessor block leaves a gap.
        assert_eq!(blocks.len(), 1);
        assert_eq!(&src[blocks[0].0..blocks[0].1], ".c{}");
        let indexed = astro_style_blocks_with_indices(src);
        assert_eq!(indexed.len(), 1);
        assert_eq!(indexed[0].0, 1);
    }

    #[test]
    fn astro_inline_style_blocks_do_not_consume_a_compiled_style_index() {
        let src =
            "<style is:inline>.inline { color: red; }</style>\n<style>.compiled { color: blue; }</style>";
        let indexed = astro_style_blocks_with_indices(src);
        assert_eq!(indexed.len(), 1);
        assert_eq!(indexed[0].0, 0);
        let (start, end) = indexed[0].1;
        assert_eq!(&src[start..end], ".compiled { color: blue; }");
    }

    #[test]
    fn astro_style_blocks_ignores_style_inside_frontmatter() {
        let src = "---\nconst s = \"<style>fake</style>\";\n---\n<style>.real{}</style>";
        let blocks = astro_style_blocks(src);
        assert_eq!(blocks.len(), 1);
        assert_eq!(&src[blocks[0].0..blocks[0].1], ".real{}");
    }

    #[test]
    fn source_line_resolution_maps_astro_rules_to_physical_host_lines() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        let source = concat!(
            "---\r\n",
            "const style = \"<style>.fake {}</style>\";\r\n",
            "---\r\n",
            "<style lang=\"scss\">.ignored { color: red; }</style>\r\n",
            "<div />\r\n",
            "<style>\r\n",
            ".before { color: red; }\r\n",
            "</style><style>\n",
            ".after { color: blue; }\n",
            "</style>"
        );
        std::fs::write(root.join("Page.astro"), source).unwrap();

        assert_eq!(
            resolve_css_source_line_in_file(
                root,
                "Page.astro?style=1",
                &query(".before", None, None)
            )
            .unwrap(),
            7
        );
        assert_eq!(
            resolve_css_source_line_in_file(
                root,
                "Page.astro?style=2",
                &query(".after", None, None)
            )
            .unwrap(),
            9
        );
    }

    #[test]
    fn source_line_resolution_returns_plain_css_selector_line() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("site.css"),
            "/* header */\r\n.before { color: red; }\r\n",
        )
        .unwrap();

        assert_eq!(
            resolve_css_source_line_in_file(root, "site.css", &query(".before", None, None))
                .unwrap(),
            2
        );
    }

    #[test]
    fn source_line_resolution_pins_a_variables_rule_to_its_exact_astro_line() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        let source = concat!(
            "---\n",
            "---\n",
            "<main />\n",
            "<style>\n",
            ":root { --tone: red; }\n",
            ":root { --tone: blue; }\n",
            "</style>\n",
        );
        std::fs::write(root.join("Page.astro"), source).unwrap();
        let matched = query(":root", None, None);

        // Selector-only resolution is ambiguous, while the source line from the
        // Variables row pins the second virtual CSS rule to its host-file line.
        assert!(resolve_css_source_line_in_file(root, "Page.astro?style=0", &matched).is_err());
        assert_eq!(
            resolve_css_source_line_in_file_at_source_line(
                root,
                "Page.astro?style=0",
                &matched,
                Some(3),
            )
            .unwrap(),
            6
        );
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
            selector_member_index: None,
            context_path: None,
            identity_declarations: None,
            runtime_identity: None,
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
            selector_member_index: None,
            context_path: None,
            identity_declarations: None,
            runtime_identity: None,
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
            selector_member_index: None,
            context_path: None,
            identity_declarations: None,
            runtime_identity: None,
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

    #[test]
    fn css_rule_identity_shared_member_and_consolidation_regression() {
        let long_selector = ".bio-line > span:not(.brand):not(.muted-dark):not(.hyperculture-word)";
        let source = format!(
            "{long_selector} {{ white-space: nowrap; }}\n{long_selector}, .location-name {{ text-box-trim: trim-both; text-box-edge: cap alphabetic; }}\n"
        );
        let sheet = SheetIndex::parse("index.astro?style=0".into(), source.clone());
        let query =
            |selector: &str, member: usize, declarations: Vec<Declaration>| MatchedRuleQuery {
                selector: selector.into(),
                media_text: None,
                href: None,
                layer: None,
                container: None,
                supports: None,
                selector_member_index: Some(member),
                context_path: Some(Vec::new()),
                identity_declarations: Some(declarations),
                runtime_identity: None,
            };
        // CSSOM exposes this authored shorthand as the two equivalent longhands.
        let white_space_evidence = vec![
            Declaration {
                property: "white-space-collapse".into(),
                value: "collapse".into(),
                important: false,
            },
            Declaration {
                property: "text-wrap-mode".into(),
                value: "nowrap".into(),
                important: false,
            },
        ];
        let first_query = query(long_selector, 0, white_space_evidence);
        let first_identity = match locate_rule(&[sheet.clone()], &first_query) {
            RuleLocation::Resolved {
                source_identity: Some(identity),
                inner_text,
                ..
            } => {
                assert_eq!(inner_text.trim(), "white-space: nowrap;");
                identity
            }
            result => panic!("the exact shorthand occurrence should resolve, got {result:?}"),
        };
        assert_eq!(
            first_identity.selector_offset,
            source.find(long_selector).unwrap()
        );
        assert_eq!(first_identity.selector_member_index, 0);

        let grouped_query = query(
            ".location-name",
            1,
            vec![
                Declaration {
                    property: "text-box-trim".into(),
                    value: "trim-both".into(),
                    important: false,
                },
                Declaration {
                    property: "text-box-edge".into(),
                    value: "cap alphabetic".into(),
                    important: false,
                },
            ],
        );
        let grouped_identity = match locate_rule(&[sheet], &grouped_query) {
            RuleLocation::Resolved {
                source_identity: Some(identity),
                ..
            } => identity,
            result => panic!("the grouped member should resolve separately, got {result:?}"),
        };
        assert_eq!(grouped_identity.selector_member_index, 1);
        assert_eq!(
            grouped_identity.selector_members,
            vec![norm_selector(long_selector), ".location-name".to_string()]
        );

        let media_source = "@media (min-width: 600px) {\n  .one { color: red; }\n  @media (max-width: 400px) {\n    .inner { color: green; }\n  }\n  @layer a {\n    .two { color: blue; }\n  }\n}\n@media (min-width: 600px) {\n  .one { color: red; }\n}\n";
        let media_rules = index_rules(media_source);
        let selected_media_rule = media_rules
            .iter()
            .find(|rule| rule.selector == ".one")
            .unwrap();
        let selected_media_identity = css_rule_mutations::identity_for_rule(
            "media.css",
            media_source,
            selected_media_rule,
            0,
            ".one",
        )
        .unwrap();
        let (renamed_media, media_rename) = css_rule_mutations::rename_media(
            "media.css",
            media_source,
            &selected_media_identity,
            "(min-width: 700px)",
        )
        .unwrap();
        assert_eq!(
            renamed_media,
            "@media (min-width: 700px) {\n  .one { color: red; }\n  @media (max-width: 400px) {\n    .inner { color: green; }\n  }\n  @layer a {\n    .two { color: blue; }\n  }\n}\n@media (min-width: 600px) {\n  .one { color: red; }\n}\n"
        );
        assert_eq!(
            media_rename.selected.context_path,
            vec!["@media (min-width: 700px)".to_string()]
        );
        let nested_old_offset = media_source.find(".two").unwrap();
        let nested_refresh = media_rename
            .remapped_rules
            .iter()
            .find(|remap| {
                remap.old_selector_offset == nested_old_offset && remap.selector_member_index == 0
            })
            .expect("the exact nested sibling in the renamed wrapper is mapped");
        assert_eq!(
            nested_refresh.identity.context_path,
            vec![
                "@media (min-width: 700px)".to_string(),
                "@layer a".to_string()
            ]
        );
        css_rule_mutations::resolve_identity("media.css", &renamed_media, &nested_refresh.identity)
            .expect("the nested sibling maps to its exact new source occurrence");
        let inner_old_offset = media_source.find(".inner").unwrap();
        let inner_refresh = media_rename
            .remapped_rules
            .iter()
            .find(|remap| remap.old_selector_offset == inner_old_offset)
            .expect("nested media descendants are mapped with their exact outer wrapper");
        assert_eq!(
            inner_refresh.identity.context_path,
            vec![
                "@media (min-width: 700px)".to_string(),
                "@media (max-width: 400px)".to_string()
            ]
        );
        css_rule_mutations::resolve_identity("media.css", &renamed_media, &inner_refresh.identity)
            .expect("nested media descendant maps to its exact new source occurrence");
        let untouched_media_offset = media_source.rfind(".one").unwrap();
        assert!(!media_rename
            .remapped_rules
            .iter()
            .any(|remap| remap.old_selector_offset == untouched_media_offset));

        let renamed = css_rule_mutations::rename_member(
            "index.astro?style=0",
            &source,
            &grouped_identity,
            ".location-alt",
        )
        .unwrap()
        .0;
        assert!(renamed.contains(&format!("{long_selector}, .location-alt {{")));
        assert!(renamed.contains(&format!("{long_selector} {{ white-space: nowrap; }}")));

        let removed =
            css_rule_mutations::remove_member("index.astro?style=0", &source, &grouped_identity)
                .unwrap()
                .0;
        let remaining = index_rules(&removed);
        assert_eq!(remaining.len(), 2);
        assert_eq!(
            normalized_selector_parts(&remaining[1].selector),
            vec![norm_selector(long_selector)]
        );
        let expected_removed = format!(
            "{long_selector} {{ white-space: nowrap; }}\n{long_selector} {{ text-box-trim: trim-both; text-box-edge: cap alphabetic; }}\n"
        );
        assert_eq!(
            removed, expected_removed,
            "member removal must alter only its selector list"
        );
        assert!(removed.contains("text-box-edge: cap alphabetic;"));

        let (split, independent_identity) =
            css_rule_mutations::make_independent("index.astro?style=0", &source, &grouped_identity)
                .unwrap();
        let split_rules = index_rules(&split);
        assert_eq!(split_rules.len(), 3);
        assert_eq!(
            normalized_selector_parts(&split_rules[1].selector),
            vec![norm_selector(long_selector)]
        );
        assert_eq!(split_rules[2].selector, ".location-name");
        assert_eq!(
            &split[split_rules[1].block_inner_start..split_rules[1].block_inner_end],
            &split[split_rules[2].block_inner_start..split_rules[2].block_inner_end]
        );
        css_rule_mutations::resolve_identity("index.astro?style=0", &split, &independent_identity)
            .expect("the returned identity should pin the new adjacent rule");
        let expected_split = format!(
            "{long_selector} {{ white-space: nowrap; }}\n{long_selector} {{ text-box-trim: trim-both; text-box-edge: cap alphabetic; }}\n.location-name {{ text-box-trim: trim-both; text-box-edge: cap alphabetic; }}\n"
        );
        assert_eq!(
            split, expected_split,
            "split must preserve all non-target source text"
        );
        assert!(css_rule_mutations::resolve_identity(
            "index.astro?style=0",
            &source.replace("white-space: nowrap", "white-space: normal"),
            &first_identity,
        )
        .is_err());

        // Astro global wrappers survive a member split in source, including the
        // selected member's wrapper and original declarations.
        let global_source = ":global(.a, .b) { color: red; }\n";
        let global_rule = index_rules(global_source).remove(0);
        let global_identity = css_rule_mutations::identity_for_rule(
            "Component.astro?style=0",
            global_source,
            &global_rule,
            1,
            ".b",
        )
        .unwrap();
        let (global_split, _) = css_rule_mutations::make_independent(
            "Component.astro?style=0",
            global_source,
            &global_identity,
        )
        .unwrap();
        assert!(global_split.contains(":global(.a) { color: red; }"));
        assert!(global_split.contains(":global(.b) { color: red; }"));
        let (global_removed, _) = css_rule_mutations::remove_member(
            "Component.astro?style=0",
            global_source,
            &global_identity,
        )
        .unwrap();
        assert_eq!(global_removed, ":global(.a) { color: red; }\n");

        let commented_group_source =
            ".keep, .remaining /* preserve this note */ {\n  color: red;\n}\n/* outside remains */\n";
        let commented_rule = index_rules(commented_group_source).remove(0);
        let commented_identity = css_rule_mutations::identity_for_rule(
            "comments.css",
            commented_group_source,
            &commented_rule,
            0,
            ".keep",
        )
        .unwrap();
        let (commented_removed, _) = css_rule_mutations::remove_member(
            "comments.css",
            commented_group_source,
            &commented_identity,
        )
        .unwrap();
        assert_eq!(
            commented_removed,
            ".remaining /* preserve this note */ {\n  color: red;\n}\n/* outside remains */\n"
        );
        let (commented_split, _) = css_rule_mutations::make_independent(
            "comments.css",
            commented_group_source,
            &commented_identity,
        )
        .unwrap();
        assert_eq!(
            commented_split,
            ".remaining /* preserve this note */ {\n  color: red;\n}\n.keep {\n  color: red;\n}\n/* outside remains */\n"
        );

        let partial_global_source = ".other, :global(.a) > .child { color: red; }";
        let partial_global_rule = index_rules(partial_global_source).remove(0);
        let partial_global_identity = css_rule_mutations::identity_for_rule(
            "Component.astro?style=0",
            partial_global_source,
            &partial_global_rule,
            1,
            ".a > .child",
        )
        .unwrap();
        assert!(css_rule_mutations::rename_member(
            "Component.astro?style=0",
            partial_global_source,
            &partial_global_identity,
            ".renamed > .child",
        )
        .is_err());

        let wrap_source =
            "/* preserved same-line prefix */ .wrap-me { color: red; }\n.keep { color: blue; }\n";
        let wrap_rule = index_rules(wrap_source).remove(0);
        let wrap_identity = css_rule_mutations::identity_for_rule(
            "wrap.css",
            wrap_source,
            &wrap_rule,
            0,
            ".wrap-me",
        )
        .unwrap();
        let (wrapped, wrapped_identity) = css_rule_mutations::wrap_rule(
            "wrap.css",
            wrap_source,
            &wrap_identity,
            "@media (min-width: 600px)",
        )
        .unwrap();
        assert_eq!(
            wrapped,
            "/* preserved same-line prefix */ @media (min-width: 600px) {\n  .wrap-me { color: red; }\n}\n.keep { color: blue; }\n"
        );
        assert_eq!(
            wrapped_identity.selector_offset,
            wrapped.find(".wrap-me").unwrap()
        );
        css_rule_mutations::resolve_identity("wrap.css", &wrapped, &wrapped_identity)
            .expect("wrapped source identity must resolve at its new line and offset");

        let indented_wrap_source = "\t.indented { color: red; }\r\n";
        let indented_rule = index_rules(indented_wrap_source).remove(0);
        let indented_identity = css_rule_mutations::identity_for_rule(
            "indented.css",
            indented_wrap_source,
            &indented_rule,
            0,
            ".indented",
        )
        .unwrap();
        let (indented_wrapped, indented_wrapped_identity) = css_rule_mutations::wrap_rule(
            "indented.css",
            indented_wrap_source,
            &indented_identity,
            "@supports (display: grid)",
        )
        .unwrap();
        assert_eq!(
            indented_wrapped,
            "\t@supports (display: grid) {\r\n\t  .indented { color: red; }\r\n\t}\r\n"
        );
        assert_eq!(
            indented_wrapped_identity.selector_offset,
            indented_wrapped.find(".indented").unwrap()
        );
        css_rule_mutations::resolve_identity(
            "indented.css",
            &indented_wrapped,
            &indented_wrapped_identity,
        )
        .expect("indented CRLF wrapper identity must resolve");

        let same_line_rules = ".before { color: black; } .wrap { color: red; }";
        let same_line_rule = index_rules(same_line_rules).remove(1);
        let same_line_identity = css_rule_mutations::identity_for_rule(
            "same-line.css",
            same_line_rules,
            &same_line_rule,
            0,
            ".wrap",
        )
        .unwrap();
        assert!(css_rule_mutations::wrap_rule(
            "same-line.css",
            same_line_rules,
            &same_line_identity,
            "@media (min-width: 600px)",
        )
        .is_err());

        let duplicate_css = ".x { color: red; }\n.x { color: red; }";
        let duplicate_sheet = SheetIndex::parse("duplicate.css".into(), duplicate_css.into());
        let duplicate_query = query(
            ".x",
            0,
            vec![Declaration {
                property: "color".into(),
                value: "red".into(),
                important: false,
            }],
        );
        assert!(matches!(
            locate_rule(&[duplicate_sheet], &duplicate_query),
            RuleLocation::Multiple { rule_count: 2, .. }
        ));

        let consolidation_source =
            ".x { color: red; color: blue; }\n\n.x { color: green !important; color: purple; }\n";
        let review = css_rule_mutations::review_consolidations("safe.css", consolidation_source);
        assert_eq!(review.candidates.len(), 1);
        let candidate = &review.candidates[0];
        assert!(
            candidate.after.find("color: red").unwrap()
                < candidate.after.find("color: blue").unwrap()
        );
        assert!(
            candidate.after.find("color: blue").unwrap()
                < candidate.after.find("color: green !important").unwrap()
        );
        let consolidated =
            css_rule_mutations::apply_consolidation("safe.css", consolidation_source, candidate)
                .unwrap();
        assert_eq!(index_rules(&consolidated).len(), 1);
        assert!(css_rule_mutations::apply_consolidation(
            "safe.css",
            &consolidation_source.replace("green", "orange"),
            candidate,
        )
        .is_err());

        let stale_snapshot_root = tempfile::TempDir::new().unwrap();
        let stale_snapshot_file = stale_snapshot_root.path().join("snapshot.css");
        let before_write = ".snapshot { color: red; }\n";
        let first_write = ".snapshot { color: blue; }\n";
        let stale_write = ".snapshot { color: green; }\n";
        std::fs::write(&stale_snapshot_file, before_write).unwrap();
        let first_snapshot = load_editable_css(stale_snapshot_root.path(), "snapshot.css").unwrap();
        let stale_snapshot = load_editable_css(stale_snapshot_root.path(), "snapshot.css").unwrap();
        first_snapshot
            .write_back(stale_snapshot_root.path(), first_write)
            .unwrap();
        assert!(matches!(
            stale_snapshot.write_back(stale_snapshot_root.path(), stale_write),
            Err(CommandError::Validation { reason, .. }) if reason.contains("source changed")
        ));
        assert_eq!(
            std::fs::read_to_string(stale_snapshot_file).unwrap(),
            first_write
        );

        let concurrent_root = tempfile::TempDir::new().unwrap();
        let concurrent_file = concurrent_root.path().join("concurrent.css");
        std::fs::write(&concurrent_file, before_write).unwrap();
        let concurrent_first = load_editable_css(concurrent_root.path(), "concurrent.css").unwrap();
        let concurrent_second =
            load_editable_css(concurrent_root.path(), "concurrent.css").unwrap();
        let first_root = concurrent_root.path().to_path_buf();
        let second_root = first_root.clone();
        let first_write_result = std::thread::spawn(move || {
            concurrent_first
                .write_back(&first_root, first_write)
                .is_ok()
        });
        let second_write_result = std::thread::spawn(move || {
            concurrent_second
                .write_back(&second_root, stale_write)
                .is_ok()
        });
        let successes = [
            first_write_result.join().unwrap(),
            second_write_result.join().unwrap(),
        ]
        .into_iter()
        .filter(|success| *success)
        .count();
        assert_eq!(
            successes, 1,
            "in-process writes from one source snapshot must serialize and reject the stale writer"
        );
        let concurrent_result = std::fs::read_to_string(concurrent_file).unwrap();
        assert!(
            concurrent_result == ".snapshot { color: blue; }\n"
                || concurrent_result == ".snapshot { color: green; }\n",
            "the serialized result must be exactly one writer's complete edit"
        );

        for unsafe_css in [
            ".x { color: red; }\n.gap { color: black; }\n.x { color: blue; }",
            "@media (max-width: 600px) { .x { color: red; } .x { color: blue; } }",
            ".x, .y { color: red; }\n.x { color: blue; }",
            ".x { @apply p-2; }\n.x { color: blue; }",
        ] {
            let unsafe_review = css_rule_mutations::review_consolidations("unsafe.css", unsafe_css);
            assert!(
                unsafe_review.candidates.is_empty(),
                "unexpected safe merge for {unsafe_css}"
            );
            assert!(unsafe_review.unavailable_reason.is_some());
        }
    }

    #[test]
    fn css_selector_list_edit_and_split_preserves_exact_source_identity() {
        let file = "src/styles/selectors.css";
        let rename_source = "/* before */\n.old { color: red; }\n.after { display: block; }\n";
        let old_rule = index_rules(rename_source)
            .into_iter()
            .find(|rule| rule.selector == ".old")
            .unwrap();
        let old_identity =
            css_rule_mutations::identity_for_rule(file, rename_source, &old_rule, 0, ".old")
                .unwrap();
        let grouped_selector =
            r#".new:is(.one, .two):not([data-label="a,b"]):has(.child), .escaped\,comma, #\31 foo"#;
        let (grouped_source, grouped_identity) = css_rule_mutations::replace_selector_list(
            file,
            rename_source,
            &old_identity,
            grouped_selector,
        )
        .unwrap();
        assert_eq!(
            grouped_identity.selector_members,
            vec![
                r#".new:is(.one,.two):not([data-label="a,b"]):has(.child)"#,
                r#".escaped\,comma"#,
                r#"#\31 foo"#,
            ]
        );
        assert!(!grouped_identity.selector_list_split_safe);
        assert!(grouped_source.starts_with("/* before */\n"));
        assert!(grouped_source.ends_with("\n.after { display: block; }\n"));

        let (single_source, single_identity) = css_rule_mutations::replace_selector_list(
            file,
            &grouped_source,
            &grouped_identity,
            ".single",
        )
        .unwrap();
        assert_eq!(single_identity.selector, ".single");
        assert_eq!(single_identity.selector_members, vec![".single"]);
        assert!(single_source.contains(".single { color: red; }"));
        assert!(!single_source.contains(".escaped\\,comma"));
        assert!(css_rule_mutations::replace_selector_list(
            file,
            &single_source.replace("color: red", "color: blue"),
            &old_identity,
            ".stale",
        )
        .is_err());

        let split_source = ".before { color: black; }\n@media (min-width: 600px) {\n  :global(.astro-one, .astro-two), .third { color: red; }\n}\n.after { color: blue; }\n/* untouched tail */\n";
        let original_split_source = split_source.to_string();
        let split_rules = index_rules(split_source);
        let before = split_rules
            .iter()
            .find(|rule| rule.selector == ".before")
            .unwrap();
        let target = split_rules
            .iter()
            .find(|rule| rule.selector.starts_with(":global("))
            .unwrap();
        let after = split_rules
            .iter()
            .find(|rule| rule.selector == ".after")
            .unwrap();
        let before_identity =
            css_rule_mutations::identity_for_rule(file, split_source, before, 0, ".before")
                .unwrap();
        let target_identity =
            css_rule_mutations::identity_for_rule(file, split_source, target, 2, ".third").unwrap();
        let original_target_body =
            split_source[target.block_inner_start..target.block_inner_end].to_string();
        let original_prefix = split_source[..target.selector_start].to_string();
        let original_context = target.context_path.clone();
        let after_identity =
            css_rule_mutations::identity_for_rule(file, split_source, after, 0, ".after").unwrap();
        assert!(target_identity.selector_list_split_safe);
        let unsafe_rule = index_rules("#important, .ordinary { color: red; }")
            .into_iter()
            .next()
            .unwrap();
        assert!(
            !css_rule_mutations::identity_for_rule(
                file,
                "#important, .ordinary { color: red; }",
                &unsafe_rule,
                0,
                "#important",
            )
            .unwrap()
            .selector_list_split_safe
        );

        let (split_source, split_result) =
            css_rule_mutations::split_selector_list(file, split_source, &target_identity).unwrap();
        let split_rules = index_rules(&split_source);
        assert_eq!(split_rules.len(), 5);
        let target_rules = split_rules
            .iter()
            .filter(|rule| rule.context_path == original_context)
            .collect::<Vec<_>>();
        assert_eq!(target_rules.len(), 3);
        assert_eq!(
            target_rules
                .iter()
                .map(|rule| rule.selector.as_str())
                .collect::<Vec<_>>(),
            vec![":global(.astro-one)", ":global(.astro-two)", ".third"]
        );
        for rule in &target_rules {
            assert_eq!(
                &split_source[rule.block_inner_start..rule.block_inner_end],
                original_target_body.as_str()
            );
            assert_eq!(rule.context_path, original_context);
        }
        assert!(split_source.starts_with(&original_prefix));
        assert!(original_split_source.starts_with(&original_prefix));
        assert!(split_source.ends_with("}\n.after { color: blue; }\n/* untouched tail */\n"));
        assert_eq!(split_result.selected.matched_selector, ".third");
        assert_eq!(
            split_result
                .remapped_rules
                .iter()
                .filter(|mapping| mapping.old_selector_offset == target_identity.selector_offset)
                .count(),
            3
        );
        for old in [&before_identity, &target_identity, &after_identity] {
            let mapping = split_result
                .remapped_rules
                .iter()
                .find(|mapping| {
                    mapping.old_selector_offset == old.selector_offset
                        && mapping.selector_member_index == old.selector_member_index
                })
                .expect("each original rule member receives an exact refreshed identity");
            css_rule_mutations::resolve_identity(file, &split_source, &mapping.identity)
                .expect("every source member maps to its current selector and source snapshot");
        }
        assert!(css_rule_mutations::split_selector_list(
            file,
            &split_source.replace("color: red", "color: green"),
            &target_identity,
        )
        .is_err());
        assert!(super::validate_selector_list(
            r#":is(.one, .two), [data-label="a,b"], .escaped\,comma"#
        )
        .is_ok());
        assert!(super::validate_selector_list(".one,, .two").is_err());
    }
}
