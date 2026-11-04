//! A reply while it is being written.
//!
//! With `--include-partial-messages` Claude Code interleaves raw API stream
//! events (`stream_event`) with its usual complete `assistant` events. The
//! text deltas of a top-level text block become a *draft*: the UI shows it
//! growing, and the complete block that follows is recorded under the
//! draft's id, so the finished message takes the draft's place instead of
//! appearing beside it. Sub-agent (Task) output streams too, tagged with a
//! `parent_tool_use_id`; it stays internal, exactly as its complete form does.
//!
//! Observed order (claude 2.1, `testdata/stream-partial.jsonl`):
//! `content_block_start` → `content_block_delta`… → the complete `assistant`
//! event for that one block → `content_block_stop`.

use serde_json::Value;

/// Whether an event belongs to the agent's own conversation rather than a sub-agent's.
pub fn top_level(value: &Value) -> bool {
    value.get("parent_tool_use_id").is_none_or(|p| p.is_null())
}

#[derive(Debug)]
struct Draft {
    id: String,
    /// The block's index within its API message; deltas name it.
    index: u64,
    text: String,
}

/// The one text block being streamed, and whether the UI has seen its latest text.
#[derive(Debug, Default)]
pub struct Drafts {
    current: Option<Draft>,
    dirty: bool,
}

impl Drafts {
    /// Fold in a `stream_event` line. A new text block opens a draft (with a
    /// fresh id from `new_id`); a text delta for it grows the draft.
    pub fn on_stream_event(&mut self, value: &Value, new_id: impl FnOnce() -> String) {
        if !top_level(value) {
            return;
        }
        let Some(event) = value.get("event") else {
            return;
        };
        let index = event.get("index").and_then(Value::as_u64);
        match event.get("type").and_then(Value::as_str) {
            Some("content_block_start") => {
                let is_text =
                    event.pointer("/content_block/type").and_then(Value::as_str) == Some("text");
                if let (true, Some(index)) = (is_text, index) {
                    self.current = Some(Draft {
                        id: new_id(),
                        index,
                        text: String::new(),
                    });
                }
            }
            Some("content_block_delta") => {
                let Some(draft) = self.current.as_mut().filter(|d| Some(d.index) == index) else {
                    return;
                };
                if event.pointer("/delta/type").and_then(Value::as_str) != Some("text_delta") {
                    return;
                }
                if let Some(text) = event.pointer("/delta/text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        draft.text.push_str(text);
                        self.dirty = true;
                    }
                }
            }
            _ => {}
        }
    }

    /// Changed since the last `flush`.
    pub fn dirty(&self) -> bool {
        self.dirty
    }

    /// The draft to show (id, text so far), if it changed since last time.
    pub fn flush(&mut self) -> Option<(&str, &str)> {
        if !std::mem::take(&mut self.dirty) {
            return None;
        }
        self.current
            .as_ref()
            .filter(|d| !d.text.trim().is_empty())
            .map(|d| (d.id.as_str(), d.text.as_str()))
    }

    /// A complete text block arrived: the id it should be recorded under, if
    /// it is the block that was streaming. Anything else gets a fresh id.
    pub fn finish(&mut self, complete: &str) -> Option<String> {
        let draft = self.current.as_ref()?;
        if !complete.trim().starts_with(draft.text.trim()) {
            return None;
        }
        self.dirty = false;
        self.current.take().map(|d| d.id)
    }

    /// The turn ended with a block still open (stopped, or the process
    /// died): what was written of it, to keep.
    pub fn take(&mut self) -> Option<(String, String)> {
        self.dirty = false;
        self.current
            .take()
            .map(|d| (d.id, d.text.trim().to_string()))
            .filter(|(_, text)| !text.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("testdata/stream-partial.jsonl");

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("d{n}")
        }
    }

    /// What the runner does, minus the UI: every draft shown, and every
    /// complete text block with the id it is recorded under.
    fn replay(sample: &str) -> (Vec<(String, String)>, Vec<(String, String)>) {
        let mut drafts = Drafts::default();
        let mut next = ids();
        let (mut shown, mut recorded) = (Vec::new(), Vec::new());
        for line in sample.lines() {
            let value: Value = serde_json::from_str(line).unwrap();
            match value.get("type").and_then(Value::as_str) {
                Some("stream_event") => {
                    drafts.on_stream_event(&value, &mut next);
                    if let Some((id, text)) = drafts.flush() {
                        shown.push((id.to_string(), text.to_string()));
                    }
                }
                Some("assistant") if top_level(&value) => {
                    for block in value["message"]["content"].as_array().unwrap() {
                        if block["type"] == "text" {
                            let text = block["text"].as_str().unwrap();
                            let id = drafts.finish(text).unwrap_or_else(&mut next);
                            recorded.push((id, text.to_string()));
                        }
                    }
                }
                _ => {}
            }
        }
        (shown, recorded)
    }

    #[test]
    fn a_real_stream_grows_a_draft_that_the_complete_block_replaces() {
        let (shown, recorded) = replay(SAMPLE);
        // Two text blocks either side of a Bash call; the tool input never streams as text.
        assert_eq!(recorded.len(), 2);
        let (first_id, first_text) = &recorded[0];
        assert!(first_text.starts_with("Hello there!"));
        let first: Vec<_> = shown.iter().filter(|(id, _)| id == first_id).collect();
        assert!(first.len() > 1, "the first block streamed in pieces");
        assert!(first.windows(2).all(|w| w[1].1.starts_with(&w[0].1)));
        assert_eq!(&first.last().unwrap().1, first_text);
        assert!(shown.iter().all(|(_, text)| !text.contains("command")));
        // The final block streamed too, and kept its draft's id.
        assert!(shown
            .iter()
            .any(|(id, t)| id == &recorded[1].0 && t == "done"));
        assert_ne!(recorded[0].0, recorded[1].0);
    }

    #[test]
    fn sub_agent_text_never_streams() {
        let line = |event: &str| {
            serde_json::from_str::<Value>(&format!(
                r#"{{"type":"stream_event","parent_tool_use_id":"toolu_1","event":{event}}}"#
            ))
            .unwrap()
        };
        let mut drafts = Drafts::default();
        drafts.on_stream_event(
            &line(r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#),
            || "d1".into(),
        );
        drafts.on_stream_event(
            &line(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"internal"}}"#),
            || "d2".into(),
        );
        assert!(!drafts.dirty());
        assert!(drafts.take().is_none());
    }

    #[test]
    fn a_stopped_reply_keeps_what_streamed() {
        let mut drafts = Drafts::default();
        let mut next = ids();
        // Everything up to the first block's third delta, then Stop.
        for line in SAMPLE.lines().take(7) {
            let value: Value = serde_json::from_str(line).unwrap();
            if value["type"] == "stream_event" {
                drafts.on_stream_event(&value, &mut next);
            }
        }
        let (id, text) = drafts.take().unwrap();
        assert_eq!(id, "d1");
        assert_eq!(text, "Hello there! I'm here and ready to help you");
        assert!(drafts.take().is_none());
    }

    #[test]
    fn deltas_are_batched_until_flushed() {
        let mut drafts = Drafts::default();
        let mut next = ids();
        let mut flushes = 0;
        for line in SAMPLE.lines().take(9) {
            let value: Value = serde_json::from_str(line).unwrap();
            if value["type"] == "stream_event" {
                drafts.on_stream_event(&value, &mut next);
            }
        }
        while drafts.flush().is_some() {
            flushes += 1;
        }
        assert_eq!(flushes, 1, "five deltas, one update");
    }
}
