//! # Structural element editing — insert / duplicate / delete
//!
//! Webflow-style structural edits committed straight to source. All three
//! operations anchor on the same class-literal resolution as the rest of the
//! visual editor ([`locate_element`]), so they inherit its fail-closed
//! behavior: dynamic or ambiguous (`Multi`) elements refuse with an "ask your
//! agent" message rather than guessing a write target.
//!
//! New elements get a generated `ss-<tag>-<suffix>` class. That's not
//! cosmetic: source resolution is class-anchored, so an element without a
//! unique static class could never be selected, styled, or edited again after
//! insertion. The class also gives CSS Mode a natural selector to create rules
//! under; users can rename it in the element settings panel. A duplicate keeps
//! every original class (pixel-identical styling) plus one generated token —
//! identical class literals would resolve `Multi` and dead-end every future
//! edit on both copies.
//!
//! Splices are indentation-aware but string-surgical (no HTML parser), in the
//! same spirit as the rest of the edit engine: everything outside the touched
//! span is preserved byte-for-byte.

use crate::commands::edit::{
    attrs_for_path, class_token_in_index, find_attr_spans, invalidate_index_cache, locate_element,
    open_tag_end, ElementSignature,
};
use crate::commands::edit_css::css_class_exists;
use crate::errors::CommandError;
use crate::utils::{classify_fs_error, validate_project_path};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Where the new element lands relative to the selected anchor element.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InsertPosition {
    Before,
    After,
    /// Appended as the anchor's last child.
    Inside,
}

/// The committed element, echoed back so the frontend can reselect it after
/// the dev server reloads (`class_name` is the element's full class attribute
/// value — the reselect signature's key).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertedElement {
    pub file: String,
    pub line: usize,
    pub class_name: String,
    pub tag_name: String,
}

/// The insertable primitives. Kind == tag; the frontend mirrors this list for
/// the palette (`ELEMENT_KINDS` in `src/lib/edit-structure.ts`).
const ELEMENT_KINDS: &[&str] = &[
    "div", "section", "h1", "h2", "h3", "p", "a", "button", "img", "ul", "span",
];

/// Tags whose removal or displacement would break the document itself.
const STRUCTURAL_TAGS: &[&str] = &["html", "head", "body"];

fn validation(field: &str, reason: impl Into<String>) -> CommandError {
    CommandError::Validation {
        field: field.into(),
        reason: reason.into(),
    }
}

/// The class-bearing attribute to author on a NEW element in `file`. Distinct
/// from [`attrs_for_path`] (the scan set): Astro scans both `class` and
/// `className`, but new Astro template markup is authored with `class`.
fn class_attr_for_path(file: &str) -> &'static str {
    let ext = file.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "tsx" | "jsx" => "className",
        _ => "class",
    }
}

/// Markup for a new element of `kind`, with `unit` as its internal indentation
/// step. Placeholder text is mirrored by the frontend's `ELEMENT_KINDS` so the
/// post-insert reselect signature matches what lands in the DOM.
fn render_template(kind: &str, attr: &str, class: &str, unit: &str) -> Option<String> {
    Some(match kind {
        "div" => format!("<div {attr}=\"{class}\"></div>"),
        "section" => format!("<section {attr}=\"{class}\"></section>"),
        "h1" | "h2" | "h3" => format!("<{kind} {attr}=\"{class}\">Heading</{kind}>"),
        "p" => format!("<p {attr}=\"{class}\">Write something here.</p>"),
        "a" => format!("<a {attr}=\"{class}\" href=\"#\">Link</a>"),
        "button" => format!("<button {attr}=\"{class}\">Button</button>"),
        "span" => format!("<span {attr}=\"{class}\">Text</span>"),
        "img" => format!(
            "<img {attr}=\"{class}\" src=\"https://placehold.co/600x400\" alt=\"Placeholder\" />"
        ),
        "ul" => format!("<ul {attr}=\"{class}\">\n{unit}<li>List item</li>\n</ul>"),
        _ => return None,
    })
}

/// A generated class that collides with nothing: not a token in any indexed
/// class literal, not a class in any stylesheet. The uuid suffix makes retries
/// independent; after 12 misses fall back to a suffix long enough that a
/// collision would mean the project already contains that exact uuid.
fn generate_class(root: &Path, tag: &str) -> String {
    for _ in 0..12 {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let candidate = format!("ss-{tag}-{}", &id[..4]);
        if !class_token_in_index(root, &candidate) && !css_class_exists(root, &candidate) {
            return candidate;
        }
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("ss-{tag}-{}", &id[..12])
}

// ───────────────────────────── indentation helpers ──────────────────────────

/// Start offset of the line containing `offset`.
fn line_start(src: &str, offset: usize) -> usize {
    src[..offset].rfind('\n').map(|i| i + 1).unwrap_or(0)
}

/// The line's leading whitespace when `offset` is preceded only by whitespace
/// on its line (the span starts its line) — None when content precedes it,
/// i.e. the anchor flows inline and newline-splices would reformat siblings.
fn block_indent(src: &str, offset: usize) -> Option<&str> {
    let ls = line_start(src, offset);
    let prefix = &src[ls..offset];
    prefix
        .bytes()
        .all(|b| b == b' ' || b == b'\t')
        .then_some(prefix)
}

/// True when everything from `offset` to the end of its line is whitespace.
fn rest_of_line_blank(src: &str, offset: usize) -> bool {
    src[offset..]
        .bytes()
        .take_while(|&b| b != b'\n')
        .all(|b| b == b' ' || b == b'\t' || b == b'\r')
}

/// One indentation step, inferred from the anchor's own indent (tabs beget
/// tabs; spaces default to two).
fn indent_unit(anchor_indent: &str) -> &'static str {
    if anchor_indent.contains('\t') {
        "\t"
    } else {
        "  "
    }
}

/// Prefix every line after the first with `indent` (the first line inherits
/// the insertion point's own indentation).
fn reindent(snippet: &str, indent: &str) -> String {
    snippet.replace('\n', &format!("\n{indent}"))
}

/// Collapse a multi-line snippet to one line for inline insertion.
fn collapse_inline(snippet: &str) -> String {
    snippet.split('\n').map(str::trim).collect()
}

/// Indentation of the anchor's first child that sits on its own line.
fn first_child_indent(inner: &str) -> Option<&str> {
    for line in inner.split('\n').skip(1) {
        let trimmed = line.trim_start_matches([' ', '\t']);
        if !trimmed.is_empty() {
            return Some(&line[..line.len() - trimmed.len()]);
        }
    }
    None
}

/// 1-based line number of byte `offset` in `src`.
fn line_of(src: &str, offset: usize) -> usize {
    src.as_bytes()[..offset]
        .iter()
        .filter(|&&b| b == b'\n')
        .count()
        + 1
}

// ───────────────────────────── splice core ──────────────────────────────────

/// Splice `snippet` into `src` relative to the anchor span `[start, end)`.
/// Returns the updated source and the byte offset where the snippet begins.
/// Line-anchored elements get newline + matched-indent splices; inline anchors
/// get the snippet collapsed to one line so sibling text doesn't reflow.
fn splice_snippet(
    src: &str,
    start: usize,
    end: usize,
    position: InsertPosition,
    snippet: &str,
) -> Result<(String, usize), CommandError> {
    let (at, pre, body, post) = match position {
        InsertPosition::Before => match block_indent(src, start) {
            Some(indent) => (
                start,
                String::new(),
                reindent(snippet, indent),
                format!("\n{indent}"),
            ),
            None => (
                start,
                String::new(),
                collapse_inline(snippet),
                String::new(),
            ),
        },
        InsertPosition::After => {
            match block_indent(src, start).filter(|_| rest_of_line_blank(src, end)) {
                Some(indent) => (
                    end,
                    format!("\n{indent}"),
                    reindent(snippet, indent),
                    String::new(),
                ),
                None => (end, String::new(), collapse_inline(snippet), String::new()),
            }
        }
        InsertPosition::Inside => return splice_inside(src, start, end, snippet),
    };
    Ok(splice_at(src, at, &pre, &body, &post))
}

/// Append `snippet` as the anchor's last child, before its closing tag.
fn splice_inside(
    src: &str,
    start: usize,
    end: usize,
    snippet: &str,
) -> Result<(String, usize), CommandError> {
    let bytes = src.as_bytes();
    let gt = open_tag_end(src, start + 1)
        .ok_or_else(|| validation("element", "couldn't parse the element's opening tag"))?;
    let open_end = gt + 1;
    // An open-tag-only span (void element or self-closing) has no inside.
    if open_end >= end {
        return Err(validation(
            "position",
            "This element can't contain children — insert before or after it instead.",
        ));
    }
    let close_start = start
        + src[start..end]
            .rfind("</")
            .ok_or_else(|| validation("element", "couldn't find the element's closing tag"))?;
    let inner = &src[open_end..close_start];

    if !inner.contains('\n') {
        // Single-line element: keep it single-line.
        return Ok(splice_at(
            src,
            close_start,
            "",
            &collapse_inline(snippet),
            "",
        ));
    }

    let anchor_indent = block_indent(src, start).unwrap_or("");
    let child_indent = first_child_indent(inner)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{anchor_indent}{}", indent_unit(anchor_indent)));

    // Whitespace run immediately before the closing tag.
    let mut ws_start = close_start;
    while ws_start > open_end && matches!(bytes[ws_start - 1], b' ' | b'\t') {
        ws_start -= 1;
    }
    if bytes[ws_start - 1] == b'\n' {
        // Closing tag sits on its own line: slot the new child in just above it.
        Ok(splice_at(
            src,
            ws_start,
            &child_indent,
            &reindent(snippet, &child_indent),
            "\n",
        ))
    } else {
        Ok(splice_at(
            src,
            close_start,
            &format!("\n{child_indent}"),
            &reindent(snippet, &child_indent),
            &format!("\n{anchor_indent}"),
        ))
    }
}

/// Insert `pre + body + post` at `at`; the returned offset is where `body`
/// (the element markup itself) begins.
fn splice_at(src: &str, at: usize, pre: &str, body: &str, post: &str) -> (String, usize) {
    let mut updated = String::with_capacity(src.len() + pre.len() + body.len() + post.len());
    updated.push_str(&src[..at]);
    updated.push_str(pre);
    updated.push_str(body);
    updated.push_str(post);
    updated.push_str(&src[at..]);
    (updated, at + pre.len())
}

/// Remove the span, plus its whole line(s) when it sat alone on them — never
/// leave a blank line behind, never shift inline siblings.
fn remove_span(src: &str, start: usize, end: usize) -> String {
    let (mut s, mut e) = (start, end);
    if block_indent(src, start).is_some() && rest_of_line_blank(src, end) {
        s = line_start(src, start);
        e = src[end..]
            .find('\n')
            .map(|i| end + i + 1)
            .unwrap_or(src.len());
    }
    format!("{}{}", &src[..s], &src[e..])
}

/// Append ` token` inside the FIRST class attribute of the copy's own opening
/// tag (the copy starts at its `<`, so the first class-bearing attribute before
/// the tag's own `>` is the element's own — children come later).
///
/// The tag end comes from the `{…}`-aware [`open_tag_end`], not a bare `>` scan:
/// a JSX handler prop before className (`onClick={() => go()}`) hides a `>` that
/// would otherwise end the tag early, push the real className span past `gt`, and
/// send us down the class-less path — splicing in a SECOND className attribute
/// and writing a compile error into the user's source (issue #789).
///
/// A class-less element has no attribute to append to, so `new_attr` is spliced
/// in fresh right after the tag name instead — the copy still needs a unique
/// class of its own to stay selectable (issue #318).
fn append_class_token(copy: &str, attrs: &[&str], token: &str, new_attr: &str) -> Option<String> {
    let bytes = copy.as_bytes();
    let gt = open_tag_end(copy, 1)?;
    if let Some(span) = find_attr_spans(copy, attrs)
        .into_iter()
        .find(|s| s.value_end <= gt)
    {
        return Some(format!(
            "{} {token}{}",
            &copy[..span.value_end],
            &copy[span.value_end..]
        ));
    }
    let mut name_end = 1;
    while name_end < gt && (bytes[name_end].is_ascii_alphanumeric() || bytes[name_end] == b'-') {
        name_end += 1;
    }
    (name_end > 1).then(|| {
        format!(
            "{} {new_attr}=\"{token}\"{}",
            &copy[..name_end],
            &copy[name_end..]
        )
    })
}

/// The tag name at the start of an element span (`<tag …`), lowercased.
fn span_tag(src: &str, start: usize) -> String {
    let bytes = src.as_bytes();
    let mut j = start + 1;
    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-') {
        j += 1;
    }
    src[start + 1..j].to_ascii_lowercase()
}

// ───────────────────────────── commands ─────────────────────────────────────

/// Insert a new element of `element_kind` before/after/inside the selected
/// element, committed straight to source. Returns the generated class so the
/// frontend can reselect the element once the dev server reloads.
#[tauri::command]
#[tracing::instrument(skip(signature), fields(project = %project_path))]
pub fn insert_element(
    project_path: String,
    signature: ElementSignature,
    position: InsertPosition,
    element_kind: String,
) -> Result<InsertedElement, CommandError> {
    let kind = element_kind.as_str();
    if !ELEMENT_KINDS.contains(&kind) {
        return Err(validation(
            "element_kind",
            format!("unknown element kind '{kind}'"),
        ));
    }
    let (file, abs, src, _line, start, end) = locate_element(&project_path, signature)?;
    let anchor_tag = span_tag(&src, start);
    if position != InsertPosition::Inside && STRUCTURAL_TAGS.contains(&anchor_tag.as_str()) {
        return Err(validation(
            "position",
            format!("Can't insert next to <{anchor_tag}> — insert inside it instead."),
        ));
    }
    let root = validate_project_path(&project_path)?;
    let class = generate_class(&root, kind);
    let attr = class_attr_for_path(&file);
    let anchor_indent = block_indent(&src, start).unwrap_or("");
    let snippet =
        render_template(kind, attr, &class, indent_unit(anchor_indent)).expect("kind validated");
    let (updated, offset) = splice_snippet(&src, start, end, position, &snippet)?;
    std::fs::write(&abs, &updated)
        .map_err(|e| classify_fs_error("save your change to this file", &abs, &e))?;
    invalidate_index_cache(&root);
    Ok(InsertedElement {
        file,
        line: line_of(&updated, offset),
        class_name: class,
        tag_name: kind.to_string(),
    })
}

/// Duplicate the selected element right after itself. The copy keeps every
/// original class (identical styling) plus one generated token so both copies
/// keep resolving to distinct source literals.
#[tauri::command]
#[tracing::instrument(skip(signature), fields(project = %project_path))]
pub fn duplicate_element(
    project_path: String,
    signature: ElementSignature,
) -> Result<InsertedElement, CommandError> {
    let sig_class = signature.class_name.clone();
    let (file, abs, src, _line, start, end) = locate_element(&project_path, signature)?;
    let tag = span_tag(&src, start);
    if STRUCTURAL_TAGS.contains(&tag.as_str()) {
        return Err(validation(
            "element",
            format!("<{tag}> can't be duplicated."),
        ));
    }
    let root = validate_project_path(&project_path)?;
    let token = generate_class(&root, &tag);
    let copy = append_class_token(
        &src[start..end],
        attrs_for_path(&file),
        &token,
        class_attr_for_path(&file),
    )
    .ok_or_else(|| {
        validation(
            "element",
            "couldn't find the element's class attribute to distinguish the copy",
        )
    })?;
    // A line-anchored element gets its copy on the next line at the same depth.
    // The copy's inner lines already carry their absolute indentation — no
    // reindent. Inline anchors keep flowing inline.
    let (updated, offset) =
        match block_indent(&src, start).filter(|_| rest_of_line_blank(&src, end)) {
            Some(indent) => splice_at(&src, end, &format!("\n{indent}"), &copy, ""),
            None => splice_at(&src, end, "", &copy, ""),
        };
    std::fs::write(&abs, &updated)
        .map_err(|e| classify_fs_error("save your change to this file", &abs, &e))?;
    invalidate_index_cache(&root);
    Ok(InsertedElement {
        file,
        line: line_of(&updated, offset),
        // A class-less original contributes nothing, so the copy's class is the
        // generated token alone — never a leading space (issue #318).
        class_name: format!("{} {token}", sig_class.trim()).trim().to_string(),
        tag_name: tag,
    })
}

/// Delete the selected element's source markup, drift-guarded against
/// `old_html` (from `resolve_element_html` at action time).
#[tauri::command]
#[tracing::instrument(skip(signature, old_html), fields(project = %project_path))]
pub fn delete_element(
    project_path: String,
    signature: ElementSignature,
    old_html: String,
) -> Result<(), CommandError> {
    let (_file, abs, src, _line, start, end) = locate_element(&project_path, signature)?;
    if src[start..end] != old_html {
        return Err(validation(
            "old_html",
            "source no longer matches — reselect the element",
        ));
    }
    let tag = span_tag(&src, start);
    if STRUCTURAL_TAGS.contains(&tag.as_str()) {
        return Err(validation("element", format!("<{tag}> can't be deleted.")));
    }
    let updated = remove_span(&src, start, end);
    std::fs::write(&abs, updated)
        .map_err(|e| classify_fs_error("save your change to this file", &abs, &e))?;
    let root = validate_project_path(&project_path)?;
    invalidate_index_cache(&root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::edit::element_span;

    /// Span of the element whose opening tag contains `marker`.
    fn span_of(src: &str, marker: &str) -> (usize, usize) {
        let at = src.find(marker).unwrap();
        element_span(src, at).unwrap()
    }

    #[test]
    fn insert_before_matches_indentation() {
        let src = "<main>\n    <div class=\"cls\">Hi</div>\n</main>\n";
        let (s, e) = span_of(src, "cls");
        let (updated, offset) =
            splice_snippet(src, s, e, InsertPosition::Before, "<p class=\"x\">T</p>").unwrap();
        assert_eq!(
            updated,
            "<main>\n    <p class=\"x\">T</p>\n    <div class=\"cls\">Hi</div>\n</main>\n"
        );
        assert_eq!(line_of(&updated, offset), 2);
    }

    #[test]
    fn insert_after_matches_tab_indentation() {
        let src = "<main>\n\t<div class=\"cls\">Hi</div>\n</main>\n";
        let (s, e) = span_of(src, "cls");
        let (updated, offset) =
            splice_snippet(src, s, e, InsertPosition::After, "<p class=\"x\">T</p>").unwrap();
        assert_eq!(
            updated,
            "<main>\n\t<div class=\"cls\">Hi</div>\n\t<p class=\"x\">T</p>\n</main>\n"
        );
        assert_eq!(line_of(&updated, offset), 3);
    }

    #[test]
    fn insert_after_inline_anchor_stays_inline() {
        let src = "<p>a <span class=\"cls\">b</span> c</p>";
        let (s, e) = span_of(src, "cls");
        let (updated, _) = splice_snippet(
            src,
            s,
            e,
            InsertPosition::After,
            "<span class=\"x\">T</span>",
        )
        .unwrap();
        assert_eq!(
            updated,
            "<p>a <span class=\"cls\">b</span><span class=\"x\">T</span> c</p>"
        );
    }

    #[test]
    fn insert_inside_multiline_uses_child_indent() {
        let src = "<div class=\"wrap\">\n  <p class=\"cls\">Hi</p>\n</div>\n";
        let (s, e) = span_of(src, "wrap");
        let (updated, _) =
            splice_snippet(src, s, e, InsertPosition::Inside, "<p class=\"x\">T</p>").unwrap();
        assert_eq!(
            updated,
            "<div class=\"wrap\">\n  <p class=\"cls\">Hi</p>\n  <p class=\"x\">T</p>\n</div>\n"
        );
    }

    #[test]
    fn insert_inside_multiline_snippet_reindents() {
        let src = "<div class=\"wrap\">\n    <p class=\"cls\">Hi</p>\n</div>\n";
        let (s, e) = span_of(src, "wrap");
        let snippet = render_template("ul", "class", "x", "  ").unwrap();
        let (updated, _) = splice_snippet(src, s, e, InsertPosition::Inside, &snippet).unwrap();
        assert_eq!(
            updated,
            "<div class=\"wrap\">\n    <p class=\"cls\">Hi</p>\n    <ul class=\"x\">\n      <li>List item</li>\n    </ul>\n</div>\n"
        );
    }

    #[test]
    fn insert_inside_single_line_anchor_stays_inline() {
        let src = "<main>\n  <div class=\"cls\"></div>\n</main>";
        let (s, e) = span_of(src, "cls");
        let (updated, _) =
            splice_snippet(src, s, e, InsertPosition::Inside, "<p class=\"x\">T</p>").unwrap();
        assert_eq!(
            updated,
            "<main>\n  <div class=\"cls\"><p class=\"x\">T</p></div>\n</main>"
        );
    }

    #[test]
    fn insert_inside_void_or_self_closing_is_refused() {
        for src in [
            "<div><img class=\"cls\" src=\"a.png\" /></div>",
            "<div><br class=\"cls\"></div>",
            "<div><Card class=\"cls\" /></div>",
        ] {
            let (s, e) = span_of(src, "cls");
            let err = splice_snippet(src, s, e, InsertPosition::Inside, "<p>T</p>");
            assert!(err.is_err(), "expected refusal for {src}");
        }
    }

    #[test]
    fn delete_removes_whole_line() {
        let src = "<div>\n  <p class=\"cls\">x</p>\n  <p>keep</p>\n</div>";
        let (s, e) = span_of(src, "cls");
        assert_eq!(remove_span(src, s, e), "<div>\n  <p>keep</p>\n</div>");
    }

    #[test]
    fn delete_multiline_span_leaves_no_blank_lines() {
        let src = "<main>\n  <div class=\"cls\">\n    <p>a</p>\n  </div>\n  <p>keep</p>\n</main>";
        let (s, e) = span_of(src, "cls");
        assert_eq!(remove_span(src, s, e), "<main>\n  <p>keep</p>\n</main>");
    }

    #[test]
    fn delete_inline_leaves_siblings() {
        let src = "<p>a <span class=\"cls\">b</span> c</p>";
        let (s, e) = span_of(src, "cls");
        assert_eq!(remove_span(src, s, e), "<p>a  c</p>");
    }

    #[test]
    fn duplicate_token_lands_on_own_tag_not_children() {
        let copy = "<div class=\"a b\">\n  <span class=\"c\">x</span>\n</div>";
        let out = append_class_token(copy, &["class"], "ss-div-1234", "class").unwrap();
        assert_eq!(
            out,
            "<div class=\"a b ss-div-1234\">\n  <span class=\"c\">x</span>\n</div>"
        );
    }

    #[test]
    fn duplicate_token_handles_jsx_brace_form() {
        let copy = "<div className={\"a\"}>x</div>";
        let out = append_class_token(copy, &["className"], "t0k3", "className").unwrap();
        assert_eq!(out, "<div className={\"a t0k3\"}>x</div>");
    }

    #[test]
    fn duplicate_token_survives_a_handler_prop_before_classname() {
        // Issue #789: a bare `>` scan stops at the arrow in `=>`, so the real
        // className span lands past the tag end and the class-less path splices
        // in a SECOND className — a TSX compile error written into user source.
        let copy = "<div onClick={() => go()} className=\"a\">x</div>";
        let out = append_class_token(copy, &["className"], "t0k3", "className").unwrap();
        assert_eq!(
            out,
            "<div onClick={() => go()} className=\"a t0k3\">x</div>"
        );
        assert_eq!(out.matches("className").count(), 1);
    }

    #[test]
    fn insert_inside_survives_a_handler_prop_with_a_gt() {
        // Same `{…}`-aware scan on the opening tag that bounds `Inside` inserts:
        // stopping at the arrow's `>` would misplace the child.
        let src = "<div onClick={() => go()} className=\"a\">x</div>";
        let (out, _) = splice_inside(src, 0, src.len(), "<p>new</p>").unwrap();
        assert_eq!(
            out,
            "<div onClick={() => go()} className=\"a\">x<p>new</p></div>"
        );
    }

    #[test]
    fn duplicate_token_inserts_a_fresh_attribute_on_a_classless_element() {
        // Issue #318: a class-less element has nothing to append to, but the
        // copy still needs its own unique class to stay selectable.
        let copy = "<section id=\"hero\">\n  <span class=\"c\">x</span>\n</section>";
        let out = append_class_token(copy, &["class"], "ss-section-1234", "class").unwrap();
        assert_eq!(
            out,
            "<section class=\"ss-section-1234\" id=\"hero\">\n  <span class=\"c\">x</span>\n</section>"
        );
        // JSX authors `className`, and a self-closing tag is spliced the same way.
        let jsx = append_class_token("<div />", &["className"], "t0k3", "className").unwrap();
        assert_eq!(jsx, "<div className=\"t0k3\" />");
    }

    #[test]
    fn templates_use_classname_for_jsx_and_selfclose_img() {
        assert_eq!(class_attr_for_path("src/App.tsx"), "className");
        assert_eq!(class_attr_for_path("src/pages/index.astro"), "class");
        assert_eq!(class_attr_for_path("index.html"), "class");
        let img = render_template("img", "className", "x", "  ").unwrap();
        assert!(img.starts_with("<img className=\"x\"") && img.ends_with("/>"));
        assert!(render_template("marquee", "class", "x", "  ").is_none());
    }

    #[test]
    fn collapse_inline_flattens_multiline_template() {
        let ul = render_template("ul", "class", "x", "  ").unwrap();
        assert_eq!(
            collapse_inline(&ul),
            "<ul class=\"x\"><li>List item</li></ul>"
        );
    }

    #[test]
    fn span_tag_reads_anchor_tag() {
        assert_eq!(span_tag("<Body class=\"x\">", 0), "body");
        assert_eq!(span_tag("<my-el class=\"x\">", 0), "my-el");
    }
}
