//! Importing by copy and paste, for when remote access isn't set up.
//!
//! The user sends their other assistant [`PASTE_PROMPT`], it replies with its
//! agents as one or more fenced JSON blocks, and the user pastes the whole
//! reply back. This finds the JSON in that reply, checks it, and hands it to
//! the same [`super::import::import`] the `import_agents` tool uses, so both paths
//! merge the same way.
//!
//! Nothing here guesses. A trailing comma or a cut-off block is reported with
//! where it is, not repaired; the one thing accepted as-is is curly quotes
//! standing in for JSON's straight ones, and only when the text doesn't parse
//! without that (chat apps and notes "smarten" quotes on copy).

use serde::Serialize;
use serde_json::{Map, Value};

use super::import::{ImportedAgent, ImportedRoutine};
use super::{schedule, store};
use crate::errors::CommandError;

/// The most agents one import takes (the same cap [`super::import::import`] applies).
const MAX_AGENTS: usize = 50;
const MAX_NAME_CHARS: usize = 40;

/// What the user sends their other assistant to get its agents back as JSON.
pub const PASTE_PROMPT: &str = r#"I'm moving my agents to Ship Studio. Please give me a complete copy of every agent you run for me, including the main one that manages the others.

Reply with one ```json code block in exactly this shape:

{
  "source": "your product's name, e.g. Grok Bot",
  "agents": [
    {
      "name": "the agent's name",
      "role": "one line: what it does",
      "instructions": "its full instructions, word for word",
      "memory": "everything it remembers that it still needs, one fact per line",
      "is_main": false,
      "color": "red",
      "routines": [
        { "when": "every weekday at 9am", "what": "what it does then, in a sentence or two" }
      ]
    }
  ]
}

Rules:
- Include every agent. Set "is_main": true on the one that manages the others (at most one), false on the rest.
- Copy instructions and memory in full, word for word. Don't summarize, shorten or paraphrase them. Long is fine.
- "routines": everything the agent does on its own on a schedule (routines, automations, reminders, recurring check-ins), one entry each. Write "when" in plain words, like "every weekday at 9am", "every monday at 8:30am", "every day at 7pm", "every 2 hours" or, for a one-off, "friday at 2pm". Start repeating ones with "every". Write "what" so the agent knows exactly what to do when it fires. Use [] if it has none.
- "color" is optional: if the agent has one, use the closest of white, brown, red, orange, amber, green, teal, blue, purple, pink, gray. Otherwise leave it out.
- Never include passwords, API keys, tokens, card numbers or any other credentials. If an instruction or memory contains one, write [removed] in its place.
- Valid JSON only: straight double quotes, line breaks written as \n inside strings, no comments, no trailing commas.
- If it's too long for one message, split it into numbered ```json blocks (Part 1 of 3, Part 2 of 3, ...), each in the same shape and each holding whole agents. Never split one agent across blocks. Send the next part when I say "continue".
- Put nothing but the JSON inside each code block."#;

/// The agents found in a pasted reply, and everything wrong with it.
#[derive(Debug, Default)]
pub struct Parsed {
    pub source: String,
    pub agents: Vec<ImportedAgent>,
    /// Each names the block, the agent and the field. Any problem blocks the import.
    pub problems: Vec<String>,
    pub blocks: usize,
}

/// One agent as the paste preview lists it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAgent {
    pub name: String,
    pub role: String,
    pub is_main: bool,
    /// Non-main agents only: an agent with this name already exists and is updated.
    pub existing: bool,
    pub instructions_chars: usize,
    pub memory_lines: usize,
    pub routines: Vec<PreviewRoutine>,
}

/// One routine as the preview lists it: what it becomes, or why it won't be set.
/// A refused routine doesn't block the import; it's listed so it isn't lost.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRoutine {
    pub when: String,
    pub what: String,
    /// "every weekday at 09:00" or "once, Fri 6 Nov 2026, 14:00 (UTC-05:00)".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub source: String,
    pub blocks: usize,
    pub agents: Vec<PreviewAgent>,
    pub problems: Vec<String>,
}

/// The JSON candidates in a reply: every ```json (or untagged JSON-looking)
/// fenced block; failing that, the reply itself if it is bare JSON.
fn extract_blocks(text: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        let Some(info) = line.trim_start().strip_prefix("```") else {
            continue;
        };
        let info = info.trim().to_ascii_lowercase();
        let mut body = String::new();
        for inner in lines.by_ref() {
            let trimmed = inner.trim_end();
            if trimmed.trim_start().starts_with("```") {
                break;
            }
            // A closing fence glued to the last line: `}````.
            if let Some(before) = trimmed.strip_suffix("```") {
                body.push_str(before);
                body.push('\n');
                break;
            }
            body.push_str(inner);
            body.push('\n');
        }
        let looks_like_json = matches!(body.trim_start().chars().next(), Some('{' | '['));
        let tagged_json = info.starts_with("json");
        if tagged_json || (info.is_empty() && looks_like_json) {
            blocks.push(body);
        }
    }
    if blocks.is_empty() {
        let trimmed = text.trim();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            blocks.push(trimmed.to_string());
        } else if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
            if start < end && trimmed[start..=end].contains("\"agents\"") {
                blocks.push(trimmed[start..=end].to_string());
            }
        }
    }
    blocks
}

const CURLY_DOUBLE: [char; 4] = ['\u{201C}', '\u{201D}', '\u{201E}', '\u{201F}'];

/// Parse one block, reporting a failure in words the user can act on.
fn parse_block(raw: &str, label: &str) -> Result<Value, String> {
    // Trimmed, so a block cut off mid-string reads as cut off rather than as
    // a line break inside that string.
    let raw = raw.trim_start_matches('\u{FEFF}').trim();
    let first = match serde_json::from_str::<Value>(raw) {
        Ok(value) => return Ok(value),
        Err(e) => e,
    };
    // Straight quotes "smartened" on copy: only accepted when that's all it was.
    let err = if raw.contains(CURLY_DOUBLE) {
        let straightened: String = raw
            .chars()
            .map(|c| if CURLY_DOUBLE.contains(&c) { '"' } else { c })
            .collect();
        match serde_json::from_str::<Value>(&straightened) {
            Ok(value) => return Ok(value),
            Err(e) => e,
        }
    } else {
        first
    };
    let at = format!("line {}", err.line());
    Err(if err.is_eof() {
        format!("{label} stops before the JSON is complete, so it was probably cut off. Ask the assistant to send that part again.")
    } else if err.to_string().contains("trailing comma") {
        let line = comma_line(raw, err.line(), err.column()).unwrap_or(err.line());
        format!("{label} has a trailing comma at line {line} (a comma right before a }} or ]). Delete that comma, or ask the assistant to send it again as valid JSON.")
    } else {
        let detail = err.to_string();
        let detail = detail.split(" at line").next().unwrap_or(&detail);
        format!("{label} isn't valid JSON at {at}: {detail}.")
    })
}

/// serde reports a trailing comma where it meets the `]` or `}` after it;
/// the user is looking for the comma itself, often a line or two earlier.
fn comma_line(raw: &str, line: usize, column: usize) -> Option<usize> {
    let mut offset = 0;
    for (i, text) in raw.split_inclusive('\n').enumerate() {
        if i + 1 == line {
            offset += column.saturating_sub(1).min(text.len());
            break;
        }
        offset += text.len();
    }
    let before = raw.get(..offset)?.trim_end();
    before
        .ends_with(',')
        .then(|| before.matches('\n').count() + 1)
}

fn text_field(
    obj: &Map<String, Value>,
    field: &str,
    who: &str,
    problems: &mut Vec<String>,
) -> String {
    match obj.get(field) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        // Memory as a list of facts is a fair reading of "one fact per line".
        Some(Value::Array(items)) if field == "memory" && items.iter().all(|i| i.is_string()) => {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n")
        }
        Some(other) => {
            problems.push(format!(
                "{who}: \"{field}\" should be text, not {}.",
                kind(other)
            ));
            String::new()
        }
    }
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "empty",
        Value::Bool(_) => "true/false",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

/// One agent entry, or the reason it isn't one.
fn read_agent(value: &Value, position: &str, problems: &mut Vec<String>) -> Option<ImportedAgent> {
    let Some(obj) = value.as_object() else {
        problems.push(format!(
            "{position} isn't an agent: expected {{\"name\", \"role\", ...}}, found {}.",
            kind(value)
        ));
        return None;
    };
    let name = match obj.get("name") {
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        Some(Value::String(_)) | None | Some(Value::Null) => {
            problems.push(format!("{position} has no \"name\"."));
            return None;
        }
        Some(other) => {
            problems.push(format!(
                "{position}: \"name\" should be text, not {}.",
                kind(other)
            ));
            return None;
        }
    };
    let who = format!("\u{201C}{name}\u{201D}");
    let before = problems.len();
    if name.chars().count() > MAX_NAME_CHARS {
        problems.push(format!(
            "{who}: \"name\" is over {MAX_NAME_CHARS} characters. Shorten it in the pasted text."
        ));
    }
    let role = text_field(obj, "role", &who, problems);
    let instructions = text_field(obj, "instructions", &who, problems);
    let memory = text_field(obj, "memory", &who, problems);
    let is_main = match obj.get("is_main") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(other) => {
            problems.push(format!(
                "{who}: \"is_main\" should be true or false, not {}.",
                kind(other)
            ));
            false
        }
    };
    let routines = read_routines(obj, &who, problems);
    let color = match obj.get("color") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.trim().to_ascii_lowercase()),
        Some(other) => {
            problems.push(format!(
                "{who}: \"color\" should be text, not {}.",
                kind(other)
            ));
            None
        }
    };
    (problems.len() == before).then_some(ImportedAgent {
        name,
        role,
        instructions,
        memory,
        is_main,
        color,
        routines,
    })
}

/// The `routines` list. Its shape must be right (a list of `{when, what}`);
/// whether each phrase can be scheduled is the preview's business, not a problem.
fn read_routines(
    obj: &Map<String, Value>,
    who: &str,
    problems: &mut Vec<String>,
) -> Vec<ImportedRoutine> {
    let list = match obj.get("routines") {
        None | Some(Value::Null) => return Vec::new(),
        Some(Value::Array(list)) => list,
        Some(other) => {
            problems.push(format!(
                "{who}: \"routines\" should be a list, not {}.",
                kind(other)
            ));
            return Vec::new();
        }
    };
    let mut routines = Vec::with_capacity(list.len());
    for (i, item) in list.iter().enumerate() {
        let at = format!("{who}, routine {}", i + 1);
        let Some(entry) = item.as_object() else {
            problems.push(format!(
                "{at}: expected {{\"when\", \"what\"}}, found {}.",
                kind(item)
            ));
            continue;
        };
        let mut field = |name: &str| match entry.get(name) {
            Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
            Some(Value::String(_)) | None | Some(Value::Null) => {
                problems.push(format!("{at} has no \"{name}\"."));
                None
            }
            Some(other) => {
                problems.push(format!(
                    "{at}: \"{name}\" should be text, not {}.",
                    kind(other)
                ));
                None
            }
        };
        if let (Some(when), Some(what)) = (field("when"), field("what")) {
            routines.push(ImportedRoutine { when, what });
        }
    }
    routines
}

/// What each routine would become, checked the way the import will check it.
fn preview_routines(routines: &[ImportedRoutine]) -> Vec<PreviewRoutine> {
    let tz = chrono::Local;
    let now = store::now_ms();
    routines
        .iter()
        .map(|r| {
            let (schedule, refused) = match schedule::check(&tz, &r.when, &r.what, now) {
                Ok((repeat, next_at)) => (
                    Some(schedule::describe_schedule(&tz, repeat.as_ref(), next_at)),
                    None,
                ),
                Err(why) => (None, Some(why.plain())),
            };
            PreviewRoutine {
                when: r.when.clone(),
                what: r.what.clone(),
                schedule,
                refused,
            }
        })
        .collect()
}

/// Everything in a pasted reply: the agents from every block, merged in order.
pub fn parse(text: &str) -> Parsed {
    let mut parsed = Parsed::default();
    let blocks = extract_blocks(text);
    parsed.blocks = blocks.len();
    if blocks.is_empty() {
        parsed.problems.push(
            "There's no JSON in what you pasted. Paste the assistant's whole reply, including its ```json block.".into(),
        );
        return parsed;
    }
    let many = blocks.len() > 1;
    // Where each name was first seen, to report duplicates across blocks.
    let mut seen: Vec<(String, String)> = Vec::new();
    for (i, raw) in blocks.iter().enumerate() {
        let label = if many {
            format!("Block {}", i + 1)
        } else {
            "The JSON".to_string()
        };
        let value = match parse_block(raw, &label) {
            Ok(v) => v,
            Err(problem) => {
                parsed.problems.push(problem);
                continue;
            }
        };
        let entries = match value {
            Value::Object(ref obj) if obj.contains_key("agents") => {
                if let Some(source) = obj.get("source").and_then(Value::as_str) {
                    if parsed.source.is_empty() {
                        parsed.source = source.trim().to_string();
                    }
                }
                match obj.get("agents") {
                    Some(Value::Array(list)) => list.clone(),
                    other => {
                        parsed.problems.push(format!(
                            "{label}: \"agents\" should be a list, not {}.",
                            kind(other.unwrap_or(&Value::Null))
                        ));
                        continue;
                    }
                }
            }
            Value::Object(ref obj) if obj.contains_key("name") => vec![value.clone()],
            Value::Array(list) => list,
            _ => {
                parsed
                    .problems
                    .push(format!("{label} has no \"agents\" list."));
                continue;
            }
        };
        for (j, entry) in entries.iter().enumerate() {
            let position = if many {
                format!("Agent {} in block {}", j + 1, i + 1)
            } else {
                format!("Agent {}", j + 1)
            };
            let Some(agent) = read_agent(entry, &position, &mut parsed.problems) else {
                continue;
            };
            let key = agent.name.to_lowercase();
            let here = label.to_lowercase();
            if let Some((_, first)) = seen.iter().find(|(k, _)| *k == key) {
                let blocks = if many {
                    format!(" ({first} and {here})")
                } else {
                    String::new()
                };
                parsed.problems.push(format!(
                    "\u{201C}{}\u{201D} appears twice{blocks}. Each agent should appear once.",
                    agent.name
                ));
                continue;
            }
            seen.push((key, here));
            parsed.agents.push(agent);
        }
    }
    let mains: Vec<&str> = parsed
        .agents
        .iter()
        .filter(|a| a.is_main)
        .map(|a| a.name.as_str())
        .collect();
    if mains.len() > 1 {
        parsed.problems.push(format!(
            "Only one agent can be the main one, but {} are all marked \"is_main\": true.",
            mains
                .iter()
                .map(|n| format!("\u{201C}{n}\u{201D}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if parsed.agents.len() > MAX_AGENTS {
        parsed.problems.push(format!(
            "That's {} agents; one import takes up to {MAX_AGENTS}.",
            parsed.agents.len()
        ));
    }
    if parsed.agents.is_empty() && parsed.problems.is_empty() {
        parsed.problems.push("The \"agents\" list is empty.".into());
    }
    parsed
}

/// What importing this paste would do, for the modal to show before it does it.
pub fn preview(text: &str) -> Result<Preview, CommandError> {
    let parsed = parse(text);
    let mut agents = Vec::with_capacity(parsed.agents.len());
    for a in &parsed.agents {
        agents.push(PreviewAgent {
            existing: !a.is_main && store::find(&a.name)?.is_some(),
            name: a.name.clone(),
            role: a.role.trim().to_string(),
            is_main: a.is_main,
            instructions_chars: a.instructions.trim().chars().count(),
            memory_lines: a.memory.lines().filter(|l| !l.trim().is_empty()).count(),
            routines: preview_routines(&a.routines),
        });
    }
    Ok(Preview {
        source: parsed.source,
        blocks: parsed.blocks,
        agents,
        problems: parsed.problems,
    })
}

/// The agents and source to import, or every problem as one Validation error.
pub fn for_import(text: &str) -> Result<(Vec<ImportedAgent>, String), CommandError> {
    let parsed = parse(text);
    if !parsed.problems.is_empty() {
        return Err(super::err_invalid("text", parsed.problems.join("\n")));
    }
    Ok((parsed.agents, parsed.source))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::import;

    const ONE: &str = r#"{"source":"Grok Bot","agents":[
        {"name":"Chief","role":"Runs things","instructions":"Keep me on track.","memory":"- Likes mornings","is_main":true},
        {"name":"Finance","role":"Money","instructions":"Log every expense.","memory":"Accountant is Sam\nPays rent on the 1st","color":"Teal"}
    ]}"#;

    fn names(p: &Parsed) -> Vec<&str> {
        p.agents.iter().map(|a| a.name.as_str()).collect()
    }

    #[test]
    fn finds_the_block_inside_prose() {
        let reply = format!(
            "Sure! Here's everything:\n\n```json\n{ONE}\n```\n\nLet me know if you need more."
        );
        let p = parse(&reply);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert_eq!(p.source, "Grok Bot");
        assert_eq!(names(&p), ["Chief", "Finance"]);
        assert!(p.agents[0].is_main);
        assert_eq!(p.agents[1].color.as_deref(), Some("teal"));
        assert_eq!(
            p.agents[1].memory,
            "Accountant is Sam\nPays rent on the 1st"
        );
    }

    #[test]
    fn bare_json_and_json_after_prose_without_fences() {
        assert_eq!(names(&parse(ONE)), ["Chief", "Finance"]);
        let p = parse(&format!("Here you go: {ONE} Hope that helps."));
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert_eq!(p.agents.len(), 2);
    }

    #[test]
    fn merges_numbered_blocks_and_ignores_other_code() {
        let reply = "Part 1 of 2:\n```json\n{\"source\":\"Grok Bot\",\"agents\":[{\"name\":\"A\"}]}\n```\n\
            Example:\n```bash\necho {}\n```\n\
            Part 2 of 2:\n```JSON\n{\"source\":\"Grok Bot\",\"agents\":[{\"name\":\"B\"},{\"name\":\"C\"}]}```\n";
        let p = parse(reply);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert_eq!(p.blocks, 2);
        assert_eq!(names(&p), ["A", "B", "C"]);
    }

    #[test]
    fn a_trailing_comma_is_reported_with_its_line_not_repaired() {
        let p = parse("```json\n{\"agents\":[\n  {\"name\":\"A\"},\n]}\n```");
        assert!(p.agents.is_empty());
        assert_eq!(p.problems.len(), 1);
        assert!(
            p.problems[0].contains("trailing comma at line 2"),
            "{}",
            p.problems[0]
        );
    }

    #[test]
    fn a_cut_off_block_says_so_and_names_the_block() {
        let reply = "```json\n{\"agents\":[{\"name\":\"A\"}]}\n```\n```json\n{\"agents\":[{\"name\":\"B\",\"instr";
        let p = parse(reply);
        assert_eq!(names(&p), ["A"]);
        assert!(
            p.problems[0].starts_with("Block 2 stops before"),
            "{:?}",
            p.problems
        );
    }

    #[test]
    fn curly_quotes_used_as_json_quotes_are_accepted_but_kept_inside_text() {
        let smart = "```json\n{\u{201C}agents\u{201D}: [{\u{201C}name\u{201D}: \u{201C}Finance\u{201D}}]}\n```";
        let p = parse(smart);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert_eq!(names(&p), ["Finance"]);

        let content =
            "{\"agents\":[{\"name\":\"A\",\"instructions\":\"Say \u{201C}hi\u{201D} first.\"}]}";
        let p = parse(content);
        assert_eq!(p.agents[0].instructions, "Say \u{201C}hi\u{201D} first.");
    }

    #[test]
    fn validation_names_the_agent_and_the_field() {
        let p = parse(
            r#"{"agents":[
                {"name":"Finance","instructions":["a","b"],"is_main":"yes"},
                {"role":"No name"},
                "Travel",
                {"name":"Ops","memory":["Fact one","Fact two"]},
                {"name":"ops"}
            ]}"#,
        );
        assert_eq!(names(&p), ["Ops"]);
        assert_eq!(p.agents[0].memory, "Fact one\nFact two");
        let all = p.problems.join("\n");
        assert!(
            all.contains("\u{201C}Finance\u{201D}: \"instructions\" should be text, not a list."),
            "{all}"
        );
        assert!(
            all.contains("\u{201C}Finance\u{201D}: \"is_main\" should be true or false"),
            "{all}"
        );
        assert!(all.contains("Agent 2 has no \"name\"."), "{all}");
        assert!(all.contains("Agent 3 isn't an agent"), "{all}");
        assert!(all.contains("\u{201C}ops\u{201D} appears twice"), "{all}");
    }

    #[test]
    fn routines_are_read_and_previewed_and_refused_phrases_are_listed_not_blocking() {
        let reply = r#"```json
{"source":"Grok Bot","agents":[
  {"name":"Finance","routines":[
    {"when":"every weekday at 9am","what":"Send yesterday's spending."},
    {"when":"when the moon is full","what":"Review the budget."}
  ]},
  {"name":"Travel","routines":[]}
]}
```"#;
        let p = parse(reply);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert_eq!(p.agents[0].routines.len(), 2);
        assert!(p.agents[1].routines.is_empty());

        let shown = preview_routines(&p.agents[0].routines);
        assert_eq!(shown[0].schedule.as_deref(), Some("every weekday at 09:00"));
        assert!(shown[0].refused.is_none());
        assert!(shown[1].schedule.is_none());
        let why = shown[1].refused.as_deref().unwrap();
        assert!(!why.is_empty() && !why.contains("Examples:"), "{why}");
        assert!(for_import(reply).is_ok(), "a refused phrase doesn't block");

        // A wrong shape does block, and says where.
        let p = parse(
            r#"{"agents":[
                {"name":"A","routines":"every day at 9"},
                {"name":"B","routines":[{"when":"every day at 9"},"daily",{"when":9,"what":"x"}]}
            ]}"#,
        );
        let all = p.problems.join("\n");
        assert!(
            all.contains("\u{201C}A\u{201D}: \"routines\" should be a list, not text."),
            "{all}"
        );
        assert!(
            all.contains("\u{201C}B\u{201D}, routine 1 has no \"what\"."),
            "{all}"
        );
        assert!(
            all.contains("\u{201C}B\u{201D}, routine 2: expected"),
            "{all}"
        );
        assert!(
            all.contains("routine 3: \"when\" should be text, not a number."),
            "{all}"
        );
        assert!(p.agents.is_empty());
    }

    #[test]
    fn two_mains_and_no_json_are_errors() {
        let p = parse(r#"[{"name":"A","is_main":true},{"name":"B","is_main":true}]"#);
        assert!(p.problems[0].contains("Only one agent can be the main one"));
        let p = parse("Sorry, I can't share that.");
        assert!(p.problems[0].starts_with("There's no JSON"));
        let p = parse("```json\n{\"source\":\"X\",\"agents\":[]}\n```");
        assert_eq!(p.problems, ["The \"agents\" list is empty."]);
    }

    #[test]
    fn importing_a_paste_merges_exactly_like_the_tool() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));

        let reply = format!("Here it is:\n```json\n{ONE}\n```");
        let before = preview(&reply).unwrap();
        assert!(!before.agents[1].existing);
        assert_eq!(before.agents[1].memory_lines, 2);

        let (agents, source) = for_import(&reply).unwrap();
        let summary = import::import(agents, &source).unwrap();
        assert_eq!(summary.created, ["Finance"]);
        assert_eq!(summary.updated, ["Chief of Staff"]);
        let finance = store::find("Finance").unwrap().unwrap();
        assert_eq!(finance.color, "teal");
        let md = std::fs::read_to_string(store::agent_home(&finance.id).unwrap().join("CLAUDE.md"))
            .unwrap();
        assert!(md.contains("### Imported from Grok Bot"));
        assert!(md.contains("Pays rent on the 1st"));

        // Pasting again updates rather than duplicating, and the preview says so.
        assert!(preview(&reply).unwrap().agents[1].existing);
        let (agents, source) = for_import(&reply).unwrap();
        let again = import::import(agents, &source).unwrap();
        assert!(again.created.is_empty());
        assert_eq!(store::list().unwrap().len(), 2);

        // Anything wrong blocks the whole import.
        assert!(for_import("```json\n{\"agents\":[{\"name\":\"A\"},]}\n```").is_err());

        store::set_root_for_tests(None);
    }
}
