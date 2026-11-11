//! # Structural element editing — insert / duplicate / delete / paste
//!
//! Webflow-style structural edits committed straight to source. These
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
    attrs_for_path, class_token_in_index, content_hash, element_span, find_attr_spans,
    invalidate_index_cache, locate_element, open_tag_end, ElementSignature,
};
use crate::commands::edit_css::css_class_exists;
use crate::errors::CommandError;
use crate::utils::{classify_fs_error, validate_project_path};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;

/// Exact source markup selected by the drag gesture. The class resolver remains
/// the default fallback, but a drag may have selected one of several identical
/// class literals; this proof keeps the move tied to that authored span.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExactSourceTarget {
    pub file: String,
    pub start: usize,
    pub end: usize,
    pub expected_hash: String,
    pub expected_html: String,
}

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
const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

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

/// Read and validate a byte-exact element span supplied by the drag resolver.
/// This path deliberately does not consult the class index: repeated class
/// literals are valid here because the preview supplied the selected instance.
fn locate_exact_element(
    project_path: &str,
    target: ExactSourceTarget,
) -> Result<(String, std::path::PathBuf, String, usize, usize, usize), CommandError> {
    if target.file.is_empty()
        || target.file.contains('\0')
        || target.file.contains('\\')
        || Path::new(&target.file).is_absolute()
        || target
            .file
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(validation(
            "sourceTarget.file",
            "the drag source target must be a normalized project-relative path",
        ));
    }
    if target.start >= target.end
        || target.expected_hash.is_empty()
        || target.expected_html.is_empty()
    {
        return Err(validation(
            "sourceTarget",
            "the drag source target must include a non-empty range, hash, and markup",
        ));
    }

    let root = validate_project_path(project_path)?;
    let abs = root.join(&target.file);
    let canonical_root = root
        .canonicalize()
        .map_err(|error| classify_fs_error("inspect the project root", &root, &error))?;
    let canonical_file = abs
        .canonicalize()
        .map_err(|error| classify_fs_error("open this drag source file", &abs, &error))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(validation(
            "sourceTarget.file",
            "the drag source target is outside the project",
        ));
    }
    if std::fs::symlink_metadata(&abs)
        .map_err(|error| classify_fs_error("inspect this drag source file", &abs, &error))?
        .file_type()
        .is_symlink()
    {
        return Err(validation(
            "sourceTarget.file",
            "the drag source target is a symlink",
        ));
    }
    let src = std::fs::read_to_string(&abs)
        .map_err(|error| classify_fs_error("open this drag source file", &abs, &error))?;
    if content_hash(src.as_bytes()) != target.expected_hash {
        return Err(validation(
            "sourceTarget.expectedHash",
            "the source changed before the move; refresh and try again",
        ));
    }
    if target.end > src.len()
        || !src.is_char_boundary(target.start)
        || !src.is_char_boundary(target.end)
        || src.as_bytes().get(target.start) != Some(&b'<')
        || src[target.start..target.end] != target.expected_html
    {
        return Err(validation(
            "sourceTarget",
            "the dragged element no longer matches its source markup",
        ));
    }
    let (start, end) = element_span(&src, target.start).ok_or_else(|| {
        validation(
            "sourceTarget",
            "the drag source range is not a complete element",
        )
    })?;
    if start != target.start || end != target.end {
        return Err(validation(
            "sourceTarget",
            "the drag source range does not cover exactly the selected element",
        ));
    }
    Ok((
        target.file,
        abs,
        src.clone(),
        line_of(&src, start),
        start,
        end,
    ))
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
    let (s, e) = removed_range(src, start, end);
    format!("{}{}", &src[..s], &src[e..])
}

/// Return the exact byte range removed for a line-anchored element. Keeping
/// this range lets a move recompute the target offset after the source subtree
/// is removed without ever resolving an ephemeral DOM id in source.
fn removed_range(src: &str, start: usize, end: usize) -> (usize, usize) {
    let (mut s, mut e) = (start, end);
    if block_indent(src, start).is_some() && rest_of_line_blank(src, end) {
        s = line_start(src, start);
        e = src[end..]
            .find('\n')
            .map(|i| end + i + 1)
            .unwrap_or(src.len());
    }
    (s, e)
}

/// Strip the source row's absolute indentation while preserving the moved
/// subtree's relative indentation. `splice_snippet` then applies the target
/// row's indentation exactly once.
fn dedent_snippet(snippet: &str, source_indent: &str) -> String {
    if source_indent.is_empty() {
        return snippet.to_string();
    }
    snippet
        .split('\n')
        .map(|line| line.strip_prefix(source_indent).unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Replace a project file through a same-directory temporary file so a move
/// cannot leave a half-written source file after a process or disk failure.
fn atomic_write(path: &Path, contents: &str) -> Result<(), CommandError> {
    let parent = path
        .parent()
        .ok_or_else(|| validation("file", "edit target has no parent"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| classify_fs_error("prepare your source change", path, &e))?;
    temp.write_all(contents.as_bytes())
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| classify_fs_error("save your change to this file", path, &e))?;
    std::fs::rename(temp.path(), path)
        .map_err(|e| classify_fs_error("save your change to this file", path, &e))
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

/// Whether an element has an authored JSX element/fragment around it. Sibling
/// insertion is only syntactically valid inside one of these parents; inserting
/// beside a component's sole returned JSX root creates adjacent expressions.
fn has_jsx_parent(src: &str, start: usize, end: usize) -> bool {
    let mut before = start;
    while let Some(open) = src[..before].rfind('<') {
        before = open;
        let Some(first) = src.as_bytes().get(open + 1).copied() else {
            continue;
        };
        if !first.is_ascii_alphabetic() {
            continue;
        }
        if let Some((parent_start, parent_end)) = crate::commands::edit::element_span(src, open + 1)
        {
            if parent_start == open && parent_start < start && parent_end >= end {
                return true;
            }
        }
    }

    // JSX fragments (`<>…</>`) are valid sibling containers too. Track the
    // fragment nesting depth at the anchor and require a closing fragment after it.
    let bytes = src.as_bytes();
    let (mut i, mut fragment_depth) = (0, 0usize);
    while i < start {
        if bytes.get(i..i + 3) == Some(b"</>") {
            fragment_depth = fragment_depth.saturating_sub(1);
            i += 3;
        } else if bytes.get(i..i + 2) == Some(b"<>") {
            fragment_depth += 1;
            i += 2;
        } else {
            i += 1;
        }
    }
    fragment_depth > 0 && src[end..].contains("</>")
}

fn is_jsx_path(file: &str) -> bool {
    matches!(
        file.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "jsx" | "tsx"
    )
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
    if position != InsertPosition::Inside && is_jsx_path(&file) && !has_jsx_parent(&src, start, end)
    {
        return Err(validation(
            "position",
            "This is the component's outer JSX element, so it can't have a sibling here. Choose Inside to add a child.",
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

/// Paste a captured element subtree inside the selected element. The pasted
/// root receives a fresh class token so it remains uniquely editable even when
/// the source was copied rather than cut.
#[tauri::command]
#[tracing::instrument(skip(signature, html), fields(project = %project_path))]
pub fn paste_element(
    project_path: String,
    signature: ElementSignature,
    html: String,
    source_class_name: String,
) -> Result<InsertedElement, CommandError> {
    let snippet = html.trim();
    if !snippet.starts_with('<') {
        return Err(validation(
            "html",
            "The copied element markup could not be read — copy it again and try again.",
        ));
    }
    let tag = span_tag(snippet, 0);
    if tag.is_empty() {
        return Err(validation(
            "html",
            "The copied element markup could not be read — copy it again and try again.",
        ));
    }
    if STRUCTURAL_TAGS.contains(&tag.as_str()) {
        return Err(validation(
            "html",
            format!("<{tag}> can't be pasted inside another element."),
        ));
    }

    let (file, abs, src, _line, start, end) = locate_element(&project_path, signature)?;
    let root = validate_project_path(&project_path)?;
    let token = generate_class(&root, &tag);
    let copy = append_class_token(
        snippet,
        &["class", "className"],
        &token,
        class_attr_for_path(&file),
    )
    .ok_or_else(|| {
        validation(
            "html",
            "The copied element markup could not be distinguished from its source.",
        )
    })?;
    let (updated, offset) = splice_snippet(&src, start, end, InsertPosition::Inside, &copy)?;
    std::fs::write(&abs, &updated)
        .map_err(|e| classify_fs_error("save your change to this file", &abs, &e))?;
    invalidate_index_cache(&root);
    Ok(InsertedElement {
        file,
        line: line_of(&updated, offset),
        class_name: format!("{} {token}", source_class_name.trim())
            .trim()
            .to_string(),
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

/// Move one complete element subtree relative to fresh source snapshots.
/// Both signatures and authored HTML snapshots are resolved independently at
/// drop time and compared exactly before writing. An HMR/source edit between
/// resolution and this command therefore fails closed instead of moving a
/// stale DOM node into the wrong file.
#[tauri::command]
#[tracing::instrument(skip(source_signature, target_signature, source_html, target_html), fields(project = %project_path))]
pub fn move_element(
    project_path: String,
    source_signature: ElementSignature,
    target_signature: ElementSignature,
    source_html: String,
    target_html: String,
    position: InsertPosition,
    source_target: Option<ExactSourceTarget>,
    target_target: Option<ExactSourceTarget>,
) -> Result<InsertedElement, CommandError> {
    let (source_file, _source_abs, source_src, _source_line, source_start, source_end) =
        match source_target {
            Some(target) => locate_exact_element(&project_path, target)?,
            None => locate_element(&project_path, source_signature)?,
        };
    let (target_file, target_abs, target_src, _target_line, target_start, target_end) =
        match target_target {
            Some(target) => locate_exact_element(&project_path, target)?,
            None => locate_element(&project_path, target_signature)?,
        };
    if source_file != target_file {
        return Err(validation(
            "target",
            "source and target must belong to the same source file",
        ));
    }
    if source_start == target_start {
        return Err(validation(
            "target",
            "an element cannot be moved relative to itself",
        ));
    }
    if source_start < target_start && target_start < source_end {
        return Err(validation(
            "target",
            "an element cannot be moved inside its own descendant",
        ));
    }
    if source_src[source_start..source_end] != source_html {
        return Err(validation(
            "source_html",
            "source no longer matches — reselect the element",
        ));
    }
    if target_src[target_start..target_end] != target_html {
        return Err(validation(
            "target_html",
            "target no longer matches — reselect the element",
        ));
    }

    let source_tag = span_tag(&source_src, source_start);
    let target_tag = span_tag(&target_src, target_start);
    if STRUCTURAL_TAGS.contains(&source_tag.as_str()) {
        return Err(validation(
            "source",
            format!("<{source_tag}> cannot be moved"),
        ));
    }
    if position == InsertPosition::Inside && VOID_ELEMENTS.contains(&target_tag.as_str()) {
        return Err(validation(
            "position",
            format!("<{target_tag}> cannot contain children"),
        ));
    }
    if position != InsertPosition::Inside && STRUCTURAL_TAGS.contains(&target_tag.as_str()) {
        return Err(validation(
            "target",
            format!("nothing can be placed beside <{target_tag}>"),
        ));
    }
    if position != InsertPosition::Inside
        && is_jsx_path(&source_file)
        && !has_jsx_parent(&target_src, target_start, target_end)
    {
        return Err(validation(
            "position",
            "this component root cannot have a sibling; choose Inside instead",
        ));
    }

    let root = validate_project_path(&project_path)?;
    let (remove_start, remove_end) = removed_range(&source_src, source_start, source_end);
    let source_indent = block_indent(&source_src, source_start).unwrap_or("");
    let snippet = dedent_snippet(&source_src[source_start..source_end], source_indent);
    let without_source = format!(
        "{}{}",
        &source_src[..remove_start],
        &source_src[remove_end..]
    );
    let shift = remove_end.saturating_sub(remove_start);
    let target_start_after = if target_start > remove_end {
        target_start - shift
    } else {
        target_start
    };
    let target_end_after = if target_end > remove_end {
        target_end - shift
    } else {
        target_end
    };
    let (updated, offset) = splice_snippet(
        &without_source,
        target_start_after,
        target_end_after,
        position,
        &snippet,
    )?;
    atomic_write(&target_abs, &updated)?;
    invalidate_index_cache(&root);
    Ok(InsertedElement {
        file: target_file,
        line: line_of(&updated, offset),
        class_name: String::new(),
        tag_name: source_tag,
    })
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
    fn jsx_siblings_require_an_authored_parent() {
        let root = "function Page() { return (\n  <div className=\"root\">x</div>\n); }";
        let (root_start, root_end) = span_of(root, "root");
        assert!(!has_jsx_parent(root, root_start, root_end));

        let nested = "function Page() { return (\n  <div><main className=\"child\" /></div>\n); }";
        let (child_start, child_end) = span_of(nested, "child");
        assert!(has_jsx_parent(nested, child_start, child_end));

        let fragment = "function Page() { return (<>\n  <main className=\"child\" />\n</>); }";
        let (fragment_start, fragment_end) = span_of(fragment, "child");
        assert!(has_jsx_parent(fragment, fragment_start, fragment_end));
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

    /// Exercise the same remove/offset/splice sequence as `move_element`
    /// without touching disk. Keeping this fixture helper small makes the
    /// authored-order matrix below explicit while the command tests cover the
    /// resolution, validation and atomic-write boundary separately.
    fn move_fixture(
        src: &str,
        source_marker: &str,
        target_marker: &str,
        position: InsertPosition,
    ) -> String {
        let (source_start, source_end) = span_of(src, source_marker);
        let (target_start, target_end) = span_of(src, target_marker);
        let (remove_start, remove_end) = removed_range(src, source_start, source_end);
        let source_indent = block_indent(src, source_start).unwrap_or("");
        let snippet = dedent_snippet(&src[source_start..source_end], source_indent);
        let without_source = format!("{}{}", &src[..remove_start], &src[remove_end..]);
        let shift = remove_end.saturating_sub(remove_start);
        let target_start_after = if target_start > remove_end {
            target_start - shift
        } else {
            target_start
        };
        let target_end_after = if target_end > remove_end {
            target_end - shift
        } else {
            target_end
        };
        splice_snippet(
            &without_source,
            target_start_after,
            target_end_after,
            position,
            &snippet,
        )
        .unwrap()
        .0
    }

    #[test]
    fn move_same_parent_upward_and_downward_reversal_preserves_authored_order() {
        let src = "<main>\n  <div class=\"a\">A</div>\n  <div class=\"b\">B</div>\n  <div class=\"c\">C</div>\n</main>\n";
        let upward = move_fixture(src, "class=\"c\"", "class=\"a\"", InsertPosition::Before);
        assert_eq!(
            upward,
            "<main>\n  <div class=\"c\">C</div>\n  <div class=\"a\">A</div>\n  <div class=\"b\">B</div>\n</main>\n"
        );
        let downward = move_fixture(&upward, "class=\"c\"", "class=\"b\"", InsertPosition::After);
        assert_eq!(
            downward,
            "<main>\n  <div class=\"a\">A</div>\n  <div class=\"b\">B</div>\n  <div class=\"c\">C</div>\n</main>\n"
        );
    }

    #[test]
    fn move_source_after_target_recomputes_offset_and_moves_out_of_parent() {
        let src = "<main>\n  <div class=\"target\">T</div>\n  <section class=\"parent\">\n    <div class=\"source\">S</div>\n  </section>\n</main>\n";
        let moved = move_fixture(src, "source", "target", InsertPosition::After);
        assert_eq!(
            moved,
            "<main>\n  <div class=\"target\">T</div>\n  <div class=\"source\">S</div>\n  <section class=\"parent\">\n  </section>\n</main>\n"
        );
    }

    #[test]
    fn move_keeps_comments_adjacent_and_relative_multiline_indent() {
        let src = "<main>\n  <!-- before -->\n  <section class=\"source\">\n    <!-- inside -->\n    <p class=\"child\">C</p>\n  </section>\n  <!-- between -->\n  <div class=\"target\">T</div>\n  <!-- after -->\n</main>\n";
        let moved = move_fixture(src, "source", "target", InsertPosition::After);
        assert!(moved.contains("<!-- before -->"));
        assert!(moved.contains("<!-- between -->"));
        assert!(moved.contains("<!-- after -->"));
        assert!(moved.contains("  <div class=\"target\">T</div>\n  <section class=\"source\">\n    <!-- inside -->\n    <p class=\"child\">C</p>\n  </section>"));
    }

    #[test]
    fn move_recomputes_target_after_removing_a_multiline_source() {
        let src = "<main>\n  <section class=\"source\">\n    <p>child</p>\n  </section>\n  <div class=\"target\">target</div>\n</main>\n";
        let (source_start, source_end) = span_of(src, "source");
        let (target_start, target_end) = span_of(src, "target");
        let (remove_start, remove_end) = removed_range(src, source_start, source_end);
        let snippet = dedent_snippet(
            &src[source_start..source_end],
            block_indent(src, source_start).unwrap(),
        );
        let without_source = format!("{}{}", &src[..remove_start], &src[remove_end..]);
        let shift = remove_end - remove_start;
        let target_start_after = target_start - shift;
        let target_end_after = target_end - shift;
        let (updated, _) = splice_snippet(
            &without_source,
            target_start_after,
            target_end_after,
            InsertPosition::After,
            &snippet,
        )
        .unwrap();
        assert!(updated.find("target").unwrap() < updated.find("source").unwrap());
        assert!(updated.contains("  <section class=\"source\">\n    <p>child</p>\n  </section>"));
    }

    #[test]
    fn move_inside_reindents_without_changing_internal_relative_indent() {
        let src = "<main>\n  <div class=\"source\">\n    <p>child</p>\n  </div>\n  <section class=\"target\">\n    <p>keep</p>\n  </section>\n</main>\n";
        let (source_start, source_end) = span_of(src, "source");
        let (target_start, target_end) = span_of(src, "target");
        let (remove_start, remove_end) = removed_range(src, source_start, source_end);
        let snippet = dedent_snippet(
            &src[source_start..source_end],
            block_indent(src, source_start).unwrap(),
        );
        let without_source = format!("{}{}", &src[..remove_start], &src[remove_end..]);
        let shift = remove_end - remove_start;
        let (updated, _) = splice_snippet(
            &without_source,
            target_start - shift,
            target_end - shift,
            InsertPosition::Inside,
            &snippet,
        )
        .unwrap();
        assert!(updated.contains("  <section class=\"target\">\n    <p>keep</p>\n    <div class=\"source\">\n      <p>child</p>\n    </div>\n  </section>"));
    }

    #[test]
    fn move_inline_preserves_siblings() {
        let src = "<p>a <span class=\"source\">b</span> <span class=\"target\">c</span></p>";
        let (source_start, source_end) = span_of(src, "source");
        let (target_start, target_end) = span_of(src, "target");
        let (remove_start, remove_end) = removed_range(src, source_start, source_end);
        let snippet = dedent_snippet(&src[source_start..source_end], "");
        let without_source = format!("{}{}", &src[..remove_start], &src[remove_end..]);
        let shift = remove_end - remove_start;
        let (updated, _) = splice_snippet(
            &without_source,
            target_start - shift,
            target_end - shift,
            InsertPosition::After,
            &snippet,
        )
        .unwrap();
        assert_eq!(
            updated,
            "<p>a  <span class=\"target\">c</span><span class=\"source\">b</span></p>"
        );
    }

    #[test]
    fn descendant_and_void_guards_are_explicit() {
        assert!(VOID_ELEMENTS.contains(&"img"));
        let src = "<div class=\"source\"><span class=\"child\">x</span></div>";
        let (source_start, source_end) = span_of(src, "source");
        let (target_start, _) = span_of(src, "child");
        assert!(source_start < target_start && target_start < source_end);
    }

    fn test_signature(class_name: &str, tag_name: &str, text: &str) -> ElementSignature {
        ElementSignature {
            class_name: class_name.into(),
            tag_name: tag_name.into(),
            text: Some(text.into()),
            ancestor_classes: Vec::new(),
            source_file: None,
            source_line: None,
            source_column: None,
            dom_path: None,
            attr_src: None,
            attr_alt: None,
            attr_width: None,
            attr_height: None,
            attr_loading: None,
        }
    }

    fn test_project_dir() -> tempfile::TempDir {
        let root = crate::utils::default_projects_root().unwrap();
        std::fs::create_dir_all(&root).unwrap();
        tempfile::TempDir::new_in(root).unwrap()
    }

    #[test]
    fn move_element_commits_one_same_file_write_and_accepts_fresh_html() {
        let dir = test_project_dir();
        let file = dir.path().join("Page.tsx");
        let source = "export const Page = () => (\n  <main>\n    <div className=\"a\">A</div>\n    <section className=\"b\">B</section>\n  </main>\n);\n";
        std::fs::write(&file, source).unwrap();
        let moved = move_element(
            dir.path().to_string_lossy().into_owned(),
            test_signature("a", "div", "A"),
            test_signature("b", "section", "B"),
            "<div className=\"a\">A</div>".into(),
            "<section className=\"b\">B</section>".into(),
            InsertPosition::After,
            None,
            None,
        )
        .unwrap();
        let updated = std::fs::read_to_string(file).unwrap();
        assert!(
            updated.find("className=\"b\"").unwrap() < updated.find("className=\"a\"").unwrap()
        );
        assert_eq!(moved.file, "Page.tsx");
        assert_eq!(moved.tag_name, "div");
    }

    #[test]
    fn move_element_preserves_unrelated_bytes_in_one_atomic_result() {
        let dir = test_project_dir();
        let file = dir.path().join("Page.html");
        let source = "<!doctype html>\n<main>\n  <!-- before -->\n  <div class=\"source\">S</div>\n  <!-- between -->\n  <section class=\"target\">T</section>\n  <!-- after -->\n</main>\n";
        std::fs::write(&file, source).unwrap();
        move_element(
            dir.path().to_string_lossy().into_owned(),
            test_signature("source", "div", "S"),
            test_signature("target", "section", "T"),
            "<div class=\"source\">S</div>".into(),
            "<section class=\"target\">T</section>".into(),
            InsertPosition::After,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(file).unwrap(),
            "<!doctype html>\n<main>\n  <!-- before -->\n  <!-- between -->\n  <section class=\"target\">T</section>\n  <div class=\"source\">S</div>\n  <!-- after -->\n</main>\n"
        );
    }

    #[test]
    fn move_element_rejects_stale_html_before_writing() {
        let dir = test_project_dir();
        let file = dir.path().join("Page.tsx");
        let source = "export const Page = () => <main><div className=\"a\">A</div><section className=\"b\">B</section></main>;";
        std::fs::write(&file, source).unwrap();
        let err = move_element(
            dir.path().to_string_lossy().into_owned(),
            test_signature("a", "div", "A"),
            test_signature("b", "section", "B"),
            "<div className=\"a\">changed</div>".into(),
            "<section className=\"b\">B</section>".into(),
            InsertPosition::Before,
            None,
            None,
        )
        .unwrap_err();
        assert!(format!("{err:?}").contains("source_html"));
        assert_eq!(std::fs::read_to_string(file).unwrap(), source);
    }

    #[test]
    fn move_element_rejects_stale_target_html_before_writing() {
        let dir = test_project_dir();
        let file = dir.path().join("Page.html");
        let source = "<main><div class=\"a\">A</div><section class=\"b\">B</section></main>";
        std::fs::write(&file, source).unwrap();
        let err = move_element(
            dir.path().to_string_lossy().into_owned(),
            test_signature("a", "div", "A"),
            test_signature("b", "section", "B"),
            "<div class=\"a\">A</div>".into(),
            "<section class=\"b\">changed</section>".into(),
            InsertPosition::Before,
            None,
            None,
        )
        .unwrap_err();
        assert!(format!("{err:?}").contains("target_html"));
        assert_eq!(std::fs::read_to_string(file).unwrap(), source);
    }

    #[test]
    fn move_element_rejects_descendant_and_void_targets() {
        let dir = test_project_dir();
        let file = dir.path().join("Page.tsx");
        let source = "export const Page = () => <main><div className=\"outer\"><span className=\"inner\">I</span></div><img className=\"image\" /></main>;";
        std::fs::write(&file, source).unwrap();
        let descendant = move_element(
            dir.path().to_string_lossy().into_owned(),
            test_signature("outer", "div", ""),
            test_signature("inner", "span", "I"),
            "<div className=\"outer\"><span className=\"inner\">I</span></div>".into(),
            "<span className=\"inner\">I</span>".into(),
            InsertPosition::Inside,
            None,
            None,
        )
        .unwrap_err();
        assert!(format!("{descendant:?}").contains("descendant"));
        let void_target = move_element(
            dir.path().to_string_lossy().into_owned(),
            test_signature("outer", "div", ""),
            test_signature("image", "img", ""),
            "<div className=\"outer\"><span className=\"inner\">I</span></div>".into(),
            "<img className=\"image\" />".into(),
            InsertPosition::Inside,
            None,
            None,
        )
        .unwrap_err();
        assert!(format!("{void_target:?}").contains("cannot contain"));
    }

    #[test]
    fn move_element_rejects_cross_file_structural_root_and_ambiguous_source() {
        let dir = test_project_dir();
        let first = dir.path().join("First.tsx");
        let second = dir.path().join("Second.tsx");
        std::fs::write(
            &first,
            "export const First = () => <main className=\"root\"><div className=\"a\">A</div></main>;",
        )
        .unwrap();
        std::fs::write(
            &second,
            "export const Second = () => <section className=\"b\">B</section>;",
        )
        .unwrap();
        let cross_file = move_element(
            dir.path().to_string_lossy().into_owned(),
            test_signature("a", "div", "A"),
            test_signature("b", "section", "B"),
            "<div className=\"a\">A</div>".into(),
            "<section className=\"b\">B</section>".into(),
            InsertPosition::After,
            None,
            None,
        )
        .unwrap_err();
        assert!(format!("{cross_file:?}").contains("same source file"));

        let root_move = move_element(
            dir.path().to_string_lossy().into_owned(),
            test_signature("root", "main", ""),
            test_signature("a", "div", "A"),
            "<main className=\"root\"><div className=\"a\">A</div></main>".into(),
            "<div className=\"a\">A</div>".into(),
            InsertPosition::After,
            None,
            None,
        )
        .unwrap_err();
        assert!(format!("{root_move:?}").contains("cannot be moved"));

        std::fs::write(
            &second,
            "export const Second = () => <><div className=\"a\">A</div><section className=\"b\">B</section></>;",
        )
        .unwrap();
        let canonical_root =
            crate::utils::validate_project_path(&dir.path().to_string_lossy()).unwrap();
        invalidate_index_cache(&canonical_root);
        let ambiguous = move_element(
            dir.path().to_string_lossy().into_owned(),
            test_signature("a", "div", "A"),
            test_signature("b", "section", "B"),
            "<div className=\"a\">A</div>".into(),
            "<section className=\"b\">B</section>".into(),
            InsertPosition::After,
            None,
            None,
        )
        .unwrap_err();
        assert!(format!("{ambiguous:?}").contains("identical places"));
    }

    #[test]
    fn move_element_uses_exact_drag_targets_for_repeated_class_literals() {
        let dir = test_project_dir();
        let file = dir.path().join("Repeated.tsx");
        let source = "export const Repeated = () => <main>\n  <div className=\"card\">A</div>\n  <div className=\"card\">B</div>\n  <section className=\"target\">T</section>\n</main>;\n";
        std::fs::write(&file, source).unwrap();

        let exact_target = |needle: &str| {
            let start = source.find(needle).unwrap();
            let end = element_span(source, start).unwrap().1;
            ExactSourceTarget {
                file: "Repeated.tsx".into(),
                start,
                end,
                expected_hash: content_hash(source.as_bytes()),
                expected_html: source[start..end].into(),
            }
        };

        move_element(
            dir.path().to_string_lossy().into_owned(),
            test_signature("card", "div", "B"),
            test_signature("target", "section", "T"),
            "<div className=\"card\">B</div>".into(),
            "<section className=\"target\">T</section>".into(),
            InsertPosition::After,
            Some(exact_target("<div className=\"card\">B")),
            Some(exact_target("<section className=\"target\">T")),
        )
        .unwrap();

        let updated = std::fs::read_to_string(file).unwrap();
        assert!(updated.find(">A</div>").unwrap() < updated.find(">T</section>").unwrap());
        assert!(updated.find(">T</section>").unwrap() < updated.find(">B</div>").unwrap());
    }

    #[test]
    fn move_element_rejects_a_jsx_component_root_sibling() {
        let dir = test_project_dir();
        let file = dir.path().join("Roots.tsx");
        std::fs::write(
            &file,
            "export const A = () => <div className=\"a\">A</div>;\nexport const B = () => <section className=\"b\">B</section>;",
        )
        .unwrap();
        let err = move_element(
            dir.path().to_string_lossy().into_owned(),
            test_signature("a", "div", "A"),
            test_signature("b", "section", "B"),
            "<div className=\"a\">A</div>".into(),
            "<section className=\"b\">B</section>".into(),
            InsertPosition::After,
            None,
            None,
        )
        .unwrap_err();
        assert!(format!("{err:?}").contains("component root"));
    }

    #[test]
    fn move_element_rejects_rendered_dom_snapshot_for_jsx() {
        let dir = test_project_dir();
        let file = dir.path().join("Page.tsx");
        let source = r#"export const Page = () => <main><button className="save" onClick={() => save()}>Save</button><section className="target">Target</section></main>;"#;
        std::fs::write(&file, source).unwrap();

        // The browser renders className as class and drops onClick. That
        // markup is not an authored snapshot and must not bypass the drift
        // guard now that the frontend resolves source HTML explicitly.
        let err = move_element(
            dir.path().to_string_lossy().into_owned(),
            test_signature("save", "button", "Save"),
            test_signature("target", "section", "Target"),
            r#"<button class="save">Save</button>"#.into(),
            r#"<section className="target">Target</section>"#.into(),
            InsertPosition::After,
            None,
            None,
        )
        .unwrap_err();
        assert!(format!("{err:?}").contains("source_html"));
        assert_eq!(std::fs::read_to_string(file).unwrap(), source);
    }
}
