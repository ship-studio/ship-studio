//! Exact source identities and conservative selector/rule transformations for CSS editing.
//! Kept separate from the stylesheet discovery and declaration editor so mutation safety
//! rules remain independently reviewable.

use super::edit_css::{index_rules, norm_selector, normalized_selector_parts, RuleSpan};
use crate::errors::CommandError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CssRuleSourceIdentity {
    pub source_path: String,
    pub source_version: String,
    pub selector_offset: usize,
    pub selector: String,
    pub selector_member_index: usize,
    pub matched_selector: String,
    pub selector_members: Vec<String>,
    #[serde(default)]
    pub selector_list_split_safe: bool,
    pub inner_text: String,
    pub context_path: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CssConsolidationCandidate {
    pub file: String,
    pub before: String,
    pub after: String,
    pub source_version: String,
    pub first: CssRuleSourceIdentity,
    pub second: CssRuleSourceIdentity,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CssConsolidationReview {
    pub candidates: Vec<CssConsolidationCandidate>,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CssRuleIdentityRemap {
    /// Selector offset in the source snapshot before the at-rule rename.
    pub old_selector_offset: usize,
    /// Selector-list member index in the source snapshot before the rename.
    pub selector_member_index: usize,
    /// Exact identity for the same rule and member in the renamed source snapshot.
    pub identity: CssRuleSourceIdentity,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CssAtRuleRenameResult {
    pub selected: CssRuleSourceIdentity,
    /// Exact offset-based identity refreshes for every selector member in the changed
    /// media block. These map rows from the same authored wrapper without guessing from
    /// selector/declaration similarity.
    pub remapped_rules: Vec<CssRuleIdentityRemap>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CssRuleSelectorListSplitResult {
    pub selected: CssRuleSourceIdentity,
    /// Exact refreshed identities for every original selector member and every rule
    /// shifted by inserting the adjacent split rules.
    pub remapped_rules: Vec<CssRuleIdentityRemap>,
}

pub fn source_version(source: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(source.as_bytes()))
}

pub(super) fn identity_for_rule(
    file: &str,
    source: &str,
    rule: &RuleSpan,
    selector_member_index: usize,
    matched_selector: &str,
) -> Option<CssRuleSourceIdentity> {
    let members = normalized_selector_parts(&rule.selector);
    if members.get(selector_member_index).map(String::as_str)
        != Some(norm_selector(matched_selector).as_str())
    {
        return None;
    }
    Some(CssRuleSourceIdentity {
        source_path: file.to_string(),
        source_version: source_version(source),
        selector_offset: rule.selector_start,
        selector: rule.selector.clone(),
        selector_member_index,
        matched_selector: norm_selector(matched_selector),
        selector_members: members,
        selector_list_split_safe: selector_list_split_safe(source, rule),
        inner_text: source[rule.block_inner_start..rule.block_inner_end].to_string(),
        context_path: rule.context_path.clone(),
    })
}

pub(super) fn resolve_identity(
    file: &str,
    source: &str,
    identity: &CssRuleSourceIdentity,
) -> Result<RuleSpan, CommandError> {
    let stale = || CommandError::Validation {
        field: "css".into(),
        reason: "source changed since you selected it — reselect to edit".into(),
    };
    if identity.source_path != file || source_version(source) != identity.source_version {
        return Err(stale());
    }
    let matches: Vec<_> = index_rules(source)
        .into_iter()
        .filter(|rule| rule.selector_start == identity.selector_offset)
        .collect();
    let rule = matches.first().ok_or_else(stale)?;
    let current_inner = &source[rule.block_inner_start..rule.block_inner_end];
    let members = normalized_selector_parts(&rule.selector);
    if rule.selector != identity.selector
        || current_inner != identity.inner_text
        || rule.context_path != identity.context_path
        || members != identity.selector_members
        || members.get(identity.selector_member_index) != Some(&identity.matched_selector)
        || matches.len() != 1
    {
        return Err(stale());
    }
    matches.into_iter().next().ok_or_else(stale)
}

#[derive(Debug, Clone)]
struct SelectorPart {
    start: usize,
    end: usize,
    list_index: usize,
    global_inner: Option<(usize, usize)>,
    global_inner_count: usize,
}

fn selector_segments(source: &str, start: usize, end: usize) -> Vec<(usize, usize)> {
    let bytes = source.as_bytes();
    let mut ranges = Vec::new();
    let (mut i, mut segment, mut depth, mut quote) = (start, start, 0i32, 0u8);
    while i < end {
        let c = bytes[i];
        if quote != 0 {
            if c == b'\\' {
                i = super::edit_css::css_selector_escape_end(source, i, end);
                continue;
            }
            if c == quote {
                quote = 0;
            }
            i += 1;
            continue;
        }
        if c == b'\\' {
            i = super::edit_css::css_selector_escape_end(source, i, end);
            continue;
        }
        if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            if let Some(comment_end) = source[i + 2..end].find("*/") {
                i += comment_end + 4;
                continue;
            }
            break;
        }
        match c {
            b'\'' | b'"' => quote = c,
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth = (depth - 1).max(0),
            b',' if depth == 0 => {
                ranges.push(trim_bytes(source, segment, i));
                segment = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    ranges.push(trim_bytes(source, segment, end));
    ranges
}

fn trim_bytes(source: &str, mut start: usize, mut end: usize) -> (usize, usize) {
    while start < end && source.as_bytes()[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && source.as_bytes()[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    (start, end)
}

fn matching_global_end(source: &str, start: usize, end: usize) -> Option<usize> {
    if !source
        .get(start..start.saturating_add(8))?
        .eq_ignore_ascii_case(":global(")
    {
        return None;
    }
    let bytes = source.as_bytes();
    let mut depth = 1usize;
    let mut quote = 0u8;
    let mut index = start + 8;
    while index < end {
        let byte = bytes[index];
        if quote != 0 {
            if byte == b'\\' {
                index = super::edit_css::css_selector_escape_end(source, index, end);
                continue;
            }
            if byte == quote {
                quote = 0;
            }
            index += 1;
            continue;
        }
        if byte == b'\\' {
            index = super::edit_css::css_selector_escape_end(source, index, end);
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            if let Some(comment_end) = source[index + 2..end].find("*/") {
                index += comment_end + 4;
                continue;
            }
            return None;
        }
        match byte {
            b'\'' | b'"' => quote = byte,
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
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

fn source_selector_parts(source: &str, rule: &RuleSpan) -> Vec<SelectorPart> {
    let open = rule.block_inner_start.saturating_sub(1);
    let groups = selector_segments(source, rule.selector_start, open);
    let mut out = Vec::new();
    for (list_index, (start, end)) in groups.into_iter().enumerate() {
        if let Some(close) = matching_global_end(source, start, end) {
            let after = source[close + 1..end].trim();
            if after.is_empty() {
                let inner_start = start + 8;
                let inner = selector_segments(source, inner_start, close);
                for (part_start, part_end) in &inner {
                    out.push(SelectorPart {
                        start: *part_start,
                        end: *part_end,
                        list_index,
                        global_inner: Some((inner_start, close)),
                        global_inner_count: inner.len(),
                    });
                }
                continue;
            }
        }
        out.push(SelectorPart {
            start,
            end,
            list_index,
            global_inner: None,
            global_inner_count: 1,
        });
    }
    out
}

fn simple_selector_specificity(selector: &str) -> Option<[usize; 3]> {
    let bytes = selector.as_bytes();
    let mut specificity = [0usize; 3];
    let mut index = 0usize;
    let mut compound_start = true;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() || matches!(byte, b'>' | b'+' | b'~') {
            compound_start = true;
            index += 1;
            continue;
        }
        match byte {
            b'#' | b'.' => {
                let end = consume_selector_identifier(selector, index + 1, bytes.len())?;
                if end == index + 1 {
                    return None;
                }
                specificity[if byte == b'#' { 0 } else { 1 }] += 1;
                compound_start = false;
                index = end;
            }
            b'[' => {
                let end = selector_attribute_end(selector, index, bytes.len())?;
                specificity[1] += 1;
                compound_start = false;
                index = end;
            }
            b'*' => {
                compound_start = false;
                index += 1;
            }
            b':' | b'&' | b'|' | b',' | b';' | b'{' | b'}' => return None,
            _ if selector_identifier_byte(byte) || byte == b'\\' => {
                let end = consume_selector_identifier(selector, index, bytes.len())?;
                if end == index {
                    return None;
                }
                if compound_start {
                    specificity[2] += 1;
                }
                compound_start = false;
                index = end;
            }
            _ => return None,
        }
    }
    Some(specificity)
}

fn selector_identifier_byte(byte: u8) -> bool {
    byte >= 0x80 || byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

fn consume_selector_identifier(source: &str, mut index: usize, end: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let start = index;
    while index < end {
        if bytes[index] == b'\\' {
            let escaped = super::edit_css::css_selector_escape_end(source, index, end);
            if escaped == index + 1 {
                return None;
            }
            index = escaped;
        } else if selector_identifier_byte(bytes[index]) {
            index += 1;
        } else {
            break;
        }
    }
    (index > start).then_some(index)
}

fn selector_attribute_end(source: &str, start: usize, end: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut quote = 0u8;
    let mut index = start + 1;
    while index < end {
        let byte = bytes[index];
        if quote != 0 {
            if byte == b'\\' {
                index = super::edit_css::css_selector_escape_end(source, index, end);
                continue;
            }
            if byte == quote {
                quote = 0;
            }
            index += 1;
            continue;
        }
        if byte == b'\\' {
            index = super::edit_css::css_selector_escape_end(source, index, end);
            continue;
        }
        if byte == b'"' || byte == b'\'' {
            quote = byte;
        } else if byte == b']' {
            return Some(index + 1);
        }
        index += 1;
    }
    None
}

fn selector_list_has_nested_block(body: &str) -> bool {
    let bytes = body.as_bytes();
    let mut quote = 0u8;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if quote != 0 {
            if byte == b'\\' {
                index = super::edit_css::css_selector_escape_end(body, index, bytes.len());
                continue;
            }
            if byte == quote {
                quote = 0;
            }
            index += 1;
            continue;
        }
        if byte == b'\\' {
            index = super::edit_css::css_selector_escape_end(body, index, bytes.len());
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            if let Some(comment_end) = body[index + 2..].find("*/") {
                index += comment_end + 4;
                continue;
            }
            return true;
        }
        if byte == b'"' || byte == b'\'' {
            quote = byte;
        } else if byte == b'{' {
            return true;
        }
        index += 1;
    }
    false
}

fn selector_list_split_safe(source: &str, rule: &RuleSpan) -> bool {
    let open = rule.block_inner_start.saturating_sub(1);
    let prelude = match source.get(rule.selector_start..open) {
        Some(prelude) => prelude,
        None => return false,
    };
    if prelude.contains("/*")
        || selector_list_has_nested_block(&source[rule.block_inner_start..rule.block_inner_end])
    {
        return false;
    }
    let parts = source_selector_parts(source, rule);
    let logical = normalized_selector_parts(&rule.selector);
    if parts.len() <= 1 || parts.len() != logical.len() {
        return false;
    }
    let mut expected = None;
    for part in parts {
        let member = &source[part.start..part.end];
        let specificity = match simple_selector_specificity(member) {
            Some(specificity) => specificity,
            None => return false,
        };
        if expected.is_some_and(|expected| expected != specificity) {
            return false;
        }
        expected = Some(specificity);
    }
    true
}

fn exact_member<'a>(
    source: &'a str,
    rule: &RuleSpan,
    identity: &CssRuleSourceIdentity,
) -> Result<SelectorPart, CommandError> {
    let parts = source_selector_parts(source, rule);
    let part = parts
        .get(identity.selector_member_index)
        .cloned()
        .ok_or_else(|| CommandError::Validation {
            field: "selector".into(),
            reason: "the selected selector member is no longer present".into(),
        })?;
    if norm_selector(&source[part.start..part.end]) != identity.matched_selector {
        return Err(CommandError::Validation {
            field: "selector".into(),
            reason: "the selected selector member changed — reselect to edit".into(),
        });
    }
    Ok(part)
}

fn replace_span(source: &str, start: usize, end: usize, replacement: &str) -> String {
    let mut out = String::with_capacity(source.len() + replacement.len());
    out.push_str(&source[..start]);
    out.push_str(replacement);
    out.push_str(&source[end..]);
    out
}

fn media_block_bounds(source: &str, condition_end: usize) -> Result<(usize, usize), CommandError> {
    let bytes = source.as_bytes();
    let mut open = condition_end;
    loop {
        while open < bytes.len() && bytes[open].is_ascii_whitespace() {
            open += 1;
        }
        if bytes.get(open) == Some(&b'/') && bytes.get(open + 1) == Some(&b'*') {
            open += 2;
            while open + 1 < bytes.len() && !(bytes[open] == b'*' && bytes[open + 1] == b'/') {
                open += 1;
            }
            if open + 1 >= bytes.len() {
                break;
            }
            open += 2;
            continue;
        }
        break;
    }
    if bytes.get(open) != Some(&b'{') {
        return Err(CommandError::Validation {
            field: "media".into(),
            reason: "the enclosing media block could not be isolated safely".into(),
        });
    }

    let mut depth = 0usize;
    let mut index = open;
    let mut quote = 0u8;
    while index < bytes.len() {
        let byte = bytes[index];
        if quote != 0 {
            if byte == b'\\' {
                index = (index + 2).min(bytes.len());
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
                break;
            }
            index += 2;
            continue;
        }
        match byte {
            b'\'' | b'"' => quote = byte,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Ok((open + 1, index));
                }
            }
            _ => {}
        }
        index += 1;
    }
    Err(CommandError::Validation {
        field: "media".into(),
        reason: "the enclosing media block could not be isolated safely".into(),
    })
}

fn whitespace_and_comments_only(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            if index + 1 >= bytes.len() {
                return false;
            }
            index += 2;
            continue;
        }
        return false;
    }
    true
}

fn indent_source_lines(source: &str, indent: &str) -> String {
    let mut out = String::with_capacity(source.len() + indent.len() * 4);
    out.push_str(indent);
    let mut segment_start = 0usize;
    for (index, byte) in source.bytes().enumerate() {
        if byte == b'\n' {
            out.push_str(&source[segment_start..=index]);
            segment_start = index + 1;
            if segment_start < source.len() {
                out.push_str(indent);
            }
        }
    }
    out.push_str(&source[segment_start..]);
    out
}

fn refreshed_identity(
    file: &str,
    source: &str,
    offset: usize,
    selector_member_index: usize,
    matched_selector: &str,
) -> Result<CssRuleSourceIdentity, CommandError> {
    index_rules(source)
        .into_iter()
        .find(|rule| rule.selector_start == offset)
        .and_then(|rule| {
            identity_for_rule(file, source, &rule, selector_member_index, matched_selector)
        })
        .ok_or_else(|| CommandError::Validation {
            field: "css".into(),
            reason: "the edited rule could not be re-identified; reselect to continue".into(),
        })
}

pub fn apply_body(
    file: &str,
    source: &str,
    identity: &CssRuleSourceIdentity,
    new_inner: &str,
) -> Result<(String, CssRuleSourceIdentity), CommandError> {
    let rule = resolve_identity(file, source, identity)?;
    let updated = replace_span(
        source,
        rule.block_inner_start,
        rule.block_inner_end,
        new_inner,
    );
    let next = refreshed_identity(
        file,
        &updated,
        rule.selector_start,
        identity.selector_member_index,
        &identity.matched_selector,
    )?;
    Ok((updated, next))
}

fn selector_after_member_removal(
    source: &str,
    rule: &RuleSpan,
    part: &SelectorPart,
) -> Result<String, CommandError> {
    let open = rule.block_inner_start.saturating_sub(1);
    let prelude = &source[rule.selector_start..open];
    let groups = selector_segments(source, rule.selector_start, open);
    let group = groups
        .get(part.list_index)
        .copied()
        .ok_or_else(|| CommandError::Validation {
            field: "selector".into(),
            reason: "the selected selector member could not be isolated".into(),
        })?;
    let nested = part.global_inner;
    let (start, end, count) = if nested.is_some() {
        if part.global_inner_count > 1 {
            (part.start, part.end, part.global_inner_count)
        } else {
            (group.0, group.1, groups.len())
        }
    } else {
        (part.start, part.end, groups.len())
    };
    if count <= 1 {
        return Err(CommandError::Validation {
            field: "selector".into(),
            reason: "this is the only selector in the rule; use Delete rule instead".into(),
        });
    }
    let ranges = if nested.is_some() && part.global_inner_count > 1 {
        selector_segments(source, nested.unwrap().0, nested.unwrap().1)
    } else {
        groups
    };
    let position = ranges
        .iter()
        .position(|range| *range == (start, end))
        .ok_or_else(|| CommandError::Validation {
            field: "selector".into(),
            reason: "the selected selector member could not be isolated".into(),
        })?;
    let (remove_start, remove_end) = if position == 0 {
        (start, ranges[1].0)
    } else {
        (ranges[position - 1].1, end)
    };
    Ok(replace_span(
        prelude,
        remove_start - rule.selector_start,
        remove_end - rule.selector_start,
        "",
    ))
}

pub fn remove_member(
    file: &str,
    source: &str,
    identity: &CssRuleSourceIdentity,
) -> Result<(String, Option<CssRuleSourceIdentity>), CommandError> {
    let rule = resolve_identity(file, source, identity)?;
    let part = exact_member(source, &rule, identity)?;
    let selector = selector_after_member_removal(source, &rule, &part)?;
    let open = rule.block_inner_start.saturating_sub(1);
    let updated = replace_span(source, rule.selector_start, open, &selector);
    let next = refreshed_identity(
        file,
        &updated,
        rule.selector_start,
        0,
        &normalized_selector_parts(&selector)[0],
    )
    .ok();
    Ok((updated, next))
}

pub fn rename_member(
    file: &str,
    source: &str,
    identity: &CssRuleSourceIdentity,
    new_selector: &str,
) -> Result<(String, CssRuleSourceIdentity), CommandError> {
    let new_selector = new_selector.trim();
    if new_selector.is_empty()
        || new_selector
            .chars()
            .any(|character| matches!(character, '{' | '}' | ';' | ','))
    {
        return Err(CommandError::Validation {
            field: "selector".into(),
            reason: "enter one CSS selector without braces or commas".into(),
        });
    }
    let rule = resolve_identity(file, source, identity)?;
    let part = exact_member(source, &rule, identity)?;
    if source[rule.selector_start..rule.block_inner_start - 1].contains("/*") {
        return Err(CommandError::Validation {
            field: "selector".into(),
            reason: "selector edits with selector comments are not supported yet".into(),
        });
    }
    if part.global_inner.is_none() && source[part.start..part.end].contains(":global(") {
        return Err(CommandError::Validation {
            field: "selector".into(),
            reason: "renaming this Astro selector would require rewriting a nested :global() wrapper; edit it in the source instead".into(),
        });
    }
    let (start, end, replacement) = if let Some((inner_start, inner_end)) = part.global_inner {
        if part.global_inner_count > 1 {
            (part.start, part.end, new_selector.to_string())
        } else {
            (inner_start, inner_end, new_selector.to_string())
        }
    } else {
        (part.start, part.end, new_selector.to_string())
    };
    let updated = replace_span(source, start, end, &replacement);
    let next = refreshed_identity(
        file,
        &updated,
        rule.selector_start,
        identity.selector_member_index,
        new_selector,
    )?;
    Ok((updated, next))
}

pub fn delete_rule(
    file: &str,
    source: &str,
    identity: &CssRuleSourceIdentity,
) -> Result<String, CommandError> {
    let rule = resolve_identity(file, source, identity)?;
    let bytes = source.as_bytes();
    let mut start = rule.selector_start;
    while start > 0 && matches!(bytes[start - 1], b' ' | b'\t') {
        start -= 1;
    }
    let mut end = rule.block_inner_end + 1;
    while end < bytes.len() && matches!(bytes[end], b' ' | b'\t') {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'\n' {
        end += 1;
    }
    Ok(replace_span(source, start, end, ""))
}

/// Delete a batch of exact sibling rules from one unchanged source snapshot.
/// Used by the media-group action so deleting several rules doesn't invalidate
/// the occurrence identity between sequential writes.
pub fn delete_rules(
    file: &str,
    source: &str,
    identities: &[CssRuleSourceIdentity],
) -> Result<String, CommandError> {
    if identities.is_empty() {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "select at least one exact source rule".into(),
        });
    }
    let first_version = &identities[0].source_version;
    let mut ranges = Vec::with_capacity(identities.len());
    for identity in identities {
        if identity.source_path != file || &identity.source_version != first_version {
            return Err(CommandError::Validation {
                field: "css".into(),
                reason: "rules do not belong to one unchanged stylesheet snapshot".into(),
            });
        }
        let rule = resolve_identity(file, source, identity)?;
        let bytes = source.as_bytes();
        let mut start = rule.selector_start;
        while start > 0 && matches!(bytes[start - 1], b' ' | b'\t') {
            start -= 1;
        }
        let mut end = rule.block_inner_end + 1;
        while end < bytes.len() && matches!(bytes[end], b' ' | b'\t') {
            end += 1;
        }
        if end < bytes.len() && bytes[end] == b'\n' {
            end += 1;
        }
        ranges.push((start, end));
    }
    ranges.sort_unstable();
    ranges.dedup();
    if ranges.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "selected rule ranges overlap".into(),
        });
    }
    let mut updated = source.to_string();
    for (start, end) in ranges.into_iter().rev() {
        updated = replace_span(&updated, start, end, "");
    }
    Ok(updated)
}

pub fn replace_selector_list(
    file: &str,
    source: &str,
    identity: &CssRuleSourceIdentity,
    new_selector_list: &str,
) -> Result<(String, CssRuleSourceIdentity), CommandError> {
    let rule = resolve_identity(file, source, identity)?;
    super::edit_css::validate_selector_list(new_selector_list)?;
    let new_selector_list = new_selector_list.trim();
    let open = rule.block_inner_start.saturating_sub(1);
    let original_prelude = &source[rule.selector_start..open];
    if original_prelude.contains("/*") {
        return Err(CommandError::Validation {
            field: "selector".into(),
            reason: "selector edits with selector comments are not supported yet; edit this prelude in source".into(),
        });
    }
    let trimmed_end = original_prelude.trim_end().len();
    let replacement = format!("{}{}", new_selector_list, &original_prelude[trimmed_end..]);
    let updated = replace_span(source, rule.selector_start, open, &replacement);
    let members = normalized_selector_parts(new_selector_list);
    let member_index = identity
        .selector_member_index
        .min(members.len().saturating_sub(1));
    let matched = members
        .get(member_index)
        .ok_or_else(|| CommandError::Validation {
            field: "selector".into(),
            reason: "enter at least one selector".into(),
        })?;
    let next = refreshed_identity(file, &updated, rule.selector_start, member_index, matched)?;
    Ok((updated, next))
}

pub fn split_selector_list(
    file: &str,
    source: &str,
    identity: &CssRuleSourceIdentity,
) -> Result<(String, CssRuleSelectorListSplitResult), CommandError> {
    let rule = resolve_identity(file, source, identity)?;
    if !selector_list_split_safe(source, &rule) {
        return Err(CommandError::Validation {
            field: "selector".into(),
            reason: "this selector list contains nested or specificity-sensitive structure that cannot be split safely".into(),
        });
    }
    let parts = source_selector_parts(source, &rule);
    let logical_members = normalized_selector_parts(&rule.selector);
    let open = rule.block_inner_start.saturating_sub(1);
    let close = rule.block_inner_end + 1;
    let original_prelude = &source[rule.selector_start..open];
    let trailing_space = &original_prelude[original_prelude.trim_end().len()..];
    let body = &source[open..close];
    let indent = super::edit_css::indent_of_line(source, rule.selector_start);
    let newline = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut rendered = String::new();
    let mut new_offsets = Vec::with_capacity(parts.len());
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            rendered.push_str(newline);
            rendered.push_str(&indent);
        }
        new_offsets.push(rule.selector_start + rendered.len());
        let member = if let Some((inner_start, inner_end)) = part.global_inner {
            let group = selector_segments(source, rule.selector_start, open)
                .get(part.list_index)
                .copied()
                .ok_or_else(|| CommandError::Validation {
                    field: "selector".into(),
                    reason: "the Astro selector wrapper could not be isolated safely".into(),
                })?;
            let outer = &source[group.0..group.1];
            replace_span(
                outer,
                inner_start - group.0,
                inner_end - group.0,
                &source[part.start..part.end],
            )
        } else {
            source[part.start..part.end].to_string()
        };
        rendered.push_str(&member);
        rendered.push_str(trailing_space);
        rendered.push_str(body);
    }
    let updated = replace_span(source, rule.selector_start, close, &rendered);
    let delta = rendered.len() as isize - (close - rule.selector_start) as isize;
    let original_rules = index_rules(source);
    let updated_rules = index_rules(&updated);
    let mut remapped_rules = Vec::new();
    for old_rule in &original_rules {
        let old_members = normalized_selector_parts(&old_rule.selector);
        let new_rule_offsets = if old_rule.selector_start == rule.selector_start {
            new_offsets.clone()
        } else {
            let adjusted = if old_rule.selector_start > rule.selector_start {
                if delta >= 0 {
                    old_rule.selector_start.checked_add(delta as usize)
                } else {
                    old_rule.selector_start.checked_sub((-delta) as usize)
                }
            } else {
                Some(old_rule.selector_start)
            }
            .ok_or_else(|| CommandError::Validation {
                field: "css".into(),
                reason: "the split rules could not be re-identified safely".into(),
            })?;
            vec![adjusted; old_members.len()]
        };
        if old_rule.selector_start == rule.selector_start && old_members.len() != new_offsets.len()
        {
            return Err(CommandError::Validation {
                field: "selector".into(),
                reason: "the selector members could not be mapped to separate rules safely".into(),
            });
        }
        for (old_member_index, matched_selector) in old_members.iter().enumerate() {
            let new_offset = *new_rule_offsets.get(old_member_index).ok_or_else(|| {
                CommandError::Validation {
                    field: "css".into(),
                    reason: "the split selector members could not be re-identified safely".into(),
                }
            })?;
            let new_member_index = if old_rule.selector_start == rule.selector_start {
                0
            } else {
                old_member_index
            };
            let candidates = updated_rules
                .iter()
                .filter(|candidate| candidate.selector_start == new_offset)
                .collect::<Vec<_>>();
            if candidates.len() != 1 {
                return Err(CommandError::Validation {
                    field: "css".into(),
                    reason: "the split rules could not be re-identified safely".into(),
                });
            }
            let refreshed = identity_for_rule(
                file,
                &updated,
                candidates[0],
                new_member_index,
                matched_selector,
            )
            .ok_or_else(|| CommandError::Validation {
                field: "css".into(),
                reason: "a source rule or selector member could not be refreshed safely".into(),
            })?;
            remapped_rules.push(CssRuleIdentityRemap {
                old_selector_offset: old_rule.selector_start,
                selector_member_index: old_member_index,
                identity: refreshed,
            });
        }
    }
    let selected = remapped_rules
        .iter()
        .find(|remap| {
            remap.old_selector_offset == identity.selector_offset
                && remap.selector_member_index == identity.selector_member_index
        })
        .map(|remap| remap.identity.clone())
        .ok_or_else(|| CommandError::Validation {
            field: "css".into(),
            reason: "the selected split rule could not be re-identified safely".into(),
        })?;
    debug_assert_eq!(logical_members.len(), parts.len());
    Ok((
        updated,
        CssRuleSelectorListSplitResult {
            selected,
            remapped_rules,
        },
    ))
}

pub fn make_independent(
    file: &str,
    source: &str,
    identity: &CssRuleSourceIdentity,
) -> Result<(String, CssRuleSourceIdentity), CommandError> {
    let rule = resolve_identity(file, source, identity)?;
    let part = exact_member(source, &rule, identity)?;
    if normalized_selector_parts(&rule.selector).len() <= 1 {
        return Err(CommandError::Validation {
            field: "selector".into(),
            reason: "Make independent requires a selector list with more than one member".into(),
        });
    }
    let selector = selector_after_member_removal(source, &rule, &part)?;
    let selector_member = if part.global_inner.is_some() {
        format!(":global({})", source[part.start..part.end].trim())
    } else {
        source[part.start..part.end].trim().to_string()
    };
    let open = rule.block_inner_start - 1;
    let close = rule.block_inner_end + 1;
    let original_rule = replace_span(
        &source[rule.selector_start..close],
        0,
        open - rule.selector_start,
        &selector,
    );
    let indent = super::edit_css::indent_of_line(source, rule.selector_start);
    let newline = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let clone = format!(
        "{newline}{indent}{selector_member} {{{}}}",
        &source[rule.block_inner_start..rule.block_inner_end]
    );
    let original_rule_len = original_rule.len();
    let updated = replace_span(
        source,
        rule.selector_start,
        close,
        &(original_rule + &clone),
    );
    let new_offset = rule.selector_start + original_rule_len + newline.len() + indent.len();
    let next = refreshed_identity(file, &updated, new_offset, 0, &identity.matched_selector)?;
    Ok((updated, next))
}

pub fn wrap_rule(
    file: &str,
    source: &str,
    identity: &CssRuleSourceIdentity,
    at_prelude: &str,
) -> Result<(String, CssRuleSourceIdentity), CommandError> {
    let at = at_prelude.trim();
    if !at.starts_with('@') || at.chars().any(|character| matches!(character, '{' | '}')) {
        return Err(CommandError::Validation {
            field: "atRule".into(),
            reason: "invalid at-rule prelude".into(),
        });
    }
    let rule = resolve_identity(file, source, identity)?;
    let mut region_start = rule.selector_start;
    while region_start > 0 && source.as_bytes()[region_start - 1] != b'\n' {
        region_start -= 1;
    }
    let end = rule.block_inner_end + 1;
    let prefix = &source[region_start..rule.selector_start];
    if !whitespace_and_comments_only(prefix) {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "same-line content before this rule cannot be preserved safely while wrapping"
                .into(),
        });
    }
    let raw_rule = &source[rule.selector_start..end];
    let indent = super::edit_css::indent_of_line(source, rule.selector_start);
    let inner_indent = format!("{indent}  ");
    let indented = indent_source_lines(raw_rule, &inner_indent);
    let newline = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let wrapper = format!("{at} {{{newline}{indented}{newline}{indent}}}");
    let wrapped_region = format!("{prefix}{wrapper}");
    let updated = replace_span(source, region_start, end, &wrapped_region);
    let offset = region_start + prefix.len() + at.len() + 2 + newline.len() + inner_indent.len();
    let next = refreshed_identity(
        file,
        &updated,
        offset,
        identity.selector_member_index,
        &identity.matched_selector,
    )?;
    Ok((updated, next))
}

pub fn rename_media(
    file: &str,
    source: &str,
    identity: &CssRuleSourceIdentity,
    new_media: &str,
) -> Result<(String, CssAtRuleRenameResult), CommandError> {
    let media = new_media.trim();
    if media.is_empty()
        || media
            .chars()
            .any(|character| matches!(character, '{' | '}'))
    {
        return Err(CommandError::Validation {
            field: "media".into(),
            reason: "invalid at-rule condition".into(),
        });
    }
    let rule = resolve_identity(file, source, identity)?;
    let (start, end) = rule.media_prelude.ok_or_else(|| CommandError::Validation {
        field: "media".into(),
        reason: "this rule isn't inside an at-rule".into(),
    })?;
    let original_rules = index_rules(source);
    let (block_start, block_end) = media_block_bounds(source, end)?;
    let affected_rules = original_rules
        .iter()
        .filter(|candidate| {
            candidate.selector_start >= block_start && candidate.selector_start < block_end
        })
        .collect::<Vec<_>>();
    if !affected_rules
        .iter()
        .any(|candidate| candidate.selector_start == rule.selector_start)
    {
        return Err(CommandError::Validation {
            field: "media".into(),
            reason: "the selected rule could not be matched to its media block".into(),
        });
    }

    let updated = replace_span(source, start, end, media);
    let updated_rules = index_rules(&updated);
    let mut remapped_rules = Vec::new();
    for old_rule in affected_rules {
        let new_offset = if media.len() >= end - start {
            old_rule
                .selector_start
                .checked_add(media.len() - (end - start))
        } else {
            old_rule
                .selector_start
                .checked_sub((end - start) - media.len())
        }
        .ok_or_else(|| CommandError::Validation {
            field: "media".into(),
            reason: "the renamed rules could not be re-identified safely".into(),
        })?;
        let matching_rules = updated_rules
            .iter()
            .filter(|candidate| candidate.selector_start == new_offset)
            .collect::<Vec<_>>();
        if matching_rules.len() != 1 {
            return Err(CommandError::Validation {
                field: "media".into(),
                reason: "the renamed rules could not be re-identified safely".into(),
            });
        }
        let new_rule = matching_rules[0];
        for (selector_member_index, matched_selector) in
            normalized_selector_parts(&old_rule.selector)
                .iter()
                .enumerate()
        {
            let next_identity = identity_for_rule(
                file,
                &updated,
                new_rule,
                selector_member_index,
                matched_selector,
            )
            .ok_or_else(|| CommandError::Validation {
                field: "media".into(),
                reason: "the renamed selector members could not be re-identified safely".into(),
            })?;
            remapped_rules.push(CssRuleIdentityRemap {
                old_selector_offset: old_rule.selector_start,
                selector_member_index,
                identity: next_identity,
            });
        }
    }
    let selected = remapped_rules
        .iter()
        .find(|mapped| {
            mapped.old_selector_offset == identity.selector_offset
                && mapped.selector_member_index == identity.selector_member_index
        })
        .map(|mapped| mapped.identity.clone())
        .ok_or_else(|| CommandError::Validation {
            field: "media".into(),
            reason: "the selected rule could not be re-identified safely".into(),
        })?;

    Ok((
        updated,
        CssAtRuleRenameResult {
            selected,
            remapped_rules,
        },
    ))
}

fn is_plain_declaration_body(body: &str) -> bool {
    let bytes = body.as_bytes();
    let mut i = 0usize;
    let mut quote = 0u8;
    while i < bytes.len() {
        let byte = bytes[i];
        if quote != 0 {
            if byte == b'\\' {
                i = (i + 2).min(bytes.len());
                continue;
            }
            if byte == quote {
                quote = 0;
            }
            i += 1;
            continue;
        }
        if byte == b'/' && bytes.get(i + 1) == Some(&b'*') {
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
        if byte == b'@' {
            // At-rules such as `@apply` and future declaration extensions have
            // preprocessing semantics that cannot be proven by source-order concatenation.
            return false;
        }
        match byte {
            b'\'' | b'"' => quote = byte,
            b'{' | b'}' => return false,
            _ => {}
        }
        i += 1;
    }
    quote == 0
}

fn body_ends_at_declaration_boundary(body: &str) -> bool {
    let mut significant = body.trim_end();
    loop {
        if significant.ends_with("*/") {
            let Some(comment_start) = significant.rfind("/*") else {
                return false;
            };
            significant = significant[..comment_start].trim_end();
            continue;
        }
        return significant.is_empty() || significant.ends_with(';');
    }
}

fn consolidation_parts<'a>(
    source: &'a str,
    first: &RuleSpan,
    second: &RuleSpan,
) -> Option<(String, String)> {
    if !first.context_path.is_empty()
        || !second.context_path.is_empty()
        || first.media.is_some()
        || second.media.is_some()
        || first.layer.is_some()
        || second.layer.is_some()
        || first.container.is_some()
        || second.container.is_some()
        || first.supports.is_some()
        || second.supports.is_some()
    {
        return None;
    }

    let first_open = first.block_inner_start.checked_sub(1)?;
    let second_open = second.block_inner_start.checked_sub(1)?;
    let first_selector = source[first.selector_start..first_open].trim();
    let second_selector = source[second.selector_start..second_open].trim();
    if first_selector.is_empty()
        || first_selector != second_selector
        || first_selector.contains("/*")
    {
        return None;
    }
    if source[first.block_inner_end + 1..second.selector_start]
        .chars()
        .any(|character| !character.is_whitespace())
    {
        // Inter-rule comments remain in the source, but a comment can carry tools or
        // source-map directives. Keep this review deliberately narrower than CSS semantics.
        return None;
    }
    let first_body = &source[first.block_inner_start..first.block_inner_end];
    let second_body = &source[second.block_inner_start..second.block_inner_end];
    if !is_plain_declaration_body(first_body)
        || !is_plain_declaration_body(second_body)
        || !body_ends_at_declaration_boundary(first_body)
    {
        return None;
    }

    let before_end = second.block_inner_end + 1;
    let before = source[first.selector_start..before_end].to_string();
    let mut after = String::with_capacity(before.len());
    after.push_str(&source[first.selector_start..first.block_inner_start]);
    after.push_str(first_body);
    after.push_str(&source[first.block_inner_end + 1..second.selector_start]);
    after.push_str(second_body);
    after.push('}');
    Some((before, after))
}

pub fn review_consolidations(file: &str, source: &str) -> CssConsolidationReview {
    let rules = index_rules(source);
    let mut candidates = Vec::new();
    let mut index = 0usize;
    while index + 1 < rules.len() {
        let first = &rules[index];
        let second = &rules[index + 1];
        if let Some((before, after)) = consolidation_parts(source, first, second) {
            if let Some(selector) = normalized_selector_parts(&first.selector).first() {
                if let (Some(first_id), Some(second_id)) = (
                    identity_for_rule(file, source, first, 0, selector),
                    identity_for_rule(file, source, second, 0, selector),
                ) {
                    candidates.push(CssConsolidationCandidate {
                        file: file.to_string(),
                        before,
                        after,
                        source_version: source_version(source),
                        first: first_id,
                        second: second_id,
                    });
                    index += 2;
                    continue;
                }
            }
        }
        index += 1;
    }
    CssConsolidationReview {
        unavailable_reason: candidates.is_empty().then(|| "No safe adjacent rules were found. Review supports only exact selector lists in plain, unlayered stylesheets with declaration-only bodies.".to_string()),
        candidates,
    }
}

pub fn apply_consolidation(
    file: &str,
    source: &str,
    candidate: &CssConsolidationCandidate,
) -> Result<String, CommandError> {
    if candidate.file != file || candidate.source_version != source_version(source) {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the consolidation proposal is stale — review the current stylesheet again"
                .into(),
        });
    }
    let first = resolve_identity(file, source, &candidate.first)?;
    let second = resolve_identity(file, source, &candidate.second)?;
    let rules = index_rules(source);
    let first_index = rules
        .iter()
        .position(|rule| rule.selector_start == first.selector_start)
        .ok_or_else(|| CommandError::Validation {
            field: "css".into(),
            reason: "the consolidation proposal is stale".into(),
        })?;
    if rules.get(first_index + 1).map(|rule| rule.selector_start) != Some(second.selector_start) {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the rules are no longer adjacent — review the stylesheet again".into(),
        });
    }
    let (before, after) =
        consolidation_parts(source, &first, &second).ok_or_else(|| CommandError::Validation {
            field: "css".into(),
            reason: "these rules no longer meet the safe consolidation boundary".into(),
        })?;
    if before != candidate.before || after != candidate.after {
        return Err(CommandError::Validation {
            field: "css".into(),
            reason: "the proposed diff changed — review the stylesheet again".into(),
        });
    }
    Ok(replace_span(
        source,
        first.selector_start,
        second.block_inner_end + 1,
        &after,
    ))
}
