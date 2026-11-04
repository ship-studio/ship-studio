//! An agent's memory as items you can see and edit.
//!
//! Memory is the `## Memory` section of the agent's CLAUDE.md, which the
//! agent itself maintains in free markdown. It is read here as entries, one
//! per top-level list item or paragraph, grouped under any `###` heading
//! inside the section (imported memory sits under `### Imported from …`).
//!
//! Writing never re-renders the section. Each entry knows the exact lines it
//! came from, and a change splices only those lines, so everything else (the
//! instructions above, odd formatting, code fences, comments, the agent's
//! own conventions) is left byte for byte as it was. A change names the
//! entry by its position *and* its text as the user saw it: if the agent
//! rewrote its memory in the meantime, the change is refused rather than
//! landing on the wrong line.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

use super::store;
use crate::errors::CommandError;

pub const HEADING: &str = "## Memory";
/// The line a new agent's memory section starts with: a preamble, not an entry.
pub const INTRO: &str =
    "Things worth remembering between conversations. Keep this short and current.";
/// Longer than any fact worth keeping; a guard against pasting a document.
const MAX_ENTRY_CHARS: usize = 2000;

/// Serialises our own read-modify-write of CLAUDE.md files.
static WRITE: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The entry as you'd read it: a list item without its marker, with its
    /// continuation lines dedented; a paragraph as written.
    pub text: String,
    /// The `###` heading it sits under, if any ("Imported from Grok Bot").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub entries: Vec<Entry>,
    /// The exact lines a delete removed, so Undo can put them back as they were.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Change {
    /// A new entry. Placed after `after` (an entry's text), else before
    /// `before`, else at the end of its group. `raw` puts back lines a delete
    /// removed, verbatim.
    #[serde(rename_all = "camelCase")]
    Add {
        text: String,
        #[serde(default)]
        group: Option<String>,
        #[serde(default)]
        after: Option<String>,
        #[serde(default)]
        before: Option<String>,
        #[serde(default)]
        raw: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Edit {
        index: usize,
        original: String,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Delete { index: usize, original: String },
}

/* ---------------------------------------------------------------- parse */

/// A list marker at the start of an entry: its indent and bullet ("- ", "1. ").
#[derive(Debug, Clone, PartialEq)]
struct Marker {
    indent: String,
    bullet: String,
}

impl Marker {
    fn width(&self) -> usize {
        self.indent.len() + self.bullet.len()
    }
}

#[derive(Debug, Clone)]
struct Block {
    /// Byte range in the whole file, whole lines, trailing newline included.
    start: usize,
    end: usize,
    entry: Entry,
    marker: Option<Marker>,
}

#[derive(Debug, Clone, Copy)]
struct Line<'a> {
    start: usize,
    /// After the line's newline (or the end of the file).
    end: usize,
    text: &'a str,
}

fn lines_of(raw: &str) -> Vec<Line<'_>> {
    let mut out = Vec::new();
    let mut at = 0;
    for piece in raw.split_inclusive('\n') {
        let end = at + piece.len();
        let text = piece.trim_end_matches('\n').trim_end_matches('\r');
        out.push(Line {
            start: at,
            end,
            text,
        });
        at = end;
    }
    out
}

/// Byte offset of the `## Memory` heading line, if the file has one. A whole
/// line, so "### Memory notes" in the instructions isn't mistaken for it.
pub fn section_start(raw: &str) -> Option<usize> {
    let mut in_fence = false;
    for line in lines_of(raw) {
        if fence(line.text).is_some() {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence && line.text.trim_end() == HEADING {
            return Some(line.start);
        }
    }
    None
}

fn blank(s: &str) -> bool {
    s.trim().is_empty()
}

fn indented(s: &str) -> bool {
    s.starts_with(' ') || s.starts_with('\t')
}

/// "### Imported from Grok Bot" → "Imported from Grok Bot". At most three
/// spaces in, as in CommonMark.
fn heading(s: &str) -> Option<String> {
    let lead = s.len() - s.trim_start_matches(' ').len();
    if lead > 3 {
        return None;
    }
    let t = s.trim_start();
    let hashes = t.len() - t.trim_start_matches('#').len();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &t[hashes..];
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    Some(rest.trim().trim_end_matches('#').trim().to_string())
}

/// "```" or "~~~" opening (or closing) a fence.
fn fence(s: &str) -> Option<&'static str> {
    let t = s.trim_start();
    if s.len() - t.len() > 3 {
        return None;
    }
    if t.starts_with("```") {
        Some("```")
    } else if t.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

/// A thematic break ("---", "* * *"): a separator, not an entry.
fn rule(s: &str) -> bool {
    let t: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    t.len() >= 3
        && ["-", "*", "_"]
            .iter()
            .any(|c| t.chars().all(|x| x.to_string() == *c))
}

/// A top-level list item's marker: "- ", "* ", "+ ", "1. ", "2) ".
fn list_marker(s: &str) -> Option<Marker> {
    let lead = s.len() - s.trim_start_matches(' ').len();
    if lead > 3 || rule(s) {
        return None;
    }
    let t = &s[lead..];
    let bullet_len = if t.starts_with(['-', '*', '+']) {
        1
    } else {
        let digits = t.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || digits > 9 || !t[digits..].starts_with(['.', ')']) {
            return None;
        }
        digits + 1
    };
    let after = &t[bullet_len..];
    // "-x" or "**bold**" isn't an item; "-" alone is an empty one.
    let space = after.len() - after.trim_start_matches([' ', '\t']).len();
    if space == 0 && !after.is_empty() {
        return None;
    }
    let space = if after.trim().is_empty() {
        space
    } else {
        space.min(4)
    };
    Some(Marker {
        indent: s[..lead].to_string(),
        bullet: t[..bullet_len + space].to_string(),
    })
}

/// Every entry in the memory section, in order, with where it lives.
fn parse(raw: &str) -> Vec<Block> {
    let Some(start) = section_start(raw) else {
        return Vec::new();
    };
    let lines: Vec<Line> = lines_of(raw)
        .into_iter()
        .filter(|l| l.start > start)
        .collect();
    let mut blocks = Vec::new();
    let mut group: Option<String> = None;
    let mut seen_entry = false;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if blank(line.text) || rule(line.text) {
            i += 1;
            continue;
        }
        if let Some(title) = heading(line.text) {
            group = Some(title);
            i += 1;
            continue;
        }
        if !seen_entry && group.is_none() && line.text.trim() == INTRO {
            i += 1;
            continue;
        }
        seen_entry = true;
        let first = i;
        let mut texts: Vec<String> = Vec::new();
        let marker = list_marker(line.text);
        if let Some(m) = &marker {
            texts.push(line.text[m.width().min(line.text.len())..].to_string());
            i += 1;
            let mut in_fence = false;
            while i < lines.len() {
                let l = lines[i];
                if in_fence {
                    texts.push(dedent(l.text, m.width()));
                    if fence(l.text).is_some() {
                        in_fence = false;
                    }
                    i += 1;
                    continue;
                }
                if blank(l.text) {
                    // A blank line continues the item only if what follows is indented.
                    let next = (i + 1..lines.len()).find(|&j| !blank(lines[j].text));
                    match next {
                        Some(j) if indented(lines[j].text) => {
                            for _ in i..j {
                                texts.push(String::new());
                            }
                            i = j;
                            continue;
                        }
                        _ => break,
                    }
                }
                if indented(l.text) && list_marker(l.text).is_none_or(|n| n.indent.len() >= 2) {
                    if fence(l.text.trim_start()).is_some() && l.text.trim_start().len() >= 3 {
                        in_fence = true;
                    }
                    texts.push(dedent(l.text, m.width()));
                    i += 1;
                    continue;
                }
                if heading(l.text).is_some()
                    || list_marker(l.text).is_some()
                    || fence(l.text).is_some()
                    || rule(l.text)
                {
                    break;
                }
                // Lazy continuation: an unindented line straight after.
                texts.push(l.text.to_string());
                i += 1;
            }
        } else if let Some(open) = fence(line.text) {
            texts.push(line.text.to_string());
            i += 1;
            while i < lines.len() {
                let l = lines[i];
                texts.push(l.text.to_string());
                i += 1;
                if l.text.trim_start().starts_with(open) {
                    break;
                }
            }
        } else {
            while i < lines.len() {
                let l = lines[i];
                if blank(l.text)
                    || rule(l.text)
                    || (i > first
                        && (heading(l.text).is_some()
                            || list_marker(l.text).is_some()
                            || fence(l.text).is_some()))
                {
                    break;
                }
                texts.push(l.text.to_string());
                i += 1;
            }
        }
        while texts.last().is_some_and(|t| t.is_empty()) {
            texts.pop();
        }
        blocks.push(Block {
            start: lines[first].start,
            end: lines[i - 1].end,
            entry: Entry {
                text: texts.join("\n").trim_end().to_string(),
                group: group.clone(),
            },
            marker,
        });
    }
    blocks
}

/// Up to `width` leading spaces off a continuation line (a tab counts as one).
fn dedent(s: &str, width: usize) -> String {
    let lead = s
        .chars()
        .take(width)
        .take_while(|c| *c == ' ' || *c == '\t')
        .count();
    s[lead..].to_string()
}

pub fn entries(raw: &str) -> Vec<Entry> {
    parse(raw).into_iter().map(|b| b.entry).collect()
}

/* ---------------------------------------------------------------- write */

fn newline_of(raw: &str) -> &'static str {
    if raw.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// Text typed in the editor: trimmed, no blank lines (one would split it).
fn clean(text: &str) -> Result<String, CommandError> {
    let lines: Vec<&str> = text
        .trim()
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .collect();
    let text = lines.join("\n");
    if text.is_empty() {
        return Err(CommandError::expected("Write something to remember."));
    }
    if text.chars().count() > MAX_ENTRY_CHARS {
        return Err(CommandError::expected(
            "That's long for one memory. Keep it to a fact or two.",
        ));
    }
    if text.lines().any(|l| l.trim_end() == HEADING) {
        return Err(CommandError::expected(
            "A memory can't contain the “## Memory” heading itself.",
        ));
    }
    Ok(text)
}

/// An entry's lines, as a list item with `marker` or a paragraph.
fn render(text: &str, marker: Option<&Marker>, nl: &str) -> String {
    let mut out = String::new();
    for (i, line) in text.lines().enumerate() {
        match marker {
            Some(m) if i == 0 => {
                out.push_str(&m.indent);
                out.push_str(&m.bullet);
                if !m.bullet.ends_with([' ', '\t']) {
                    out.push(' ');
                }
            }
            Some(m) if !line.is_empty() => out.push_str(&" ".repeat(m.width())),
            _ => {}
        }
        out.push_str(line);
        out.push_str(nl);
    }
    out
}

fn stale() -> CommandError {
    CommandError::expected(
        "That memory changed since you opened it (the agent may have just updated it). It's shown as it is now.",
    )
}

/// The block the user meant: at `index` if its text still matches, else the
/// only… first one with that text. Never a guess at a changed entry.
fn locate<'a>(blocks: &'a [Block], index: usize, original: &str) -> Option<&'a Block> {
    blocks
        .get(index)
        .filter(|b| b.entry.text == original)
        .or_else(|| blocks.iter().find(|b| b.entry.text == original))
}

/// `raw` with `change` applied, and the lines a delete removed.
pub fn apply(raw: &str, change: &Change) -> Result<(String, Option<String>), CommandError> {
    let nl = newline_of(raw);
    let blocks = parse(raw);
    match change {
        Change::Edit {
            index,
            original,
            text,
        } => {
            let block = locate(&blocks, *index, original).ok_or_else(stale)?;
            // Nothing changed, nothing written: its lines stay exactly as they were.
            if text.trim() == block.entry.text.trim() {
                return Ok((raw.to_string(), None));
            }
            let text = clean(text)?;
            let mut out = raw.to_string();
            out.replace_range(
                block.start..block.end,
                &render(&text, block.marker.as_ref(), nl),
            );
            Ok((out, None))
        }
        Change::Delete { index, original } => {
            let block = locate(&blocks, *index, original).ok_or_else(stale)?;
            let removed = raw[block.start..block.end].to_string();
            let mut out = raw.to_string();
            out.replace_range(block.start..block.end, "");
            // Don't leave two blank lines where one entry was.
            let double = format!("{nl}{nl}");
            let blank_before = block.start == 0 || out[..block.start].ends_with(&double);
            if blank_before && out[block.start..].starts_with(nl) {
                out.replace_range(block.start..block.start + nl.len(), "");
            } else if out.len() == block.start && out.ends_with(&double) {
                out.truncate(block.start - nl.len());
            }
            Ok((out, Some(removed)))
        }
        Change::Add {
            text,
            group,
            after,
            before,
            raw: verbatim,
        } => {
            let mut out = raw.to_string();
            if section_start(&out).is_none() {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push_str(nl);
                }
                if !out.is_empty() {
                    out.push_str(nl);
                }
                out.push_str(HEADING);
                out.push_str(nl);
                out.push_str(nl);
            }
            let blocks = parse(&out);
            let in_group = |b: &&Block| b.entry.group == *group;
            let anchor_after = after
                .as_deref()
                .and_then(|t| blocks.iter().filter(in_group).find(|b| b.entry.text == t));
            let anchor_before = before
                .as_deref()
                .and_then(|t| blocks.iter().filter(in_group).find(|b| b.entry.text == t));
            let last = blocks.iter().rev().find(in_group);
            let (at, marker) = if let Some(b) = anchor_after {
                (b.end, b.marker.clone())
            } else if let Some(b) = anchor_before {
                (b.start, b.marker.clone())
            } else if let Some(b) = last {
                (b.end, b.marker.clone())
            } else {
                (group_start(&mut out, group.as_deref(), nl), None)
            };
            // Same bullet as its neighbour, unless that's numbered.
            let marker = marker
                .filter(|m| m.bullet.starts_with(['-', '*', '+']))
                .map(|m| Marker {
                    indent: m.indent,
                    bullet: format!("{} ", &m.bullet[..1]),
                })
                .unwrap_or(Marker {
                    indent: String::new(),
                    bullet: "- ".to_string(),
                });
            let mut lines = match verbatim {
                Some(lines) if !lines.trim().is_empty() => {
                    clean(lines)?;
                    lines.clone()
                }
                _ => render(&clean(text)?, Some(&marker), nl),
            };
            if !lines.ends_with('\n') {
                lines.push_str(nl);
            }
            if at > 0 && !out[..at].ends_with('\n') {
                lines.insert_str(0, nl);
            }
            out.insert_str(at, &lines);
            Ok((out, None))
        }
    }
}

/// Where a new entry goes in a group with none yet: under its heading (made
/// if missing, at the end); for no group, after the preamble and before the
/// first heading.
fn group_start(out: &mut String, group: Option<&str>, nl: &str) -> usize {
    let start = section_start(out).unwrap_or(0);
    let lines: Vec<(usize, usize, String)> = lines_of(out)
        .into_iter()
        .filter(|l| l.start > start)
        .map(|l| (l.start, l.end, l.text.to_string()))
        .collect();
    match group {
        None => {
            let first_heading = lines.iter().find(|(_, _, t)| heading(t).is_some());
            match first_heading {
                Some((at, _, _)) => {
                    // Before the heading, and before the blank line above it.
                    let mut at = *at;
                    while at >= start && out[..at].ends_with(&format!("{nl}{nl}")) {
                        at -= nl.len();
                    }
                    if !out[..at].ends_with(&format!("{nl}{nl}")) {
                        out.insert_str(at, nl);
                        at += nl.len();
                    }
                    at
                }
                None => {
                    if !out.ends_with('\n') {
                        out.push_str(nl);
                    }
                    if !out.ends_with(&format!("{nl}{nl}")) {
                        out.push_str(nl);
                    }
                    out.len()
                }
            }
        }
        Some(name) => {
            let found = lines
                .iter()
                .find(|(_, _, t)| heading(t).as_deref() == Some(name));
            match found {
                Some((_, end, _)) => {
                    let mut at = *end;
                    if !out[..at].ends_with('\n') {
                        out.insert_str(at, nl);
                        at += nl.len();
                    }
                    out.insert_str(at, nl);
                    at + nl.len()
                }
                None => {
                    if !out.ends_with('\n') {
                        out.push_str(nl);
                    }
                    out.push_str(nl);
                    out.push_str(&format!("### {name}{nl}{nl}"));
                    out.len()
                }
            }
        }
    }
}

/* ------------------------------------------------------------- on disk */

fn path(agent_id: &str) -> Result<std::path::PathBuf, CommandError> {
    Ok(store::agent_home(agent_id)?.join("CLAUDE.md"))
}

fn read_file(path: &Path) -> Result<String, CommandError> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(super::err_io(e)),
    }
}

pub fn read(agent_id: &str) -> Result<View, CommandError> {
    store::get(agent_id)?;
    Ok(View {
        entries: entries(&read_file(&path(agent_id)?)?),
        removed: None,
    })
}

pub fn change(agent_id: &str, change: &Change) -> Result<View, CommandError> {
    store::get(agent_id)?;
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let path = path(agent_id)?;
    let raw = read_file(&path)?;
    let (next, removed) = apply(&raw, change)?;
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, next.as_bytes()).map_err(super::err_io)?;
    std::fs::rename(&tmp, &path).map_err(super::err_io)?;
    Ok(View {
        entries: entries(&next),
        removed,
    })
}

/* ------------------------------------------------------ "Remember this" */

/// The fact a message is worth remembering as, in one line: Claude Code on
/// Haiku summarises it; if that can't run, the message's opening, as is.
pub async fn suggest(text: &str) -> String {
    match summarise(text).await {
        Some(line) => line,
        None => excerpt(text),
    }
}

/// The message's first sentence or two, without markdown, at most ~200 chars.
pub fn excerpt(text: &str) -> String {
    let plain: String = text
        .lines()
        .map(|l| {
            l.trim()
                .trim_start_matches(['#', '>', '-', '*', '+'])
                .trim()
        })
        .filter(|l| !l.is_empty() && !l.starts_with("```"))
        .collect::<Vec<_>>()
        .join(" ")
        .replace("**", "")
        .replace('`', "");
    let mut out = String::new();
    for sentence in plain.split_inclusive(['.', '!', '?']) {
        if !out.is_empty() && out.chars().count() + sentence.chars().count() > 200 {
            break;
        }
        out.push_str(sentence);
    }
    let out = out.trim();
    if out.chars().count() > 200 {
        out.chars()
            .take(199)
            .collect::<String>()
            .trim_end()
            .to_string()
            + "…"
    } else {
        out.to_string()
    }
}

const SUMMARY_PROMPT: &str = "Turn the message below into ONE short line worth keeping in an assistant's long-term memory: a durable fact, preference, standing rule, or who/where something is. Write it as a plain statement, under 25 words, no preamble, no quotes, no bullet. If nothing in it is worth remembering, write the single most useful fact anyway.\n\nMessage:\n";

async fn summarise(text: &str) -> Option<String> {
    let binary = tokio::task::spawn_blocking(|| {
        crate::commands::claude::find_validated_binary("claude", "--version")
    })
    .await
    .ok()
    .flatten()?;
    let message: String = text.chars().take(6000).collect();
    let mut cmd = crate::utils::create_command(&binary);
    cmd.args([
        "--print",
        "--model",
        "haiku",
        "--output-format",
        "text",
        // No connectors to start; nothing to call.
        "--strict-mcp-config",
        "--tools",
        "",
        "--no-session-persistence",
    ]);
    super::runner::strip_session_env(&mut cmd);
    cmd.env("PATH", crate::utils::get_extended_path())
        .current_dir(std::env::temp_dir());
    let output = crate::external_command::run_with_timeout_stdin(
        tokio::process::Command::from(cmd),
        &format!("{SUMMARY_PROMPT}{message}"),
        "Claude Code (memory summary)",
        45,
    )
    .await
    .ok()?;
    if !output.status.success() {
        tracing::debug!(
            "[Agents] memory summary failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())?
        .trim_start_matches(['-', '*', '•'])
        .trim()
        .trim_matches('"')
        .to_string();
    (!line.is_empty()).then_some(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "# Finance\n\nKeeps the books.\n\n## Instructions\n\nBe brief.\n\n## Memory\n\nThings worth remembering between conversations. Keep this short and current.\n\n- Julian's accountant is Sam.\n- Invoices go out on the 1st,\n  never on weekends.\n* Prefers EUR\n\n### Imported from Grok Bot\n\n- Lives in Lisbon\n- Mornings for focus\n";

    fn texts(raw: &str) -> Vec<(String, Option<String>)> {
        entries(raw)
            .into_iter()
            .map(|e| (e.text, e.group))
            .collect()
    }

    fn edit(raw: &str, index: usize, original: &str, text: &str) -> String {
        apply(
            raw,
            &Change::Edit {
                index,
                original: original.into(),
                text: text.into(),
            },
        )
        .unwrap()
        .0
    }

    fn add(raw: &str, text: &str, group: Option<&str>) -> String {
        apply(
            raw,
            &Change::Add {
                text: text.into(),
                group: group.map(str::to_string),
                after: None,
                before: None,
                raw: None,
            },
        )
        .unwrap()
        .0
    }

    #[test]
    fn reads_items_and_groups_and_skips_the_preamble() {
        let imported = Some("Imported from Grok Bot".to_string());
        assert_eq!(
            texts(FILE),
            vec![
                ("Julian's accountant is Sam.".into(), None),
                (
                    "Invoices go out on the 1st,\nnever on weekends.".into(),
                    None
                ),
                ("Prefers EUR".into(), None),
                ("Lives in Lisbon".into(), imported.clone()),
                ("Mornings for focus".into(), imported),
            ]
        );
    }

    #[test]
    fn the_instructions_are_never_read_as_memory() {
        let raw = "# A\n\n## Instructions\n\n- Always cc Sam\n### Memory notes\n\n## Memory\n\n- Real one\n";
        assert_eq!(texts(raw), vec![("Real one".into(), None)]);
        assert!(entries("# A\n\n## Instructions\n\n- Not memory\n").is_empty());
        // A heading inside a code fence above isn't the section.
        let fenced = "# A\n\n```\n## Memory\n- fake\n```\n";
        assert!(entries(fenced).is_empty());
    }

    /// Editing entry `i` changes that entry and nothing else: every byte
    /// before and after its lines is as it was, and every other entry reads
    /// the same.
    fn check_isolated(raw: &str, i: usize) {
        let before = entries(raw);
        let block = parse(raw).remove(i);
        let after = edit(raw, i, &before[i].text, "Changed\nover two lines");
        assert!(
            after.starts_with(&raw[..block.start]),
            "{raw:?} prefix, entry {i}"
        );
        assert!(
            after.ends_with(&raw[block.end..]),
            "{raw:?} suffix, entry {i}"
        );
        let now = entries(&after);
        assert_eq!(now.len(), before.len(), "{raw:?} count, entry {i}");
        for (j, e) in now.iter().enumerate() {
            if j == i {
                assert_eq!(e.text, "Changed\nover two lines", "{raw:?} entry {i}");
                assert_eq!(e.group, before[i].group);
            } else {
                assert_eq!(e, &before[j], "{raw:?} entry {j} after editing {i}");
            }
        }
        // And back: the same words, the same entries.
        let back = edit(&after, i, "Changed\nover two lines", &before[i].text);
        assert_eq!(entries(&back)[i].text, before[i].text.replace("\n\n", "\n"));
    }

    #[test]
    fn an_unchanged_write_is_byte_for_byte() {
        for (i, e) in entries(FILE).iter().enumerate() {
            assert_eq!(edit(FILE, i, &e.text, &e.text), FILE, "entry {i}");
            check_isolated(FILE, i);
            // Changed and changed back, a plain entry is exactly as it was.
            let there = edit(FILE, i, &e.text, "Something else");
            assert_eq!(
                edit(&there, i, "Something else", &e.text),
                FILE,
                "entry {i}"
            );
        }
    }

    #[test]
    fn editing_touches_only_that_entry() {
        let after = edit(
            FILE,
            0,
            "Julian's accountant is Sam.",
            "Julian's accountant is Priya.",
        );
        assert_eq!(
            after,
            FILE.replace(
                "Julian's accountant is Sam.",
                "Julian's accountant is Priya."
            )
        );
        // A multi-line item keeps its marker and indents its continuation.
        let after = edit(
            FILE,
            1,
            "Invoices go out on the 1st,\nnever on weekends.",
            "Invoices go out on the 2nd,\nstill never on weekends.",
        );
        assert!(after
            .contains("- Invoices go out on the 2nd,\n  still never on weekends.\n* Prefers EUR"));
        // Its own bullet is kept.
        let after = edit(FILE, 2, "Prefers EUR", "Prefers GBP");
        assert!(after.contains("\n* Prefers GBP\n"));
        assert!(after.starts_with(
            "# Finance\n\nKeeps the books.\n\n## Instructions\n\nBe brief.\n\n## Memory\n"
        ));
    }

    #[test]
    fn a_changed_entry_refuses_rather_than_guess() {
        let err = apply(
            FILE,
            &Change::Edit {
                index: 0,
                original: "Something the agent since rewrote".into(),
                text: "x".into(),
            },
        );
        assert!(err.is_err());
        // Moved but unchanged: found by its words.
        let moved =
            FILE.replace("- Julian's accountant is Sam.\n", "") + "- Julian's accountant is Sam.\n";
        let after = edit(&moved, 0, "Julian's accountant is Sam.", "Sam left.");
        assert!(after.ends_with("- Sam left.\n"));
    }

    #[test]
    fn deleting_then_undoing_restores_the_file() {
        for (i, e) in entries(FILE).iter().enumerate() {
            let (after, removed) = apply(
                FILE,
                &Change::Delete {
                    index: i,
                    original: e.text.clone(),
                },
            )
            .unwrap();
            assert!(!entries(&after).iter().any(|x| x.text == e.text));
            let list = entries(FILE);
            let undo = Change::Add {
                text: e.text.clone(),
                group: e.group.clone(),
                after: i
                    .checked_sub(1)
                    .and_then(|p| list.get(p))
                    .filter(|p| p.group == e.group)
                    .map(|p| p.text.clone()),
                before: list
                    .get(i + 1)
                    .filter(|n| n.group == e.group)
                    .map(|n| n.text.clone()),
                raw: removed,
            };
            assert_eq!(apply(&after, &undo).unwrap().0, FILE, "entry {i}");
        }
    }

    #[test]
    fn deleting_the_last_entry_leaves_no_double_blank() {
        let raw = "## Memory\n\n- One\n\n- Two\n";
        let (after, _) = apply(
            raw,
            &Change::Delete {
                index: 1,
                original: "Two".into(),
            },
        )
        .unwrap();
        assert_eq!(after, "## Memory\n\n- One\n");
        let (after, _) = apply(
            raw,
            &Change::Delete {
                index: 0,
                original: "One".into(),
            },
        )
        .unwrap();
        assert_eq!(after, "## Memory\n\n- Two\n");
    }

    #[test]
    fn adding_lands_in_its_group() {
        let after = add(FILE, "Pays by card", None);
        assert!(after.contains("* Prefers EUR\n* Pays by card\n\n### Imported from Grok Bot"));
        let after = add(FILE, "Has a cat", Some("Imported from Grok Bot"));
        assert!(after.ends_with("- Mornings for focus\n- Has a cat\n"));
        // A fresh agent's section: after the preamble.
        let fresh = "# A\n\n## Memory\n\nThings worth remembering between conversations. Keep this short and current.\n";
        assert_eq!(
            add(fresh, "First fact", None),
            format!("{fresh}\n- First fact\n")
        );
        // No section at all: one is made.
        assert_eq!(
            add("# A\n\nHello.", "Fact", None),
            "# A\n\nHello.\n\n## Memory\n\n- Fact\n"
        );
        // Only imported memory: the new one goes above it.
        let only = "## Memory\n\n### Imported from Grok Bot\n\n- Lisbon\n";
        let after = add(only, "Mine", None);
        assert_eq!(texts(&after)[0], ("Mine".into(), None));
        assert!(after.contains("## Memory\n\n- Mine\n\n### Imported from Grok Bot"));
    }

    #[test]
    fn odd_markdown_round_trips() {
        let odd = [
            // CRLF
            "## Memory\r\n\r\n- One\r\n- Two\r\n",
            // No trailing newline
            "## Memory\n\n- One\n- Two",
            // Numbered, with ) and nested items
            "## Memory\n\n1. First\n   - nested a\n   - nested b\n2) Second\n",
            // Loose list, paragraphs, a fence, an HTML comment, tabs
            "## Memory\n\n- Loose one\n\n  continued after a blank\n\nA plain paragraph\nover two lines.\n\n```\n- not an item\n## not a heading\n```\n\n<!-- kept -->\n-\tTabbed\n",
            // Lazy continuation and a thematic break
            "## Memory\n\n- Starts here\nand carries on\n\n---\n\n- After the rule\n",
            // Empty section, and a heading with closing hashes
            "## Memory\n\n## Memory\n\n### Group ###\n- In it\n",
        ];
        for raw in odd {
            let list = entries(raw);
            for (i, e) in list.iter().enumerate() {
                assert_eq!(edit(raw, i, &e.text, &e.text), raw, "{raw:?} entry {i}");
                check_isolated(raw, i);
                let (after, removed) = apply(
                    raw,
                    &Change::Delete {
                        index: i,
                        original: e.text.clone(),
                    },
                )
                .unwrap();
                assert!(removed.is_some());
                assert_eq!(entries(&after).len(), list.len() - 1, "{raw:?} delete {i}");
            }
        }
        let fenced = entries(odd[3]);
        assert!(fenced
            .iter()
            .any(|e| e.text.starts_with("```\n- not an item")));
        assert!(!fenced.iter().any(|e| e.text == "not an item"));
        assert_eq!(entries(odd[2])[0].text, "First\n- nested a\n- nested b");
        assert_eq!(entries(odd[4])[0].text, "Starts here\nand carries on");
        assert_eq!(
            entries(odd[4]).len(),
            2,
            "a rule is a separator, not an entry"
        );
        assert_eq!(entries(odd[5])[0].group.as_deref(), Some("Group"));
        // CRLF stays CRLF when edited.
        let after = edit(odd[0], 0, "One", "Uno");
        assert_eq!(after, "## Memory\r\n\r\n- Uno\r\n- Two\r\n");
    }

    #[test]
    fn what_can_be_written_is_checked() {
        let bad = |text: &str| {
            apply(
                FILE,
                &Change::Edit {
                    index: 0,
                    original: "Julian's accountant is Sam.".into(),
                    text: text.into(),
                },
            )
            .is_err()
        };
        assert!(bad("   "));
        assert!(bad(&"x".repeat(MAX_ENTRY_CHARS + 1)));
        assert!(bad("ok\n## Memory\nsneaky"));
        // Blank lines inside an edit would split it into two entries.
        let after = edit(
            FILE,
            0,
            "Julian's accountant is Sam.",
            "Line one\n\n\nLine two",
        );
        assert_eq!(entries(&after)[0].text, "Line one\nLine two");
    }

    #[test]
    fn an_excerpt_is_the_opening_without_markdown() {
        assert_eq!(
            excerpt("**Done.** The invoice is `#42`."),
            "Done. The invoice is #42."
        );
        let long = "A sentence that is fairly long. ".repeat(20);
        assert!(excerpt(&long).chars().count() <= 200);
        assert_eq!(excerpt("# Title\n\n- one\n- two"), "Title one two");
    }
}
