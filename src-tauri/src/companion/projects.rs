//! `projects.changed` / `projects.removed`: the desktop has no event for a
//! session's state (Remote Access reads it off the screen), so while a phone
//! is connected the Mac looks every couple of seconds and journals only what
//! changed. Git is asked far less often: it spawns processes, and a branch
//! or an uncommitted count changes far more slowly than a tab's state.

use serde_json::Value;
use std::collections::HashMap;

use super::wire::Event;

/// The last project list the phones were told about, keyed by path.
#[derive(Default)]
pub struct ProjectsWatch {
    last: HashMap<String, Value>,
}

impl ProjectsWatch {
    /// The events that turn the last list into `next`: a change for each
    /// project that is new or differs, a removal for each that's gone.
    pub fn diff(&mut self, next: Vec<Value>) -> Vec<Event> {
        let mut events = Vec::new();
        let mut seen = HashMap::with_capacity(next.len());
        for project in next {
            let Some(path) = project
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            if self.last.get(&path) != Some(&project) {
                events.push(Event::ProjectChanged {
                    project: project.clone(),
                });
            }
            seen.insert(path, project);
        }
        let mut gone: Vec<String> = self
            .last
            .keys()
            .filter(|p| !seen.contains_key(*p))
            .cloned()
            .collect();
        gone.sort();
        events.extend(gone.into_iter().map(|path| Event::ProjectRemoved { path }));
        self.last = seen;
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project(path: &str, state: &str) -> Value {
        json!({ "path": path, "name": path, "dirtyFiles": 0,
                "sessions": [{ "sessionId": "s1", "tab": 1, "state": state, "lastOutputAt": 1 }] })
    }

    fn kinds(events: &[Event]) -> Vec<String> {
        events
            .iter()
            .map(|e| match e {
                Event::ProjectChanged { project } => format!("changed {}", project["path"]),
                Event::ProjectRemoved { path } => format!("removed {path}"),
                _ => "other".into(),
            })
            .collect()
    }

    #[test]
    fn only_what_changed_is_journaled() {
        let mut w = ProjectsWatch::default();
        let first = w.diff(vec![project("/a", "working"), project("/b", "finished")]);
        assert_eq!(kinds(&first), ["changed \"/a\"", "changed \"/b\""]);
        // Nothing moved: nothing to say.
        assert!(w
            .diff(vec![project("/a", "working"), project("/b", "finished")])
            .is_empty());
        // One tab now waits on the user; the other project is closed.
        let next = w.diff(vec![project("/a", "needs_decision")]);
        assert_eq!(kinds(&next), ["changed \"/a\"", "removed /b"]);
    }

    #[test]
    fn a_removed_project_replays_as_removed() {
        use crate::companion::hub::Hub;
        let hub = Hub::new("e".into());
        let mut w = ProjectsWatch::default();
        for e in w.diff(vec![project("/a", "working")]) {
            hub.publish(e);
        }
        for e in w.diff(vec![]) {
            hub.publish(e);
        }
        let (_, resume) = hub.resume(Some(&super::super::wire::Cursor {
            epoch: "e".into(),
            seq: 0,
        }));
        let crate::companion::hub::Resume::Replay { events, .. } = resume else {
            panic!("same epoch replays");
        };
        assert_eq!(events.len(), 1, "the change is superseded by the removal");
        assert!(matches!(events[0].1, Event::ProjectRemoved { .. }));
    }
}
