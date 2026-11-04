//! Search across every agent's conversation.
//!
//! A plain scan of each `messages.jsonl`: at the scale one person's agents
//! reach (tens of agents, thousands of lines) reading them is faster than
//! keeping an index honest. Matching is case-insensitive and every word of the
//! query must appear in the message; hits are newest first.

use serde::Serialize;

use super::store::{self, AgentMessage, MessageKind};
use crate::errors::CommandError;

/// Most hits returned. Past this a search is too vague to scroll through.
pub const MAX_HITS: usize = 50;
/// Characters of context kept before the first match in a snippet.
const LEAD: usize = 40;
/// Total snippet length, in characters, before ellipses.
const SNIPPET_LEN: usize = 140;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub agent_id: String,
    pub agent_name: String,
    pub agent_color: String,
    pub message_id: String,
    pub ts: i64,
    pub kind: MessageKind,
    /// The other agent, for agent-to-agent lines.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_name: Option<String>,
    /// The text around the first match, whitespace collapsed, with `…` where cut.
    pub snippet: String,
}

/// The words of a query, lowercased. Empty when there's nothing to search for.
fn terms(query: &str) -> Vec<Vec<char>> {
    query
        .split_whitespace()
        .map(lower_chars)
        .filter(|w| !w.is_empty())
        .collect()
}

/// Lowercase one char to one char, so positions in the lowered text are
/// positions in the original. The few chars that lowercase to several (İ)
/// are kept as they are.
fn lower_char(c: char) -> char {
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

fn lower_chars(s: &str) -> Vec<char> {
    s.chars().map(lower_char).collect()
}

fn find(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// What the user saw, minus the markdown punctuation and line breaks that
/// would make a one-line snippet unreadable.
fn plain(text: &str) -> Vec<char> {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let line = line.trim_start().trim_start_matches('#').trim_start();
        out.push_str(&line.replace("**", "").replace('`', ""));
        out.push(' ');
    }
    let mut chars = Vec::with_capacity(out.len());
    let mut last_space = true;
    for c in out.chars() {
        let space = c.is_whitespace();
        if space && last_space {
            continue;
        }
        chars.push(if space { ' ' } else { c });
        last_space = space;
    }
    while chars.last() == Some(&' ') {
        chars.pop();
    }
    chars
}

/// The searchable text of a message, or `None` for lines that aren't
/// conversation (approval cards, errors).
fn searchable(message: &AgentMessage) -> Option<&str> {
    match message.kind {
        MessageKind::User
        | MessageKind::Agent
        | MessageKind::SentToAgent
        | MessageKind::FromAgent
        // A fired check-in's text is the note it was scheduled with.
        | MessageKind::CheckIn => Some(&message.text),
        MessageKind::Approval | MessageKind::Error | MessageKind::Note => None,
    }
}

/// A snippet around `at` (a char index into `text`), cut on word boundaries
/// where one is close.
fn snippet(text: &[char], at: usize) -> String {
    if text.len() <= SNIPPET_LEN {
        return text.iter().collect();
    }
    let mut start = at.saturating_sub(LEAD);
    // Don't start mid-word if a space is near.
    if start > 0 {
        if let Some(space) = text[start..at].iter().position(|c| *c == ' ') {
            start += space + 1;
        }
    }
    let mut end = (start + SNIPPET_LEN).min(text.len());
    if end < text.len() {
        if let Some(space) = text[start..end].iter().rposition(|c| *c == ' ') {
            if space > (end - start) / 2 {
                end = start + space;
            }
        }
    }
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(text[start..end].iter());
    if end < text.len() {
        out.push('…');
    }
    out
}

/// Whether every term is in the message; if so, the snippet around the
/// earliest one.
fn match_message(message: &AgentMessage, terms: &[Vec<char>]) -> Option<String> {
    let text = plain(searchable(message)?);
    let lowered: Vec<char> = text.iter().copied().map(lower_char).collect();
    let mut first = usize::MAX;
    for term in terms {
        first = first.min(find(&lowered, term)?);
    }
    Some(snippet(&text, first))
}

/// Search the given agents' conversations. Separate from [`search`] so tests
/// can run it over a fixed set.
pub fn search_in(
    agents: &[store::Agent],
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, CommandError> {
    let terms = terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    for agent in agents {
        for message in store::messages(&agent.id, usize::MAX)? {
            if let Some(snippet) = match_message(&message, &terms) {
                hits.push(SearchHit {
                    agent_id: agent.id.clone(),
                    agent_name: agent.name.clone(),
                    agent_color: agent.color.clone(),
                    peer_name: message.peer.as_ref().map(|p| p.name.clone()),
                    message_id: message.id,
                    ts: message.ts,
                    kind: message.kind,
                    snippet,
                });
            }
        }
    }
    // Newest first (a stable sort, so same-millisecond lines keep log order).
    hits.sort_by(|a, b| b.ts.cmp(&a.ts));
    hits.truncate(limit);
    Ok(hits)
}

pub fn search(query: &str) -> Result<Vec<SearchHit>, CommandError> {
    search_in(&store::list()?, query, MAX_HITS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::store::{
        append_message, create, set_root_for_tests, tests_lock, AgentRef, NewAgent,
    };

    fn with_root<F: FnOnce()>(f: F) {
        let _serial = tests_lock();
        let dir = tempfile::tempdir().unwrap();
        set_root_for_tests(Some(dir.path().to_path_buf()));
        f();
        set_root_for_tests(None);
    }

    fn agent(name: &str) -> store::Agent {
        create(NewAgent {
            name: name.into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap()
    }

    fn say(agent: &store::Agent, kind: MessageKind, ts: i64, text: &str) -> String {
        let id = store::new_id();
        append_message(&AgentMessage {
            id: id.clone(),
            agent_id: agent.id.clone(),
            ts,
            kind,
            text: text.into(),
            peer: None,
            approval: None,
            attachments: Vec::new(),
            check_in: None,
            stopped: false,
        })
        .unwrap();
        id
    }

    #[test]
    fn every_word_must_match_in_any_case_and_order() {
        with_root(|| {
            let finance = agent("Finance");
            let hit = say(
                &finance,
                MessageKind::Agent,
                1,
                "Northwind owes $4,200 on the INVOICE.",
            );
            say(&finance, MessageKind::Agent, 2, "Globex paid the invoice.");
            let found = search_in(&store::list().unwrap(), "invoice northwind", 50).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].message_id, hit);
            assert!(search_in(&store::list().unwrap(), "   ", 50)
                .unwrap()
                .is_empty());
        });
    }

    #[test]
    fn newest_first_across_agents_and_capped() {
        with_root(|| {
            let a = agent("Finance");
            let b = agent("Acme Site");
            say(&a, MessageKind::User, 10, "deploy please");
            let newest = say(&b, MessageKind::Agent, 30, "deploy is green");
            say(&a, MessageKind::Agent, 20, "deploy started");
            let all = store::list().unwrap();
            let found = search_in(&all, "deploy", 50).unwrap();
            assert_eq!(
                found.iter().map(|h| h.ts).collect::<Vec<_>>(),
                vec![30, 20, 10]
            );
            assert_eq!(found[0].message_id, newest);
            assert_eq!(found[0].agent_name, "Acme Site");
            assert_eq!(search_in(&all, "deploy", 2).unwrap().len(), 2);
        });
    }

    #[test]
    fn skips_approval_cards_and_errors_and_names_the_peer() {
        with_root(|| {
            let a = agent("Chief");
            say(&a, MessageKind::Error, 1, "deploy failed");
            say(&a, MessageKind::Approval, 2, "deploy");
            append_message(&AgentMessage {
                id: store::new_id(),
                agent_id: a.id.clone(),
                ts: 3,
                kind: MessageKind::SentToAgent,
                text: "Check the deploy".into(),
                peer: Some(AgentRef {
                    id: "x".into(),
                    name: "Acme Site".into(),
                }),
                approval: None,
                attachments: Vec::new(),
                check_in: None,
                stopped: false,
            })
            .unwrap();
            let found = search_in(&store::list().unwrap(), "deploy", 50).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].peer_name.as_deref(), Some("Acme Site"));
        });
    }

    #[test]
    fn short_messages_are_the_whole_snippet_without_markdown() {
        let text = plain("## Done\n\nThe **pricing** table uses `grid`.\n");
        assert_eq!(
            text.iter().collect::<String>(),
            "Done The pricing table uses grid."
        );
    }

    #[test]
    fn long_messages_are_cut_around_the_first_match_on_word_boundaries() {
        let before = "alpha ".repeat(30);
        let after = " omega".repeat(30);
        let text: Vec<char> = format!("{before}needle{after}").chars().collect();
        let at = find(
            &lower_chars(&text.iter().collect::<String>()),
            &lower_chars("needle"),
        )
        .unwrap();
        let s = snippet(&text, at);
        assert!(s.starts_with('…') && s.ends_with('…'), "{s}");
        assert!(s.contains("needle"));
        // Cut between words, not through them.
        assert!(s.starts_with("…alpha"), "{s}");
        assert!(s.trim_end_matches('…').ends_with("omega"), "{s}");
        assert!(s.chars().count() <= SNIPPET_LEN + 2);
        // The match sits near the front, with some lead-in.
        let pos = s.find("needle").unwrap();
        assert!(pos > 10 && pos <= LEAD + 4, "{pos}");
    }

    #[test]
    fn a_match_at_the_very_start_has_no_leading_ellipsis() {
        let text: Vec<char> = format!("needle {}", "word ".repeat(60)).chars().collect();
        let s = snippet(&text, 0);
        assert!(s.starts_with("needle"));
        assert!(s.ends_with('…'));
    }

    #[test]
    fn matching_handles_non_ascii_case() {
        let message = AgentMessage {
            id: "m".into(),
            agent_id: "a".into(),
            ts: 0,
            kind: MessageKind::User,
            text: "Rechnung für MÜLLER".into(),
            peer: None,
            approval: None,
            attachments: Vec::new(),
            check_in: None,
            stopped: false,
        };
        assert!(match_message(&message, &terms("müller")).is_some());
        assert!(match_message(&message, &terms("müller schmidt")).is_none());
    }
}
