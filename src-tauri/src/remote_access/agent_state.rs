//! What an agent tab is doing, read off its rendered screen.
//!
//! The assistant on the phone needs one of four answers — still working,
//! waiting on a decision, finished, or gone — plus the agent's own words, not
//! a raw terminal dump it then has to interpret. Timing alone ("quiet for
//! 5 s") can't tell a finished agent from one blocked on a permission prompt,
//! which is exactly the difference that decides what the assistant does next.
//!
//! Everything here is a pure function over rendered lines (see `screen.rs`),
//! so the heuristics are unit-tested against the shapes the agent CLIs draw.

/// A tab counts as quiet — the agent has probably finished its turn or is
/// waiting on the user — after this long with no output.
pub const QUIET_MS: u64 = 5_000;

/// A choice that has been on screen, unchanged, for this long is settled
/// enough to report; a menu redraws once and then sits still.
pub const CHOICE_SETTLE_MS: u64 = 1_500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentState {
    /// Printing, or showing its "esc to interrupt" footer. `activity` is the
    /// agent's own status line ("✻ Editing Header.tsx…") when there is one.
    Working { activity: Option<String> },
    /// A permission prompt, menu or y/n question is waiting on the user.
    NeedsDecision {
        question: String,
        options: Vec<String>,
    },
    /// Quiet, nothing being asked: done with its turn, ready for a message.
    Finished,
    /// The agent process has ended.
    Exited,
}

impl AgentState {
    /// The one word the assistant branches on.
    pub fn keyword(&self) -> &'static str {
        match self {
            AgentState::Working { .. } => "working",
            AgentState::NeedsDecision { .. } => "needs_decision",
            AgentState::Finished => "finished",
            AgentState::Exited => "exited",
        }
    }
}

/// Classify a tab from its screen and how long it has been quiet.
pub fn classify(lines: &[String], alive: bool, quiet_for_ms: u64) -> AgentState {
    if !alive {
        return AgentState::Exited;
    }
    let busy = shows_interrupt_hint(lines);
    let activity = spinner_line(lines);
    // "esc to interrupt" means a turn is in progress even if the screen
    // happens to have held still for a few seconds.
    if busy || quiet_for_ms < QUIET_MS {
        if let Some((question, options)) = awaiting_choice_detail(lines) {
            if quiet_for_ms >= CHOICE_SETTLE_MS {
                return AgentState::NeedsDecision { question, options };
            }
        }
        return AgentState::Working {
            activity: activity.map(|l| tidy_activity(&l)),
        };
    }
    if let Some((question, options)) = awaiting_choice_detail(lines) {
        return AgentState::NeedsDecision { question, options };
    }
    AgentState::Finished
}

/// The bottom lines that matter: the last few non-empty ones.
fn tail(lines: &[String], n: usize) -> Vec<&str> {
    let mut t: Vec<&str> = lines
        .iter()
        .rev()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .take(n)
        .collect();
    t.reverse();
    t
}

/// Agents only offer "esc to interrupt" while a turn is running. Claude Code
/// prints it in the footer under its input box; Codex on its status line.
fn shows_interrupt_hint(lines: &[String]) -> bool {
    tail(lines, 10).into_iter().any(|l| {
        let lower = l.to_lowercase();
        lower.contains("esc to interrupt") || lower.contains("esc interrupt")
    })
}

/// A spinner or status line: a glyph, then the agent's word for what it's
/// doing, with an ellipsis or an elapsed time. Claude Code:
/// "✢ Stewing… (4s · ↓ 149 tokens)", and once done "✻ Cogitated for 4s ·
/// done 8:30 PM". Codex: "• Working (5s • esc to interrupt)".
fn is_status_line(line: &str) -> bool {
    let t = line.trim();
    let Some(first) = t.chars().next() else {
        return false;
    };
    if first.is_alphanumeric()
        || POINTERS.contains(&first)
        || matches!(first, '⏺' | '⎿' | '│' | '⚠')
    {
        return false;
    }
    let rest = t[first.len_utf8()..].trim_start();
    if !rest.chars().next().is_some_and(char::is_alphabetic) {
        return false;
    }
    let timed = rest.find('(').is_some_and(|i| {
        let inside = &rest[i + 1..];
        let digits = inside.chars().take_while(char::is_ascii_digit).count();
        digits > 0 && inside[digits..].starts_with(['s', 'm'])
    });
    rest.contains('…') || timed || rest.contains("· done")
}

/// The spinner line of a turn in progress, if one is on screen. It sits
/// above the input box; below it are footers and warnings, not activity.
fn spinner_line(lines: &[String]) -> Option<String> {
    tail(without_chrome(lines), 12)
        .into_iter()
        .rev()
        .find(|l| is_status_line(l) && !l.contains("· done"))
        .map(str::to_string)
}

/// "✻ Editing Header.tsx… (12s · ↑ 1.2k tokens · esc to interrupt)" →
/// "Editing Header.tsx… (12s)". The status is for a person, not a terminal.
fn tidy_activity(line: &str) -> String {
    let body = line
        .trim_start_matches(|c: char| !c.is_alphanumeric())
        .trim();
    let Some(open) = body.find('(') else {
        return body.to_string();
    };
    let (head, rest) = body.split_at(open);
    let elapsed = rest
        .trim_start_matches('(')
        .split(['·', '•', ')'])
        .next()
        .map(str::trim)
        .filter(|s| s.chars().next().is_some_and(|c| c.is_ascii_digit()));
    match elapsed {
        Some(e) => format!("{} ({e})", head.trim()),
        None => head.trim().to_string(),
    }
}

const POINTERS: [char; 5] = ['❯', '>', '›', '▶', '→'];

/// The numbered options at the bottom of the screen, with a long option's
/// wrapped second line joined back on ("2. Yes, and always allow access to
/// /…/work" + "  -claude from this project").
fn numbered_options(lines: &[String]) -> Vec<(bool, String)> {
    let mut options: Vec<(bool, String)> = Vec::new();
    let mut open = false;
    for line in &lines[lines.len().saturating_sub(16)..] {
        if let Some(option) = numbered_option(line.trim()) {
            options.push(option);
            open = true;
        } else if open && line.starts_with("    ") && !line.trim().is_empty() {
            if let Some((_, last)) = options.last_mut() {
                last.push(' ');
                last.push_str(line.trim());
            }
        } else {
            open = false;
        }
    }
    options
}

/// "❯ 1. Yes" / "  2. No" → Some((highlighted, "1. Yes")).
fn numbered_option(line: &str) -> Option<(bool, String)> {
    let rest = line.trim_start_matches(POINTERS);
    let highlighted = rest.len() < line.len();
    let rest = rest.trim_start();
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 2 || !rest[digits..].starts_with('.') {
        return None;
    }
    let label = rest[digits + 1..].trim();
    if label.is_empty() {
        return None;
    }
    Some((highlighted, format!("{}. {label}", &rest[..digits])))
}

/// Is the bottom of the screen a choice the agent is waiting on? Returns the
/// question (or a stand-in) when it is.
///
/// Matches the shapes agent CLIs use for permission prompts and menus: a
/// highlighted numbered option ("❯ 1. Yes"), "Do you want to …?", or a y/n
/// prompt. Only the last lines are looked at — earlier screens with old
/// prompts in the scrollback don't count.
#[cfg(test)]
pub fn awaiting_choice(lines: &[String]) -> Option<String> {
    awaiting_choice_detail(lines).map(|(q, _)| q)
}

/// `awaiting_choice`, plus the options on screen.
pub fn awaiting_choice_detail(lines: &[String]) -> Option<(String, Vec<String>)> {
    if let Some(menu) = unnumbered_menu(lines) {
        return Some(menu);
    }
    let tail = tail(lines, 14);
    let numbered = numbered_options(lines);
    let highlighted = numbered.iter().any(|(h, _)| *h);
    let question = tail.iter().find(|l| {
        let lower = l.to_lowercase();
        lower.starts_with("do you want")
            || lower.contains("(y/n)")
            || lower.contains("[y/n]")
            || lower.starts_with("allow ")
            || lower.contains("would you like to proceed")
    });
    let options = numbered.into_iter().map(|(_, o)| o).collect();
    match (question, highlighted) {
        (Some(q), _) => Some(((*q).to_string(), options)),
        (None, true) => Some(("choose an option".to_string(), options)),
        (None, false) => None,
    }
}

/// A menu without numbers — Claude Code's folder-trust dialog is "❯ No,
/// exit" / "Yes, I trust this folder" — recognised by its footer ("Enter to
/// confirm"). The input box alone never counts: it has no such footer.
/// Options are listed with the highlighted one marked, because the only way
/// to pick another is the arrow keys.
fn unnumbered_menu(lines: &[String]) -> Option<(String, Vec<String>)> {
    let floor = lines.len().saturating_sub(14);
    let footer = (floor..lines.len()).rev().find(|&i| {
        let lower = lines[i].to_lowercase();
        lower.contains("enter to confirm") || lower.contains("enter to select")
    })?;
    let lower_bound = footer.saturating_sub(10);
    let h = (lower_bound..footer).rev().find(|&i| {
        let t = lines[i].trim_start();
        t.starts_with(POINTERS) && !t.trim_start_matches(POINTERS).trim().is_empty()
    })?;
    let is_item = |l: &str| !l.trim().is_empty() && (l.starts_with(' ') || starts_with_pointer(l));
    let mut first = h;
    while first > lower_bound && is_item(&lines[first - 1]) && !lines[first - 1].contains('?') {
        first -= 1;
    }
    let mut last = h;
    while last + 1 < footer && is_item(&lines[last + 1]) {
        last += 1;
    }
    let options = (first..=last)
        .map(|i| {
            let t = lines[i].trim();
            let label = t.trim_start_matches(POINTERS).trim();
            if i == h {
                format!("{label} (highlighted — enter picks it)")
            } else {
                label.to_string()
            }
        })
        .collect();
    let question = lines[lower_bound..first]
        .iter()
        .rev()
        .find_map(|l| l.rfind('?').map(|q| l[..=q].trim().to_string()))
        .unwrap_or_else(|| "choose an option".to_string());
    Some((question, options))
}

/// What the agent was asked to act on, for a decision: the tool call or
/// command shown just above the question ("⏺ Bash(rm -rf node_modules)").
pub fn decision_context(lines: &[String]) -> Option<String> {
    let tail = tail(lines, 20);
    let q = tail.iter().position(|l| {
        let lower = l.to_lowercase();
        lower.starts_with("do you want")
            || lower.starts_with("allow ")
            || lower.contains("would you like to proceed")
    })?;
    tail[..q]
        .iter()
        .rev()
        .take(8)
        .find(|l| !is_rule(l) && !l.starts_with('│') && l.chars().count() > 3)
        .map(|l| {
            l.trim_matches(|c: char| c == '│' || c.is_whitespace())
                .to_string()
        })
}

/// A horizontal rule or box edge — the agent's input-box chrome.
fn is_rule(line: &str) -> bool {
    let t = line.trim();
    let drawn = t
        .chars()
        .filter(|c| {
            matches!(
                c,
                '─' | '━' | '═' | '╌' | '┄' | '┈' | '╭' | '╮' | '╰' | '╯' | '-'
            )
        })
        .count();
    drawn >= 10 && drawn * 10 >= t.chars().count() * 8
}

fn starts_with_pointer(line: &str) -> bool {
    let t = line.trim_start().trim_start_matches('│').trim_start();
    t.starts_with(POINTERS)
}

/// The screen without the agent's input box and footer at the bottom: cut at
/// the rule that sits directly above the input line ("─────" then "❯ ").
/// Looking for that pair, rather than any rule, keeps a table or a "---" in
/// the agent's own reply from being mistaken for the box.
fn without_chrome(lines: &[String]) -> &[String] {
    let floor = lines.len().saturating_sub(12);
    let cut = (floor..lines.len()).rev().find(|&i| {
        is_rule(&lines[i])
            && lines[i + 1..]
                .iter()
                .find(|l| !l.trim().is_empty())
                .is_some_and(|l| starts_with_pointer(l))
    });
    &lines[..cut.unwrap_or(lines.len())]
}

/// Lines that are the agent's machinery rather than its words.
fn is_noise(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("esc to interrupt")
        || is_status_line(line)
        || lower.contains("? for shortcuts")
        || lower.contains("shift+tab to cycle")
        || is_rule(line)
}

/// The agent's latest reply: what it printed after `sent` (the message we
/// typed), or after the last prompt line it echoed, up to its input box.
/// Capped to the newest `max` lines.
pub fn latest_reply(lines: &[String], sent: Option<&str>, max: usize) -> Vec<String> {
    let body = without_chrome(lines);
    let needle: Option<String> = sent
        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .map(|s| s.chars().take(40).collect())
        .filter(|s: &String| s.chars().count() >= 3);
    let start = needle
        .as_deref()
        .and_then(|n| {
            body.iter().rposition(|l| {
                let flat = l.split_whitespace().collect::<Vec<_>>().join(" ");
                flat.contains(n)
            })
        })
        .or_else(|| {
            // An echoed prompt with text after the pointer, and the agent's
            // words below it. An input box at the very bottom (Codex draws
            // no rule around its own) has only footer after it, so it can't
            // anchor.
            body.iter().enumerate().rev().find_map(|(i, l)| {
                let t = l.trim_start();
                let rest = t.trim_start_matches(POINTERS);
                let is_prompt =
                    rest.len() < t.len() && !rest.trim().is_empty() && numbered_option(t).is_none();
                let answered = body[i + 1..]
                    .iter()
                    .any(|l| l.trim_start().starts_with(['⏺', '•']));
                (is_prompt && answered).then_some(i)
            })
        });
    // A long message wraps over several lines; skip the rest of it.
    let flat_sent = sent.map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "));
    let mut from = start.map(|i| i + 1).unwrap_or(0);
    if let (Some(_), Some(flat)) = (start, flat_sent.as_deref()) {
        while from < body.len() {
            let line = body[from].split_whitespace().collect::<Vec<_>>().join(" ");
            if line.is_empty() || !flat.contains(&line) {
                break;
            }
            from += 1;
        }
    }
    let mut reply: Vec<String> = body[from..]
        .iter()
        .filter(|l| !is_noise(l))
        .cloned()
        .collect();
    while reply.first().is_some_and(|l| l.trim().is_empty()) {
        reply.remove(0);
    }
    while reply.last().is_some_and(|l| l.trim().is_empty()) {
        reply.pop();
    }
    let skip = reply.len().saturating_sub(max);
    reply.split_off(skip)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    const IDLE_CLAUDE: &[&str] = &[
        "> fix the header spacing",
        "",
        "⏺ Read(src/components/Header.tsx)",
        "  ⎿  Read 40 lines",
        "",
        "⏺ Done — the header now has 24px of padding and the logo is centred.",
        "",
        "─────────────────────────────────────────────",
        "❯ ",
        "─────────────────────────────────────────────",
        "  ⏵⏵ accept edits on (shift+tab to cycle)",
    ];

    #[test]
    fn a_quiet_agent_with_its_input_box_showing_has_finished() {
        let s = classify(&lines(IDLE_CLAUDE), true, 9_000);
        assert_eq!(s, AgentState::Finished);
    }

    #[test]
    fn the_interrupt_footer_means_working_even_when_quiet() {
        let screen = lines(&[
            "⏺ Update(src/components/Header.tsx)",
            "",
            "✻ Editing Header.tsx… (42s · ↑ 1.2k tokens · esc to interrupt)",
            "─────────────────────────────────────────────",
            "❯ ",
            "─────────────────────────────────────────────",
        ]);
        assert_eq!(
            classify(&screen, true, 8_000),
            AgentState::Working {
                activity: Some("Editing Header.tsx… (42s)".into())
            }
        );
        let codex = lines(&["• Working (5s • esc to interrupt)", "› "]);
        assert_eq!(
            classify(&codex, true, 0),
            AgentState::Working {
                activity: Some("Working (5s)".into())
            }
        );
    }

    #[test]
    fn claude_codes_footer_hint_and_spinner_line() {
        // Recorded from Claude Code 2.1: the hint moved to the footer, and
        // the spinner line carries the activity.
        let screen = lines(&[
            "❯ Create a file named hello.txt containing the word hi.",
            "",
            "⏺ Write(hello.txt)",
            "  ⎿  Wrote 1 line to hello.txt",
            "",
            "✢ Stewing… (4s · ↓ 149 tokens)",
            "",
            "────────────────────────────────────────",
            "❯",
            "────────────────────────────────────────",
            "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt",
        ]);
        assert_eq!(
            classify(&screen, true, 6_000),
            AgentState::Working {
                activity: Some("Stewing… (4s)".into())
            }
        );
        let done = lines(&[
            "❯ Create a file named hello.txt containing the word hi.",
            "",
            "⏺ I created hello.txt, which contains \"hi\".",
            "",
            "✻ Cogitated for 4s · done 8:30 PM",
            "",
            "────────────────────────────────────────",
            "❯",
            "────────────────────────────────────────",
            "  ⏵⏵ auto mode on (shift+tab to cycle)",
        ]);
        assert_eq!(classify(&done, true, 6_000), AgentState::Finished);
        assert_eq!(
            latest_reply(&done, Some("Create a file named hello.txt"), 10),
            lines(&["⏺ I created hello.txt, which contains \"hi\"."])
        );
    }

    #[test]
    fn a_menu_without_numbers_is_a_decision() {
        // Claude Code's folder-trust dialog, as recorded.
        let screen = lines(&[
            " Accessing workspace:",
            "",
            " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
            " project, or work from your team). If not, take a moment to review what's in this folder first.",
            "",
            " Claude Code'll be able to read, edit, and execute files here.",
            "",
            " Security guide",
            "",
            " ❯ No, exit",
            "   Yes, I trust this folder",
            "",
            " Enter to confirm · Esc to cancel",
        ]);
        match classify(&screen, true, 6_000) {
            AgentState::NeedsDecision { question, options } => {
                assert_eq!(
                    question,
                    "Quick safety check: Is this a project you created or one you trust?"
                );
                assert_eq!(
                    options,
                    vec![
                        "No, exit (highlighted — enter picks it)".to_string(),
                        "Yes, I trust this folder".to_string()
                    ]
                );
            }
            other => panic!("{other:?}"),
        }
        // A message typed into the input box is not a menu.
        let typed = lines(&[
            "────────────",
            "❯ fix the footer",
            "────────────",
            "  ⏵⏵ auto mode on",
        ]);
        assert_eq!(classify(&typed, true, 9_000), AgentState::Finished);
    }

    #[test]
    fn recent_output_is_working() {
        assert!(matches!(
            classify(&lines(&["compiling…"]), true, 500),
            AgentState::Working { activity: None }
        ));
    }

    #[test]
    fn a_permission_prompt_is_a_decision_with_its_options() {
        let screen = lines(&[
            "⏺ Bash(rm -rf node_modules)",
            "Do you want to proceed?",
            "❯ 1. Yes",
            "  2. Yes, and don't ask again for rm commands",
            "  3. No, and tell Claude what to do differently (esc)",
        ]);
        match classify(&screen, true, 3_000) {
            AgentState::NeedsDecision { question, options } => {
                assert_eq!(question, "Do you want to proceed?");
                assert_eq!(options.len(), 3);
                assert_eq!(options[0], "1. Yes");
                assert!(options[2].starts_with("3. No"));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            decision_context(&screen).as_deref(),
            Some("⏺ Bash(rm -rf node_modules)")
        );
        // Still being drawn: not settled yet.
        assert!(matches!(
            classify(&screen, true, 200),
            AgentState::Working { .. }
        ));
    }

    #[test]
    fn claude_codes_permission_prompt_as_recorded() {
        let screen = lines(&[
            "❯ Run the shell command: touch made-by-bash.txt — use the Bash tool.",
            "",
            "⏺ Bash(touch made-by-bash.txt)",
            "  ⎿  Waiting…",
            "",
            "────────────────────────────────────────────────────────",
            " Bash command",
            " Create empty file made-by-bash.txt",
            "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
            " touch made-by-bash.txt",
            "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
            " Do you want to proceed?",
            " ❯ 1. Yes",
            "   2. Yes, and always allow access to /Users/a/ShipStudio/bakery",
            "      -site from this project",
            "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
            "   4. No",
            "",
            " Esc to cancel · Tab to amend",
        ]);
        match classify(&screen, true, 6_000) {
            AgentState::NeedsDecision { question, options } => {
                assert_eq!(question, "Do you want to proceed?");
                assert_eq!(options.len(), 4);
                assert_eq!(
                    options[1],
                    "2. Yes, and always allow access to /Users/a/ShipStudio/bakery -site from this project"
                );
                assert_eq!(options[3], "4. No");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            decision_context(&screen).as_deref(),
            Some("touch made-by-bash.txt")
        );
    }

    #[test]
    fn a_dead_tab_has_exited() {
        assert_eq!(classify(&lines(IDLE_CLAUDE), false, 0), AgentState::Exited);
    }

    #[test]
    fn choices_are_read_only_from_the_bottom() {
        let menu = lines(&["Select model", "  1. Opus", "❯ 2. Sonnet"]);
        assert!(awaiting_choice(&menu).is_some());
        let yn = lines(&["Overwrite file? (y/n)"]);
        assert!(awaiting_choice(&yn).is_some());
        assert_eq!(awaiting_choice(&lines(IDLE_CLAUDE)), None);
        assert_eq!(awaiting_choice(&lines(&["❯ fix the footer next"])), None);
        // A numbered list in the agent's reply isn't a menu.
        let list = lines(&["⏺ Next steps:", "  1. Add tests", "  2. Ship it", "❯ "]);
        assert_eq!(awaiting_choice(&list), None);
    }

    #[test]
    fn the_reply_is_what_follows_the_message_without_the_input_box() {
        let reply = latest_reply(&lines(IDLE_CLAUDE), Some("fix the header spacing"), 20);
        assert_eq!(
            reply,
            lines(&[
                "⏺ Read(src/components/Header.tsx)",
                "  ⎿  Read 40 lines",
                "",
                "⏺ Done — the header now has 24px of padding and the logo is centred.",
            ])
        );
        // Without knowing the message, the last echoed prompt anchors it.
        assert_eq!(latest_reply(&lines(IDLE_CLAUDE), None, 20), reply);
        // The budget keeps the newest lines.
        assert_eq!(
            latest_reply(&lines(IDLE_CLAUDE), None, 1),
            lines(&["⏺ Done — the header now has 24px of padding and the logo is centred."])
        );
    }

    #[test]
    fn a_long_message_is_found_by_its_opening_words() {
        let screen = lines(&[
            "> make the pricing page match the screenshot I sent, with three",
            "  tiers and a monthly/yearly toggle",
            "⏺ On it.",
        ]);
        let sent = "make the pricing page match the screenshot I sent, with three tiers and a monthly/yearly toggle";
        assert_eq!(latest_reply(&screen, Some(sent), 10), lines(&["⏺ On it."]));
    }

    #[test]
    fn a_bare_input_box_at_the_bottom_is_not_the_prompt() {
        let codex = lines(&[
            "› add a contact page",
            "• Added src/app/contact/page.tsx with a form.",
            "",
            "› Ask Codex to do anything",
            "  ⏎ send   ⌃J newline",
        ]);
        let reply = latest_reply(&codex, None, 10);
        assert_eq!(reply[0], "• Added src/app/contact/page.tsx with a form.");
    }

    #[test]
    fn a_rule_in_the_reply_is_not_the_input_box() {
        let screen = lines(&[
            "> summarise",
            "⏺ Summary",
            "──────────────────────",
            "  All good.",
            "──────────────────────",
            "❯ ",
            "──────────────────────",
        ]);
        assert_eq!(
            latest_reply(&screen, None, 10),
            lines(&["⏺ Summary", "  All good."])
        );
    }

    #[test]
    fn activity_lines_are_tidied_for_a_person() {
        assert_eq!(
            tidy_activity("✻ Pondering… (esc to interrupt)"),
            "Pondering…"
        );
        assert_eq!(tidy_activity("· Running tests"), "Running tests");
    }
}
