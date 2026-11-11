//! Conservative JSON-backed image source resolution and write-back.
//!
//! The supported source shape is a static default JSON import followed by a
//! literal dot-member chain in an image `src`, for example
//! `import assets from '../data/assets.json'` and `src={assets.updates.imgImage}`.
//! Anything that cannot be proven from that shape stays read-only.

use crate::errors::CommandError;
use crate::utils::{classify_fs_error, validate_project_path};
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct JsonImageResolution {
    /// JSON file whose string property is the image URL.
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub src: String,
    pub expression: String,
    pub property_path: Vec<String>,
    /// Template or source location that contains the `src` expression.
    pub source_file: String,
    pub source_line: usize,
    pub source_column: usize,
    /// Exact UTF-8 byte range of the member-chain expression in `source_file`.
    pub source_expression_start: usize,
    pub source_expression_end: usize,
    /// Exact static member-chain references found in supported source files.
    pub references: Vec<String>,
    /// Source string literals equal to the current URL; a JSON property update
    /// does not alter these copies.
    pub literal_references: Vec<String>,
    /// False means another access/import form could not be safely accounted for.
    pub scope_known: bool,
}

#[derive(Debug, Clone, PartialEq)]
enum TokenKind {
    Ident(String),
    String(String),
    Punct(char),
    Other,
}

#[derive(Debug, Clone)]
struct Token {
    kind: TokenKind,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone)]
struct ImportBinding {
    name: String,
    json_path: PathBuf,
    token_start: usize,
    token_end: usize,
}

#[derive(Debug)]
struct PropertyValue {
    value: String,
    value_start: usize,
    value_end: usize,
    line: usize,
    column: usize,
}

#[derive(Debug, Clone)]
struct SourceFile {
    relative: String,
    absolute: PathBuf,
    source: String,
}

struct SourceScan {
    files: Vec<SourceFile>,
    complete: bool,
}

fn validation(field: &str, reason: impl Into<String>) -> CommandError {
    CommandError::Validation {
        field: field.into(),
        reason: reason.into(),
    }
}

fn source_files(root: &Path) -> SourceScan {
    let mut files = Vec::new();
    let mut complete = true;
    for entry in WalkBuilder::new(root)
        // Reference scope must include ignored authored files too: they can
        // still be imported by a build. Prune generated/dependency trees before
        // disabling the ignore rules so the scan remains bounded.
        .standard_filters(false)
        .filter_entry(|entry| {
            !matches!(
                entry.file_name().to_string_lossy().as_ref(),
                ".git"
                    | "node_modules"
                    | ".next"
                    | ".astro"
                    | ".vercel"
                    | ".shipstudio"
                    | ".turbo"
                    | ".cache"
                    | "dist"
                    | "build"
                    | "out"
                    | "target"
                    | "coverage"
            )
        })
        .build()
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(
            extension.as_str(),
            "astro"
                | "tsx"
                | "jsx"
                | "ts"
                | "js"
                | "mjs"
                | "cjs"
                | "mts"
                | "cts"
                | "vue"
                | "svelte"
                | "mdx"
                | "md"
                | "markdown"
                | "mdown"
                | "mkd"
                | "mdwn"
                | "mdtext"
                | "mdoc"
                | "qmd"
                | "rmd"
                | "html"
        ) {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(path) else {
            complete = false;
            continue;
        };
        let Ok(relative) = path.strip_prefix(root) else {
            complete = false;
            continue;
        };
        files.push(SourceFile {
            relative: relative.to_string_lossy().replace('\\', "/"),
            absolute: path.to_path_buf(),
            source,
        });
    }
    SourceScan { files, complete }
}

/// Tokenize enough JavaScript/TypeScript syntax to prove a literal import and
/// member chain. Strings and comments are opaque, so lookalike text is ignored.
fn tokens(source: &str) -> Option<Vec<Token>> {
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'/') {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
            let end = source[i + 2..].find("*/")? + i + 4;
            i = end;
            continue;
        }
        if matches!(bytes[i], b'\'' | b'"' | b'`') {
            let quote = bytes[i];
            let start = i;
            i += 1;
            let mut escaped = false;
            let mut content = String::new();
            while i < bytes.len() {
                let byte = bytes[i];
                if escaped {
                    match byte {
                        b'n' => content.push('\n'),
                        b'r' => content.push('\r'),
                        b't' => content.push('\t'),
                        b'\\' => content.push('\\'),
                        b'\'' => content.push('\''),
                        b'"' => content.push('"'),
                        other => content.push(other as char),
                    }
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == quote {
                    i += 1;
                    break;
                } else if !byte.is_ascii() {
                    let character = source[i..].chars().next()?;
                    content.push(character);
                    i += character.len_utf8();
                    continue;
                } else {
                    content.push(byte as char);
                }
                i += 1;
            }
            if i > bytes.len() || bytes.get(i.saturating_sub(1)) != Some(&quote) || escaped {
                return None;
            }
            out.push(Token {
                kind: TokenKind::String(content),
                start,
                end: i,
            });
            continue;
        }
        if bytes[i].is_ascii_alphabetic() || matches!(bytes[i], b'_' | b'$') {
            let start = i;
            i += 1;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'_' | b'$'))
            {
                i += 1;
            }
            out.push(Token {
                kind: TokenKind::Ident(source[start..i].to_string()),
                start,
                end: i,
            });
            continue;
        }
        let kind = if bytes[i].is_ascii_punctuation() {
            TokenKind::Punct(bytes[i] as char)
        } else {
            TokenKind::Other
        };
        out.push(Token {
            kind,
            start: i,
            end: i + 1,
        });
        i += 1;
    }
    Some(out)
}

fn token_ident(token: &Token, value: &str) -> bool {
    matches!(&token.kind, TokenKind::Ident(name) if name == value)
}

fn canonical_json_import(root: &Path, source_file: &Path, specifier: &str) -> Option<PathBuf> {
    if !specifier.starts_with('.') || specifier.contains('?') || specifier.contains('#') {
        return None;
    }
    let relative = Path::new(specifier);
    if relative.is_absolute() || relative.extension().and_then(|e| e.to_str()) != Some("json") {
        return None;
    }
    let base = source_file.parent()?;
    let joined = base.join(relative);
    let mut normalized = PathBuf::new();
    for component in joined.strip_prefix(root).ok()?.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::Normal(value) => normalized.push(value),
            _ => return None,
        }
    }
    let target = root.join(normalized).canonicalize().ok()?;
    let canonical_root = root.canonicalize().ok()?;
    target.starts_with(canonical_root).then_some(target)
}

fn parse_imports(root: &Path, file: &SourceFile, parsed: &[Token]) -> Vec<ImportBinding> {
    let mut imports = Vec::new();
    for index in 0..parsed.len().saturating_sub(3) {
        if !token_ident(&parsed[index], "import") {
            continue;
        }
        let (TokenKind::Ident(name), true, TokenKind::String(specifier)) = (
            &parsed[index + 1].kind,
            token_ident(&parsed[index + 2], "from"),
            &parsed[index + 3].kind,
        ) else {
            continue;
        };
        if let Some(json_path) = canonical_json_import(root, &file.absolute, specifier) {
            imports.push(ImportBinding {
                name: name.clone(),
                json_path,
                token_start: parsed[index].start,
                token_end: parsed[index + 3].end,
            });
        }
    }
    imports
}

/// Fail closed if the import name is redeclared anywhere in the source file.
/// This intentionally over-approximates scopes: it prevents a nested component
/// parameter or local variable from being mistaken for the imported JSON value.
fn has_shadowing_binding(parsed: &[Token], binding: &ImportBinding) -> bool {
    let same_name: Vec<usize> = parsed
        .iter()
        .enumerate()
        .filter(|(_, token)| {
            token.start < binding.token_start
                || token.start >= binding.token_end
                || !token_ident(token, &binding.name)
        })
        .filter_map(|(index, token)| token_ident(token, &binding.name).then_some(index))
        .collect();

    for &index in &same_name {
        let previous = index
            .checked_sub(1)
            .and_then(|prior| parsed.get(prior))
            .map(|token| &token.kind);
        if matches!(
            previous,
            Some(TokenKind::Ident(word))
                if matches!(word.as_str(), "const" | "let" | "var" | "function" | "class" | "catch" | "as")
        ) {
            return true;
        }
        if parsed
            .get(index + 1)
            .is_some_and(|token| matches!(&token.kind, TokenKind::Punct('=')))
            && parsed
                .get(index + 2)
                .is_some_and(|token| matches!(&token.kind, TokenKind::Punct('>')))
        {
            return true;
        }
        let in_another_import = (0..index).any(|import_start| {
            if !token_ident(&parsed[import_start], "import") {
                return false;
            }
            let statement_end = (import_start + 1..parsed.len())
                .find(|candidate| {
                    matches!(&parsed[*candidate].kind, TokenKind::Punct(';'))
                        || token_ident(&parsed[*candidate], "import")
                })
                .unwrap_or(parsed.len());
            (import_start + 1..statement_end)
                .find(|candidate| matches!(&parsed[*candidate].kind, TokenKind::String(_)))
                .is_some_and(|specifier| index < specifier)
        });
        if in_another_import {
            return true;
        }
    }

    for (start, token) in parsed.iter().enumerate() {
        if !matches!(
            &token.kind,
            TokenKind::Ident(word) if matches!(word.as_str(), "const" | "let" | "var")
        ) {
            continue;
        }
        let end = parsed[start + 1..]
            .iter()
            .position(|candidate| matches!(&candidate.kind, TokenKind::Punct(';')))
            .map_or(parsed.len(), |offset| start + 1 + offset);
        let first_assignment = parsed[start + 1..end]
            .iter()
            .position(|candidate| matches!(&candidate.kind, TokenKind::Punct('=')))
            .map_or(end, |offset| start + 1 + offset);
        if same_name.iter().any(|index| {
            let position = *index;
            (start < position && position < first_assignment) || {
                position > start
                    && position < end
                    && parsed
                        .get(position - 1)
                        .is_some_and(|prior| matches!(&prior.kind, TokenKind::Punct(',')))
                    && parsed
                        .get(position + 1)
                        .is_some_and(|next| matches!(&next.kind, TokenKind::Punct('=')))
            }
        }) {
            return true;
        }
    }

    for open in 0..parsed.len() {
        if !matches!(&parsed[open].kind, TokenKind::Punct('(')) {
            continue;
        }
        let mut depth = 0usize;
        let close = (open..parsed.len()).find(|index| {
            match &parsed[*index].kind {
                TokenKind::Punct('(') => depth += 1,
                TokenKind::Punct(')') => depth = depth.saturating_sub(1),
                _ => {}
            }
            depth == 0
        });
        let Some(close) = close else {
            continue;
        };
        if !same_name
            .iter()
            .any(|index| open < *index && *index < close)
        {
            continue;
        }
        let is_arrow_parameters = parsed
            .get(close + 1)
            .is_some_and(|token| matches!(&token.kind, TokenKind::Punct('=')))
            && parsed
                .get(close + 2)
                .is_some_and(|token| matches!(&token.kind, TokenKind::Punct('>')));
        let is_function_parameters = parsed
            .get(close + 1)
            .is_some_and(|token| matches!(&token.kind, TokenKind::Punct('{')))
            && open > 0
            && !matches!(
                &parsed[open - 1].kind,
                TokenKind::Ident(word)
                    if matches!(word.as_str(), "if" | "while" | "for" | "switch" | "with")
            );
        if is_arrow_parameters || is_function_parameters {
            return true;
        }
    }
    false
}

fn member_chain(parsed: &[Token], start: usize) -> Option<(Vec<String>, usize)> {
    let TokenKind::Ident(first) = &parsed.get(start)?.kind else {
        return None;
    };
    let mut members = vec![first.clone()];
    let mut index = start + 1;
    while index + 1 < parsed.len() && matches!(&parsed[index].kind, TokenKind::Punct('.')) {
        let TokenKind::Ident(member) = &parsed[index + 1].kind else {
            return None;
        };
        members.push(member.clone());
        index += 2;
    }
    Some((members, index))
}

fn line_col(source: &str, offset: usize) -> Option<(usize, usize)> {
    if offset > source.len() || !source.is_char_boundary(offset) {
        return None;
    }
    let prefix = &source[..offset];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let column = offset - prefix.rfind('\n').map_or(0, |index| index + 1) + 1;
    Some((line, column))
}

fn skip_json_space(source: &str, mut index: usize) -> usize {
    while source
        .as_bytes()
        .get(index)
        .is_some_and(|byte| byte.is_ascii_whitespace())
    {
        index += 1;
    }
    index
}

fn skip_json_string(source: &str, start: usize) -> Option<usize> {
    if source.as_bytes().get(start) != Some(&b'"') {
        return None;
    }
    let bytes = source.as_bytes();
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index = (index + 2).min(bytes.len()),
            b'"' => return Some(index + 1),
            _ => index += 1,
        }
    }
    None
}

fn skip_json_value(source: &str, start: usize) -> Option<usize> {
    let index = skip_json_space(source, start);
    let bytes = source.as_bytes();
    match *bytes.get(index)? {
        b'"' => skip_json_string(source, index),
        b'{' => {
            let mut cursor = skip_json_space(source, index + 1);
            if bytes.get(cursor) == Some(&b'}') {
                return Some(cursor + 1);
            }
            loop {
                cursor = skip_json_string(source, cursor)?;
                cursor = skip_json_space(source, cursor);
                if bytes.get(cursor) != Some(&b':') {
                    return None;
                }
                cursor = skip_json_value(source, cursor + 1)?;
                cursor = skip_json_space(source, cursor);
                match *bytes.get(cursor)? {
                    b',' => cursor = skip_json_space(source, cursor + 1),
                    b'}' => return Some(cursor + 1),
                    _ => return None,
                }
            }
        }
        b'[' => {
            let mut cursor = skip_json_space(source, index + 1);
            if bytes.get(cursor) == Some(&b']') {
                return Some(cursor + 1);
            }
            loop {
                cursor = skip_json_value(source, cursor)?;
                cursor = skip_json_space(source, cursor);
                match *bytes.get(cursor)? {
                    b',' => cursor = skip_json_space(source, cursor + 1),
                    b']' => return Some(cursor + 1),
                    _ => return None,
                }
            }
        }
        _ => {
            let mut cursor = index;
            while cursor < bytes.len() && !matches!(bytes[cursor], b',' | b'}' | b']') {
                cursor += 1;
            }
            let end = source[..cursor].trim_end().len();
            (end > index).then_some(end)
        }
    }
}

fn json_property(source: &str, path: &[String]) -> Option<PropertyValue> {
    if path.is_empty() || serde_json::from_str::<serde_json::Value>(source).is_err() {
        return None;
    }
    let mut object_start = skip_json_space(source, 0);
    for (depth, wanted) in path.iter().enumerate() {
        if source.as_bytes().get(object_start) != Some(&b'{') {
            return None;
        }
        let mut cursor = skip_json_space(source, object_start + 1);
        let mut found = None;
        while source.as_bytes().get(cursor) != Some(&b'}') {
            let key_end = skip_json_string(source, cursor)?;
            let key: String = serde_json::from_str(&source[cursor..key_end]).ok()?;
            let value_start = skip_json_space(source, key_end);
            if source.as_bytes().get(value_start) != Some(&b':') {
                return None;
            }
            let value_start = skip_json_space(source, value_start + 1);
            let value_end = skip_json_value(source, value_start)?;
            if &key == wanted {
                if found.is_some() {
                    return None;
                }
                found = Some((value_start, value_end));
            }
            cursor = skip_json_space(source, value_end);
            if source.as_bytes().get(cursor) == Some(&b',') {
                cursor = skip_json_space(source, cursor + 1);
            } else if source.as_bytes().get(cursor) != Some(&b'}') {
                return None;
            }
        }
        let (value_start, value_end) = found?;
        if depth + 1 < path.len() {
            object_start = value_start;
            continue;
        }
        if source.as_bytes().get(value_start) != Some(&b'"') {
            return None;
        }
        let value: String = serde_json::from_str(&source[value_start..value_end]).ok()?;
        let (line, column) = line_col(source, value_start)?;
        return Some(PropertyValue {
            value,
            value_start,
            value_end,
            line,
            column,
        });
    }
    None
}

fn src_expression(tag: &str) -> Option<(String, usize)> {
    let bytes = tag.as_bytes();
    let mut index = 1;
    while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'>' {
        index += 1;
    }
    while index < bytes.len() {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] == b'>' || bytes[index] == b'/' {
            return None;
        }
        let start = index;
        while index < bytes.len()
            && !bytes[index].is_ascii_whitespace()
            && !matches!(bytes[index], b'=' | b'/' | b'>')
        {
            index += 1;
        }
        if index == start {
            return None;
        }
        let name = &tag[start..index];
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if bytes.get(index) != Some(&b'=') {
            continue;
        }
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if name == "src" && bytes.get(index) == Some(&b'{') {
            let expr_start = index + 1;
            let expr_end = crate::commands::edit::skip_braced_expression(tag, index)? - 1;
            return Some((tag[expr_start..expr_end].to_string(), expr_start));
        }
        if matches!(bytes.get(index), Some(b'\'' | b'"' | b'`')) {
            let quote = bytes[index];
            index += 1;
            while index < bytes.len() {
                if bytes[index] == b'\\' {
                    index = (index + 2).min(bytes.len());
                } else if bytes[index] == quote {
                    index += 1;
                    break;
                } else {
                    index += 1;
                }
            }
        } else if bytes.get(index) == Some(&b'{') {
            index = crate::commands::edit::skip_braced_expression(tag, index)?;
        } else {
            while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'>'
            {
                index += 1;
            }
        }
    }
    None
}

fn opening_tags(source: &str, file: &str) -> Option<Vec<(usize, usize)>> {
    let bytes = source.as_bytes();
    let mut tags = Vec::new();
    let extension = Path::new(file)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let markup_mode = matches!(
        extension.as_str(),
        "astro" | "html" | "mdx" | "vue" | "svelte"
    );
    let mut index = 0;
    while index < bytes.len() {
        if extension == "astro" && index == 0 && source.starts_with("---") {
            let Some(first_line_end) = source.find('\n') else {
                return None;
            };
            let mut cursor = first_line_end + 1;
            let mut closing = None;
            for line in source[cursor..].split_inclusive('\n') {
                let line_content =
                    line.trim_end_matches(|character| character == '\r' || character == '\n');
                cursor += line.len();
                if line_content.trim() == "---" {
                    closing = Some(cursor);
                    break;
                }
            }
            let Some(end) = closing else {
                return None;
            };
            index = end;
            continue;
        }
        if source[index..].starts_with("<!--") {
            let Some(end) = source[index + 4..].find("-->") else {
                return None;
            };
            index += end + 7;
            continue;
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            let Some(end) = source[index + 2..].find("*/") else {
                return None;
            };
            index += end + 4;
            continue;
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'/') {
            index += source[index..].find('\n').unwrap_or(source.len() - index);
            continue;
        }
        if !markup_mode && matches!(bytes[index], b'\'' | b'"' | b'`') {
            let quote = bytes[index];
            index += 1;
            let mut closed = false;
            while index < bytes.len() {
                if bytes[index] == b'\\' {
                    index = (index + 2).min(bytes.len());
                } else if bytes[index] == quote {
                    index += 1;
                    closed = true;
                    break;
                } else {
                    index += 1;
                }
            }
            if !closed {
                return None;
            }
            continue;
        }
        if markup_mode && bytes[index] == b'{' {
            if let Some(end) = crate::commands::edit::skip_braced_expression(source, index) {
                index = end;
                continue;
            }
            return None;
        }
        if !bytes[index].is_ascii() {
            index += source[index..].chars().next().map_or(1, char::len_utf8);
            continue;
        }
        if bytes[index] == b'<'
            && bytes
                .get(index + 1)
                .is_some_and(|byte| byte.is_ascii_alphabetic())
        {
            let Some(end) = crate::commands::edit::open_tag_end(source, index + 1) else {
                return None;
            };
            let name = tag_name(&source[index..end + 1]);
            tags.push((index, end + 1));
            index = end + 1;
            if name.is_some_and(|name| {
                name.eq_ignore_ascii_case("script") || name.eq_ignore_ascii_case("style")
            }) {
                let tag = name.unwrap_or_default().to_ascii_lowercase();
                let closing = format!("</{tag}");
                let raw = source[index..].to_ascii_lowercase();
                let Some(close_offset) = raw.find(&closing) else {
                    return None;
                };
                index += close_offset;
            }
            continue;
        }
        index += 1;
    }
    Some(tags)
}

fn is_candidate_template(file: &SourceFile) -> bool {
    matches!(
        file.absolute
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "astro" | "tsx" | "jsx" | "mdx" | "vue" | "svelte" | "html"
    )
}

fn tag_name(tag: &str) -> Option<&str> {
    let name = tag.strip_prefix('<')?;
    let end = name.find(|character: char| {
        character.is_ascii_whitespace() || matches!(character, '/' | '>')
    })?;
    Some(&name[..end])
}

/// React's Next.js image component renders as a DOM `<img>`. Accept it as an
/// authored image candidate only when the tag is the default import from the
/// known Next.js image module; a project-local component named `Image` is not
/// enough evidence to map a rendered image back to this source tag.
fn is_rendered_image_tag(file: &SourceFile, tag: &str) -> bool {
    let Some(name) = tag_name(tag) else {
        return false;
    };
    // JSX and Astro treat capitalized names as component identifiers, so
    // `<Img>` may be an arbitrary component that happens to render an image.
    // Keep the native-tag check case-sensitive; this is also the authored form
    // used by the editor's source index.
    if name == "img" {
        return true;
    }

    let extension = file
        .absolute
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "html" | "liquid") && name.eq_ignore_ascii_case("img") {
        return true;
    }
    if !matches!(extension.as_str(), "tsx" | "jsx") {
        return false;
    }

    let Some(parsed) = tokens(&file.source) else {
        return false;
    };
    parsed.windows(4).any(|window| {
        token_ident(&window[0], "import")
            && matches!(&window[1].kind, TokenKind::Ident(imported) if imported == name)
            && token_ident(&window[2], "from")
            && matches!(
                &window[3].kind,
                TokenKind::String(module)
                    if matches!(module.as_str(), "next/image" | "next/legacy/image")
            )
    })
}

#[derive(Debug)]
enum SourceAttributeValue {
    Static(String),
    Dynamic,
}

#[derive(Debug)]
struct ParsedSourceAttributes {
    values: Vec<(String, SourceAttributeValue)>,
    has_spread: bool,
}

/// Parse attributes from one already-located opening tag. Any syntax we cannot
/// classify is refused instead of being treated as evidence that an attribute
/// is absent.
fn parse_source_attributes(tag: &str) -> Option<ParsedSourceAttributes> {
    let name = tag_name(tag)?;
    let bytes = tag.as_bytes();
    let mut index = name.len() + 1;
    let mut values = Vec::new();
    let mut has_spread = false;
    while index < bytes.len() {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || matches!(bytes[index], b'>' | b'/') {
            break;
        }
        if bytes[index] == b'{' {
            let end = crate::commands::edit::skip_braced_expression(tag, index)?;
            has_spread = true;
            index = end;
            continue;
        }
        let start = index;
        while index < bytes.len()
            && !bytes[index].is_ascii_whitespace()
            && !matches!(bytes[index], b'=' | b'/' | b'>')
        {
            index += 1;
        }
        if start == index {
            return None;
        }
        let attribute_name = tag[start..index].to_ascii_lowercase();
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let value = if bytes.get(index) != Some(&b'=') {
            SourceAttributeValue::Static(String::new())
        } else {
            index += 1;
            while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            match bytes.get(index).copied()? {
                quote @ (b'\'' | b'"' | b'`') => {
                    let value_start = index + 1;
                    index = value_start;
                    while index < bytes.len() && bytes[index] != quote {
                        if bytes[index] == b'\\' {
                            index = (index + 2).min(bytes.len());
                        } else {
                            index += 1;
                        }
                    }
                    if index >= bytes.len() {
                        return None;
                    }
                    let value = tag[value_start..index].to_string();
                    index += 1;
                    SourceAttributeValue::Static(value)
                }
                b'{' => {
                    let expression_start = index + 1;
                    let end = crate::commands::edit::skip_braced_expression(tag, index)?;
                    let expression = tag[expression_start..end - 1].trim();
                    index = end;
                    // Numeric JSX literals such as Next Image's required
                    // `width={640}` and `height={480}` are stable rendered
                    // attributes and can safely narrow a classless candidate.
                    if !expression.is_empty()
                        && expression.bytes().all(|byte| byte.is_ascii_digit())
                    {
                        SourceAttributeValue::Static(expression.to_string())
                    } else {
                        SourceAttributeValue::Dynamic
                    }
                }
                _ => {
                    let value_start = index;
                    while index < bytes.len()
                        && !bytes[index].is_ascii_whitespace()
                        && !matches!(bytes[index], b'/' | b'>')
                    {
                        index += 1;
                    }
                    if value_start == index {
                        return None;
                    }
                    SourceAttributeValue::Static(tag[value_start..index].to_string())
                }
            }
        };
        if values
            .iter()
            .any(|(existing, _)| existing == &attribute_name)
        {
            return None;
        }
        values.push((attribute_name, value));
    }
    Some(ParsedSourceAttributes { values, has_spread })
}

#[derive(Debug, PartialEq)]
enum SignatureMatch {
    Match,
    Unknown,
    Mismatch,
}

fn matches_rendered_image_attributes(
    tag: &str,
    signature: &crate::commands::edit::ElementSignature,
) -> Result<SignatureMatch, ()> {
    let attributes = parse_source_attributes(tag).ok_or(())?;
    if attributes.has_spread {
        return Ok(SignatureMatch::Unknown);
    }
    let mut unknown = false;
    for (name, expected) in [
        ("alt", signature.attr_alt.as_deref()),
        ("width", signature.attr_width.as_deref()),
        ("height", signature.attr_height.as_deref()),
        ("loading", signature.attr_loading.as_deref()),
    ] {
        let actual = attributes
            .values
            .iter()
            .find(|(attribute, _)| attribute == name)
            .map(|(_, value)| value);
        match (expected, actual) {
            (Some(expected), Some(SourceAttributeValue::Static(actual))) if expected == actual => {}
            (Some(_), Some(SourceAttributeValue::Static(_))) => {
                return Ok(SignatureMatch::Mismatch)
            }
            (Some(_), Some(SourceAttributeValue::Dynamic)) => unknown = true,
            (Some(_), None) => return Ok(SignatureMatch::Mismatch),
            (None, None) => {}
            (None, Some(SourceAttributeValue::Static(_))) => return Ok(SignatureMatch::Mismatch),
            (None, Some(SourceAttributeValue::Dynamic)) => unknown = true,
        }
    }
    Ok(if unknown {
        SignatureMatch::Unknown
    } else {
        SignatureMatch::Match
    })
}

fn resolve_expression(
    root: &Path,
    file: &SourceFile,
    tag_start: usize,
    tag_end: usize,
    expected_src: Option<&str>,
) -> Option<JsonImageResolution> {
    let tag = file.source.get(tag_start..tag_end)?;
    if !crate::commands::edit::json_image_tag_is_safe(&file.source, tag_start, tag_end) {
        return None;
    }
    let (expression, expression_offset) = src_expression(tag)?;
    let parsed_expression = tokens(&expression)?;
    let (members, next) = member_chain(&parsed_expression, 0)?;
    if next != parsed_expression.len() || members.len() < 2 {
        return None;
    }
    let binding_name = &members[0];
    let property_path = members[1..].to_vec();
    let parsed_file = tokens(&file.source)?;
    let imports = parse_imports(root, file, &parsed_file);
    let mut bindings = imports
        .iter()
        .filter(|binding| binding.name == *binding_name);
    let binding = bindings.next()?;
    if bindings.next().is_some() {
        return None;
    }
    if has_shadowing_binding(&parsed_file, binding) {
        return None;
    }
    let json_source = std::fs::read_to_string(&binding.json_path).ok()?;
    let property = json_property(&json_source, &property_path)?;
    if expected_src.is_some_and(|expected| expected != property.value) {
        return None;
    }
    let (source_line, source_column) = line_col(&file.source, tag_start + expression_offset)?;
    let source_expression_start = tag_start + expression_offset + parsed_expression.first()?.start;
    let source_expression_end = tag_start + expression_offset + parsed_expression.last()?.end;
    let relative_json = binding
        .json_path
        .strip_prefix(root.canonicalize().ok()?)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let (mut references, literal_references, mut scope_known) =
        references_to(root, &binding.json_path, &property_path, &property.value);
    let identifier_offset = parsed_expression.first()?.start;
    let (reference_line, reference_column) = line_col(
        &file.source,
        tag_start + expression_offset + identifier_offset,
    )?;
    let current_reference = format!("{}:{reference_line}:{reference_column}", file.relative);
    if !references.contains(&current_reference) {
        references.push(current_reference);
        references.sort();
        scope_known = false;
    }
    Some(JsonImageResolution {
        file: relative_json,
        line: property.line,
        column: property.column,
        src: property.value,
        expression,
        property_path,
        source_file: file.relative.clone(),
        source_line,
        source_column,
        source_expression_start,
        source_expression_end,
        references,
        literal_references,
        scope_known,
    })
}

/// Reopen the exact authored `<img>` site identified by a resolved JSON source.
/// The line/column locates the expression's containing tag; the expression is
/// then re-resolved against the same JSON value before a caller can use its span.
pub(crate) fn locate_source_tag(
    root: &Path,
    source_file: &str,
    source_line: usize,
    source_column: usize,
    expected_src: &str,
) -> Option<(String, String, usize, usize)> {
    let relative = Path::new(source_file);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let path = root.join(relative).canonicalize().ok()?;
    if !path.starts_with(root.canonicalize().ok()?) {
        return None;
    }
    let source = std::fs::read_to_string(&path).ok()?;
    let tags = opening_tags(&source, source_file)?;
    let record = SourceFile {
        relative: source_file.to_string(),
        absolute: path,
        source: source.clone(),
    };
    let mut found = None;
    for (tag_start, tag_end) in tags {
        if !crate::commands::edit::source_position_in_span(
            &source,
            tag_start,
            tag_end,
            source_line,
            Some(source_column),
        ) {
            continue;
        }
        let Some(resolution) =
            resolve_expression(root, &record, tag_start, tag_end, Some(expected_src))
        else {
            continue;
        };
        if resolution.source_line != source_line || resolution.source_column != source_column {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some((source_file.to_string(), source.clone(), tag_start, tag_end));
    }
    found
}

fn references_to(
    root: &Path,
    json_path: &Path,
    target_path: &[String],
    target_value: &str,
) -> (Vec<String>, Vec<String>, bool) {
    let mut references = Vec::new();
    let mut literal_references = Vec::new();
    let scan = source_files(root);
    let mut scope_known = scan.complete;
    for file in scan.files {
        let Some(parsed) = tokens(&file.source) else {
            scope_known = false;
            continue;
        };
        let imports = parse_imports(root, &file, &parsed);
        for index in 0..parsed.len().saturating_sub(2) {
            if !token_ident(&parsed[index], "import") {
                continue;
            }
            let specifier = parsed[index..]
                .iter()
                .skip(1)
                .take(12)
                .find_map(|token| match &token.kind {
                    TokenKind::String(value) => Some(value),
                    _ => None,
                });
            if let Some(specifier) = specifier {
                let resolved = canonical_json_import(root, &file.absolute, specifier);
                if (resolved.as_deref() == Some(json_path)
                    || (specifier.ends_with(".json") && resolved.is_none()))
                    && !imports
                        .iter()
                        .any(|binding| binding.token_start == parsed[index].start)
                {
                    scope_known = false;
                }
            }
        }
        for binding in imports
            .iter()
            .filter(|binding| binding.json_path == json_path)
        {
            if has_shadowing_binding(&parsed, binding) {
                scope_known = false;
                continue;
            }
            for (index, token) in parsed.iter().enumerate() {
                if token.start >= binding.token_start && token.end <= binding.token_end {
                    continue;
                }
                if !token_ident(token, &binding.name) {
                    continue;
                }
                let chain = member_chain(&parsed, index).map(|(path, end)| (path, end));
                match chain {
                    Some((path, _)) if path[0] == binding.name && path[1..] == *target_path => {
                        let (line, column) = line_col(&file.source, token.start).unwrap_or((0, 0));
                        references.push(format!("{}:{line}:{column}", file.relative));
                    }
                    Some((path, _))
                        if path.len() > 1
                            && (path[1..].starts_with(target_path)
                                || target_path.starts_with(&path[1..])) =>
                    {
                        scope_known = false;
                    }
                    Some((path, _)) if path.len() > 1 => {}
                    _ => scope_known = false,
                }
            }
        }
        for token in &parsed {
            if matches!(&token.kind, TokenKind::String(value) if value == target_value) {
                let (line, column) = line_col(&file.source, token.start).unwrap_or((0, 0));
                literal_references.push(format!("{}:{line}:{column}", file.relative));
            }
            let TokenKind::String(specifier) = &token.kind else {
                continue;
            };
            if canonical_json_import(root, &file.absolute, specifier).as_deref() != Some(json_path)
            {
                continue;
            }
            let is_import_source = imports.iter().any(|binding| {
                token.start >= binding.token_start && token.end <= binding.token_end
            });
            if !is_import_source {
                scope_known = false;
            }
        }
    }
    references.sort();
    references.dedup();
    literal_references.sort();
    literal_references.dedup();
    (references, literal_references, scope_known)
}

/// Resolve an expression in a known source tag (usually class anchored).
pub(crate) fn resolve_at_site(
    root: &Path,
    file: &str,
    tag_start: usize,
    expected_src: Option<&str>,
) -> Option<JsonImageResolution> {
    let path = root.join(file);
    let source = std::fs::read_to_string(&path).ok()?;
    let end = crate::commands::edit::open_tag_end(&source, tag_start + 1)? + 1;
    let record = SourceFile {
        relative: file.to_string(),
        absolute: path,
        source,
    };
    resolve_expression(root, &record, tag_start, end, expected_src)
}

/// Resolve a source-map frame to the one dynamic image tag it identifies. An
/// unsupported expression at that selected location is an explicit refusal,
/// preventing a global URL search from substituting an unrelated JSON value.
pub(crate) fn resolve_at_hint(
    root: &Path,
    file: &str,
    source: &str,
    line: usize,
    column: Option<usize>,
    expected_src: &str,
) -> Result<Option<JsonImageResolution>, ()> {
    let record = SourceFile {
        relative: file.to_string(),
        absolute: root.join(file),
        source: source.to_string(),
    };
    let mut found = None;
    let Some(tags) = opening_tags(source, file) else {
        return Err(());
    };
    for (tag_start, tag_end) in tags {
        if !crate::commands::edit::source_position_in_span(source, tag_start, tag_end, line, column)
        {
            continue;
        }
        if src_expression(&source[tag_start..tag_end]).is_none() {
            continue;
        }
        let Some(resolution) =
            resolve_expression(root, &record, tag_start, tag_end, Some(expected_src))
        else {
            return Err(());
        };
        if found.is_some() {
            return Err(());
        }
        found = Some(resolution);
    }
    Ok(found)
}

/// Search supported source files for a JSON expression rendering this value.
/// Distinct properties are ambiguous; repeated references to one property are
/// returned as a shared target and surfaced to the UI for confirmation.
pub(crate) fn resolve_by_value(
    root: &Path,
    expected_src: &str,
) -> Result<Option<JsonImageResolution>, ()> {
    let mut matches = Vec::new();
    let scan = source_files(root);
    if !scan.complete {
        return Err(());
    }
    for file in scan.files {
        if !is_candidate_template(&file) {
            continue;
        }
        if crate::commands::edit::find_attr_spans(&file.source, &["src"])
            .iter()
            .any(|span| span.tag == "img" && span.value == expected_src)
        {
            // A classless rendered image with this URL could be one of these
            // literal sites instead. A no-hint resolution cannot distinguish it.
            return Err(());
        }
        let Some(tags) = opening_tags(&file.source, &file.relative) else {
            return Err(());
        };
        for (tag_start, tag_end) in tags {
            let tag = &file.source[tag_start..tag_end];
            if !is_rendered_image_tag(&file, tag) {
                continue;
            }
            if let Some(resolution) =
                resolve_expression(root, &file, tag_start, tag_end, Some(expected_src))
            {
                matches.push(resolution);
            }
        }
    }
    matches.sort_by(|left, right| {
        (&left.source_file, left.source_line, left.source_column).cmp(&(
            &right.source_file,
            right.source_line,
            right.source_column,
        ))
    });
    matches.dedup_by(|left, right| {
        left.source_file == right.source_file
            && left.source_line == right.source_line
            && left.source_column == right.source_column
    });
    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(matches.remove(0))),
        _ => Err(()),
    }
}

/// Resolve a classless image without a framework source frame only when its
/// rendered attributes prove which authored image tag produced the selection.
/// Native `<img>` tags work across supported templates; Next.js `<Image>` is
/// included only when its default import is proven. Dynamic or spread-based
/// candidates that could still match remain ambiguous.
pub(crate) fn resolve_by_rendered_signature(
    root: &Path,
    expected_src: &str,
    signature: &crate::commands::edit::ElementSignature,
) -> Result<Option<JsonImageResolution>, ()> {
    let has_identity_attribute = [
        signature.attr_alt.as_deref(),
        signature.attr_width.as_deref(),
        signature.attr_height.as_deref(),
        signature.attr_loading.as_deref(),
    ]
    .into_iter()
    .any(|value| value.is_some());
    if !has_identity_attribute {
        return Err(());
    }

    let scan = source_files(root);
    if !scan.complete {
        return Err(());
    }
    let mut matches = Vec::new();
    for file in scan.files {
        if !is_candidate_template(&file) {
            continue;
        }
        let Some(tags) = opening_tags(&file.source, &file.relative) else {
            return Err(());
        };
        for (tag_start, tag_end) in tags {
            let tag = &file.source[tag_start..tag_end];
            if !is_rendered_image_tag(&file, tag) {
                continue;
            }
            let rendered_match = matches_rendered_image_attributes(tag, signature)?;
            if rendered_match == SignatureMatch::Mismatch {
                continue;
            }
            let attributes = parse_source_attributes(tag).ok_or(())?;
            let source_value = attributes
                .values
                .iter()
                .find(|(name, _)| name == "src")
                .map(|(_, value)| value);
            let possible_source = match source_value {
                Some(SourceAttributeValue::Static(value)) => value == expected_src,
                Some(SourceAttributeValue::Dynamic) => true,
                None => attributes.has_spread,
            };
            if !possible_source {
                continue;
            }
            if !crate::commands::edit::json_image_tag_is_safe(&file.source, tag_start, tag_end) {
                return Err(());
            }
            let resolution = resolve_expression(root, &file, tag_start, tag_end, None).ok_or(())?;
            if resolution.src != expected_src || rendered_match != SignatureMatch::Match {
                return Err(());
            }
            matches.push(resolution);
        }
    }
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.pop()),
        _ => Err(()),
    }
}

fn locate_site(
    root: &Path,
    source_file: &str,
    source_line: usize,
    source_column: usize,
    expected_src: &str,
) -> Result<JsonImageResolution, CommandError> {
    let path = Path::new(source_file);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(validation("source_file", "image source path is invalid"));
    }
    let absolute = root.join(path);
    let canonical_root = root.canonicalize().map_err(CommandError::from)?;
    let canonical_file = absolute.canonicalize().map_err(CommandError::from)?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(validation(
            "source_file",
            "image source is outside the project",
        ));
    }
    let source = std::fs::read_to_string(&canonical_file)
        .map_err(|error| classify_fs_error("open this file to edit it", &canonical_file, &error))?;
    let Some(tags) = opening_tags(&source, source_file) else {
        return Err(validation(
            "old_src",
            "image source markup could not be parsed safely — reselect the image",
        ));
    };
    for (tag_start, tag_end) in tags {
        let Some((expression, offset)) = src_expression(&source[tag_start..tag_end]) else {
            continue;
        };
        let (line, column) = line_col(&source, tag_start + offset).unwrap_or((0, 0));
        if line != source_line || column != source_column {
            continue;
        }
        let record = SourceFile {
            relative: source_file.to_string(),
            absolute: canonical_file.clone(),
            source: source.clone(),
        };
        if let Some(resolution) =
            resolve_expression(root, &record, tag_start, tag_end, Some(expected_src))
        {
            return Ok(resolution);
        }
        let _ = expression;
        break;
    }
    Err(validation(
        "old_src",
        "image source no longer resolves to this JSON property — reselect the image",
    ))
}

fn write_json_property(
    root: &Path,
    source_file: &str,
    source_line: usize,
    source_column: usize,
    old_src: &str,
    new_src: &str,
    expected_file: &str,
    expected_property_path: &[String],
    expected_expression: &str,
    expected_references: &[String],
    expected_literal_references: &[String],
    expected_scope_known: bool,
    confirmed_shared: bool,
) -> Result<(), CommandError> {
    if new_src.is_empty() || new_src.chars().any(char::is_control) {
        return Err(validation(
            "new_src",
            "image URL cannot be empty or contain control characters",
        ));
    }
    let resolution = locate_site(root, source_file, source_line, source_column, old_src)?;
    let mut references = expected_references.to_vec();
    references.sort();
    references.dedup();
    let mut literal_references = expected_literal_references.to_vec();
    literal_references.sort();
    literal_references.dedup();
    if resolution.file != expected_file
        || resolution.property_path.as_slice() != expected_property_path
        || resolution.expression != expected_expression
        || resolution.references != references
        || resolution.literal_references != literal_references
        || resolution.scope_known != expected_scope_known
    {
        return Err(validation(
            "source_resolution",
            "image source mapping or reference scope changed — reselect the image",
        ));
    }
    if !resolution.scope_known || resolution.references.len() > 1 {
        if !confirmed_shared {
            return Err(validation(
                "confirmed_shared",
                "this JSON value has shared or unknown references; confirm the impact before writing",
            ));
        }
    }
    let json_path = root.join(&resolution.file);
    let canonical_root = root.canonicalize().map_err(CommandError::from)?;
    let canonical_json = json_path.canonicalize().map_err(CommandError::from)?;
    if !canonical_json.starts_with(&canonical_root) {
        return Err(validation(
            "file",
            "JSON image value is outside the project",
        ));
    }
    let source = std::fs::read_to_string(&canonical_json)
        .map_err(|error| classify_fs_error("open this file to edit it", &canonical_json, &error))?;
    let property = json_property(&source, &resolution.property_path)
        .ok_or_else(|| validation("property_path", "JSON image property could not be verified"))?;
    if property.value != old_src || property.value != resolution.src {
        return Err(validation(
            "old_src",
            "image value changed — reselect the image",
        ));
    }
    let encoded = serde_json::to_string(new_src)
        .map_err(|error| validation("new_src", format!("could not encode image URL: {error}")))?;
    let mut updated = source;
    updated.replace_range(property.value_start..property.value_end, &encoded);
    std::fs::write(&canonical_json, updated).map_err(|error| {
        classify_fs_error("save your change to this file", &canonical_json, &error)
    })?;
    Ok(())
}

/// Replace a proven JSON image property after independently resolving the source
/// expression, checking drift and enforcing explicit shared-use confirmation.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, source_file = %source_file, source_line = source_line))]
pub fn apply_json_image_edit(
    project_path: String,
    source_file: String,
    source_line: usize,
    source_column: usize,
    old_src: String,
    new_src: String,
    expected_file: String,
    expected_property_path: Vec<String>,
    expected_expression: String,
    expected_references: Vec<String>,
    expected_literal_references: Vec<String>,
    expected_scope_known: bool,
    confirmed_shared: bool,
) -> Result<(), CommandError> {
    let root = validate_project_path(&project_path)?;
    write_json_property(
        &root,
        &source_file,
        source_line,
        source_column,
        &old_src,
        &new_src,
        &expected_file,
        &expected_property_path,
        &expected_expression,
        &expected_references,
        &expected_literal_references,
        expected_scope_known,
        confirmed_shared,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/pages")).unwrap();
        std::fs::create_dir_all(dir.path().join("src/data")).unwrap();
        std::fs::create_dir_all(dir.path().join("scripts")).unwrap();
        std::fs::write(
            dir.path().join("src/data/assets.json"),
            "{\n  \"untouched\": 42,\n  \"updates\": { \"imgImage\": \"/old\\\"image.png\" }\n}\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("src/pages/index.astro"),
            "---\nimport assets from '../data/assets.json';\n---\n<img src={assets.updates.imgImage} />\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("scripts/process-hero-images.mjs"),
            "import assets from '../src/data/assets.json';\nconsole.log(assets.updates.imgImage);\nconst fallback = \"/old\\\"image.png\";\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn resolves_static_json_import_member_chain_and_reports_shared_references() {
        let dir = fixture();
        let root = dir.path();
        let result = resolve_by_value(root, "/old\"image.png").unwrap().unwrap();
        assert_eq!(result.file, "src/data/assets.json");
        assert_eq!(result.property_path, ["updates", "imgImage"]);
        assert_eq!(result.references.len(), 2);
        assert_eq!(result.literal_references.len(), 1);
        assert_eq!(
            result.literal_references[0],
            "scripts/process-hero-images.mjs:3:18"
        );
        assert!(result.scope_known);
    }

    #[test]
    fn reference_scan_includes_gitignored_authored_markdown_imports() {
        let dir = fixture();
        let root = dir.path();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join(".gitignore"), "docs/usage.md\n").unwrap();
        std::fs::write(
            root.join("docs/usage.md"),
            "import assets from '../src/data/assets.json';\nThe URL is {assets.updates.imgImage}.\n",
        )
        .unwrap();

        let resolved = resolve_by_value(root, "/old\"image.png").unwrap().unwrap();
        assert!(resolved
            .references
            .iter()
            .any(|reference| reference.starts_with("docs/usage.md:")));
        assert!(resolved.scope_known);
    }

    #[test]
    fn unparseable_authored_file_marks_json_reference_scope_unknown() {
        let dir = fixture();
        let root = dir.path();
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        std::fs::write(root.join("scripts/unknown.mjs"), "/* unclosed").unwrap();

        let resolved = resolve_by_value(root, "/old\"image.png").unwrap().unwrap();
        assert!(!resolved.scope_known);
        assert!(write_json_property(
            root,
            &resolved.source_file,
            resolved.source_line,
            resolved.source_column,
            &resolved.src,
            "/replacement.png",
            &resolved.file,
            &resolved.property_path,
            &resolved.expression,
            &resolved.references,
            &resolved.literal_references,
            resolved.scope_known,
            false,
        )
        .is_err());
    }

    #[test]
    fn writer_checks_drift_and_escapes_json_string_without_reformatting_other_data() {
        let dir = fixture();
        let canonical_root = dir.path().canonicalize().unwrap();
        let root = canonical_root.as_path();
        let resolved = resolve_by_value(root, "/old\"image.png").unwrap().unwrap();
        let scan = source_files(root);
        let file = scan
            .files
            .iter()
            .find(|file| file.relative == resolved.source_file)
            .expect("resolved source file is part of the fixture");
        let parsed = tokens(&file.source).unwrap();
        let imports = parse_imports(root, file, &parsed);
        assert_eq!(imports.len(), 1);
        let line = resolved.source_line;
        let column = resolved.source_column;
        assert!(write_json_property(
            root,
            &file.relative,
            line,
            column,
            "/wrong.png",
            "/new.png",
            &resolved.file,
            &resolved.property_path,
            &resolved.expression,
            &resolved.references,
            &resolved.literal_references,
            resolved.scope_known,
            true
        )
        .is_err());
        assert!(write_json_property(
            root,
            &file.relative,
            line,
            column,
            "/old\"image.png",
            "/replacement.png",
            "src/data/other.json",
            &resolved.property_path,
            &resolved.expression,
            &resolved.references,
            &resolved.literal_references,
            resolved.scope_known,
            true
        )
        .is_err());
        assert!(write_json_property(
            root,
            &file.relative,
            line,
            column,
            "/old\"image.png",
            "/new\"image\\path.png",
            &resolved.file,
            &resolved.property_path,
            &resolved.expression,
            &resolved.references,
            &resolved.literal_references,
            resolved.scope_known,
            false
        )
        .is_err());
        write_json_property(
            root,
            &file.relative,
            line,
            column,
            "/old\"image.png",
            "/new\"image\\path.png",
            &resolved.file,
            &resolved.property_path,
            &resolved.expression,
            &resolved.references,
            &resolved.literal_references,
            resolved.scope_known,
            true,
        )
        .unwrap();
        let saved = std::fs::read_to_string(root.join("src/data/assets.json")).unwrap();
        assert!(saved.contains("\"untouched\": 42"));
        assert!(saved.contains("/new\\\"image\\\\path.png"));
    }

    #[test]
    fn rejects_computed_and_non_json_import_expressions() {
        let dir = fixture();
        let root = dir.path();
        let page = root.join("src/pages/index.astro");
        std::fs::write(
            &page,
            "import assets from '../data/assets.json';\n<img src={assets.updates[which]} />\n",
        )
        .unwrap();
        assert!(resolve_by_value(root, "/old\"image.png").unwrap().is_none());
        assert!(canonical_json_import(root, &page, "@/assets.json").is_none());
        assert!(canonical_json_import(root, &page, "../../../outside.json").is_none());
        assert!(locate_site(root, "../outside.tsx", 1, 1, "/old\"image.png").is_err());
    }

    #[test]
    fn refuses_to_resolve_when_the_import_name_is_shadowed_by_a_component_parameter() {
        let dir = fixture();
        let root = dir.path();
        let page = root.join("src/pages/index.astro");
        let source = "import assets from '../data/assets.json'\nfunction Page(assets) { return <img src={assets.updates.imgImage} /> }";
        std::fs::write(&page, source).unwrap();
        let site = source.find("<img").unwrap();
        assert!(
            resolve_at_site(root, "src/pages/index.astro", site, Some("/old\"image.png")).is_none()
        );
    }

    #[test]
    fn refuses_multiple_json_properties_with_the_same_rendered_url() {
        let dir = fixture();
        let root = dir.path();
        std::fs::write(
            root.join("src/data/assets.json"),
            "{\"updates\":{\"imgImage\":\"/old.jpg\",\"otherImage\":\"/old.jpg\"}}",
        )
        .unwrap();
        std::fs::write(
            root.join("src/pages/index.astro"),
            "import assets from '../data/assets.json';\n<img src={assets.updates.imgImage} />\n<img src={assets.updates.otherImage} />\n",
        )
        .unwrap();
        assert!(resolve_by_value(root, "/old.jpg").is_err());
    }

    #[test]
    fn refuses_json_value_mapping_when_a_static_img_has_the_same_url() {
        let dir = fixture();
        let root = dir.path();
        std::fs::write(
            root.join("src/pages/static.astro"),
            "<img src='/old\"image.png' />\n",
        )
        .unwrap();

        assert!(resolve_by_value(root, "/old\"image.png").is_err());
    }
}
