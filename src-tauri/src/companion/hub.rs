//! The event journal and fan-out.
//!
//! Every journaled event gets a `seq` that only ever increases, under an
//! `epoch` minted when the hub is created (app start). A phone that comes
//! back with a cursor from this epoch, still inside the journal, is replayed
//! exactly what it missed; anything else gets a snapshot. Status-like events
//! keep only their latest value per key, so a phone that slept through a
//! thousand activity updates is sent one.
//!
//! Drafts are ephemeral: never journaled, and turned into appends per
//! connection by [`Drafts`], because the desktop resends a growing reply's
//! whole text every 40 ms and over cellular that is most of the traffic.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use serde_json::Value;

use super::wire::{Cursor, Event};

/// How long, and how many, events stay replayable.
pub const JOURNAL_MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;
pub const JOURNAL_MAX_ENTRIES: usize = 20_000;
/// A connection that falls this far behind is closed and resumes by cursor.
const CHANNEL_CAPACITY: usize = 2048;
/// At most one draft frame per reply per connection in this window.
pub const DRAFT_EVERY: Duration = Duration::from_millis(100);

/// Which events replay keeps only the latest of, and under what key.
/// `None`: every one is kept (messages are upserts by id, so all matter).
fn replay_key(event: &Event) -> Option<String> {
    match event {
        Event::Message { .. } => None,
        Event::Status { agent_id, .. } => Some(format!("status:{agent_id}")),
        Event::Registry { .. } => Some("registry".into()),
        Event::System { .. } => Some("system".into()),
        // A removal supersedes the project's last change, and the other way round.
        Event::ProjectChanged { project } => Some(format!(
            "project:{}",
            project.get("path").and_then(Value::as_str).unwrap_or("")
        )),
        Event::ProjectRemoved { path } => Some(format!("project:{path}")),
        // Never journaled (see `Hub::publish`); keyed so a mistake can't pile up.
        Event::Draft { .. } | Event::Snapshot { .. } | Event::CaughtUp { .. } => {
            Some("ephemeral".into())
        }
    }
}

struct Entry {
    seq: u64,
    at_ms: u64,
    key: Option<String>,
    event: Event,
}

pub struct Journal {
    epoch: String,
    seq: u64,
    entries: VecDeque<Entry>,
    /// For keyed events: the seq of the latest one. Older ones with the same
    /// key stay in `entries` until trimmed but are skipped by replay.
    latest: HashMap<String, u64>,
    /// The highest seq dropped by trimming. A cursor below it has a gap.
    trimmed_through: u64,
    max_entries: usize,
    max_age_ms: u64,
}

impl Journal {
    pub fn new(epoch: String, max_entries: usize, max_age_ms: u64) -> Self {
        Journal {
            epoch,
            seq: 0,
            entries: VecDeque::new(),
            latest: HashMap::new(),
            trimmed_through: 0,
            max_entries,
            max_age_ms,
        }
    }

    pub fn cursor(&self) -> Cursor {
        Cursor {
            epoch: self.epoch.clone(),
            seq: self.seq,
        }
    }

    pub fn append(&mut self, event: Event, now_ms: u64) -> u64 {
        self.seq += 1;
        let key = replay_key(&event);
        if let Some(k) = &key {
            self.latest.insert(k.clone(), self.seq);
        }
        self.entries.push_back(Entry {
            seq: self.seq,
            at_ms: now_ms,
            key,
            event,
        });
        self.trim(now_ms);
        self.seq
    }

    fn trim(&mut self, now_ms: u64) {
        while let Some(front) = self.entries.front() {
            let too_many = self.entries.len() > self.max_entries;
            let too_old = now_ms.saturating_sub(front.at_ms) > self.max_age_ms;
            if !too_many && !too_old {
                break;
            }
            let Some(gone) = self.entries.pop_front() else {
                break;
            };
            self.trimmed_through = gone.seq;
            if let Some(k) = gone.key {
                if self.latest.get(&k) == Some(&gone.seq) {
                    self.latest.remove(&k);
                }
            }
        }
    }

    /// Everything after `cursor` that replay keeps, in order; `None` when the
    /// cursor can't be replayed from (another epoch, trimmed past, or ahead).
    pub fn since(&mut self, cursor: &Cursor, now_ms: u64) -> Option<Vec<(u64, Event)>> {
        self.trim(now_ms);
        if cursor.epoch != self.epoch || cursor.seq > self.seq || cursor.seq < self.trimmed_through
        {
            return None;
        }
        Some(
            self.entries
                .iter()
                .filter(|e| e.seq > cursor.seq)
                .filter(|e| match &e.key {
                    None => true,
                    Some(k) => self.latest.get(k) == Some(&e.seq),
                })
                .map(|e| (e.seq, e.event.clone()))
                .collect(),
        )
    }
}

/// What a connection hears from the hub.
#[derive(Debug, Clone)]
pub enum HubItem {
    Journaled {
        seq: u64,
        event: Event,
    },
    /// A reply being written: the whole text so far, as the desktop emits it.
    Draft {
        agent_id: String,
        id: String,
        text: String,
    },
    /// This device's token was revoked (or replaced by a re-pair): close.
    Revoked {
        device_id: String,
    },
    /// The companion was turned off: every connection closes.
    Shutdown,
}

/// How a connecting phone catches up.
pub enum Resume {
    /// Same epoch and still in the journal: these events, then live.
    Replay {
        events: Vec<(u64, Event)>,
        cursor: Cursor,
    },
    /// Send a snapshot as of `cursor`, then live.
    Snapshot { cursor: Cursor },
}

pub struct Hub {
    journal: Mutex<Journal>,
    tx: broadcast::Sender<HubItem>,
}

impl Hub {
    pub fn new(epoch: String) -> Self {
        Self::with_limits(epoch, JOURNAL_MAX_ENTRIES, JOURNAL_MAX_AGE_MS)
    }

    pub fn with_limits(epoch: String, max_entries: usize, max_age_ms: u64) -> Self {
        let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
        Hub {
            journal: Mutex::new(Journal::new(epoch, max_entries, max_age_ms)),
            tx,
        }
    }

    fn journal(&self) -> std::sync::MutexGuard<'_, Journal> {
        self.journal.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn cursor(&self) -> Cursor {
        self.journal().cursor()
    }

    /// Journal an event and send it to every connection. The send happens
    /// under the journal lock, so the channel carries seqs in order and a
    /// connection that subscribed in [`Self::resume`] sees exactly the events
    /// after its replay.
    pub fn publish(&self, event: Event) -> u64 {
        let mut journal = self.journal();
        let seq = journal.append(event.clone(), super::now_ms());
        let _ = self.tx.send(HubItem::Journaled { seq, event });
        seq
    }

    pub fn draft(&self, agent_id: String, id: String, text: String) {
        let _ = self.tx.send(HubItem::Draft { agent_id, id, text });
    }

    pub fn signal(&self, item: HubItem) {
        let _ = self.tx.send(item);
    }

    /// Subscribe and decide how to catch up, atomically with respect to
    /// [`Self::publish`]: nothing is missed between the two and nothing is
    /// sent twice.
    pub fn resume(&self, from: Option<&Cursor>) -> (broadcast::Receiver<HubItem>, Resume) {
        let mut journal = self.journal();
        let rx = self.tx.subscribe();
        let cursor = journal.cursor();
        let resume = match from.and_then(|c| journal.since(c, super::now_ms())) {
            Some(events) => Resume::Replay { events, cursor },
            None => Resume::Snapshot { cursor },
        };
        (rx, resume)
    }
}

/// UTF-16 length, the unit the phone's JS strings count `from` in.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Per connection: how much of each draft this phone has been sent, and what
/// is waiting out the throttle. Starts empty on every connection, so the
/// first frame of a draft after a reconnect is `from: 0`.
#[derive(Default)]
pub struct Drafts {
    sent: HashMap<String, (String, Instant)>,
    pending: HashMap<String, (String, String)>,
}

impl Drafts {
    /// The desktop's latest full text for draft `id`. Returns the append to
    /// send now, or holds it until [`Self::flush`] if one went out too recently.
    pub fn offer(
        &mut self,
        agent_id: String,
        id: String,
        text: String,
        now: Instant,
    ) -> Option<Event> {
        if let Some((_, at)) = self.sent.get(&id) {
            if now.saturating_duration_since(*at) < DRAFT_EVERY {
                self.pending.insert(id, (agent_id, text));
                return None;
            }
        }
        self.pending.remove(&id);
        self.emit(agent_id, id, text, now)
    }

    /// Held drafts whose throttle has passed.
    pub fn flush(&mut self, now: Instant) -> Vec<Event> {
        let due: Vec<String> = self
            .pending
            .keys()
            .filter(|id| {
                self.sent
                    .get(*id)
                    .is_none_or(|(_, at)| now.saturating_duration_since(*at) >= DRAFT_EVERY)
            })
            .cloned()
            .collect();
        due.into_iter()
            .filter_map(|id| {
                let (agent_id, text) = self.pending.remove(&id)?;
                self.emit(agent_id, id, text, now)
            })
            .collect()
    }

    /// The finished message arrived: it replaces the draft on the phone.
    pub fn finished(&mut self, id: &str) {
        self.sent.remove(id);
        self.pending.remove(id);
    }

    fn emit(&mut self, agent_id: String, id: String, text: String, now: Instant) -> Option<Event> {
        let already = self.sent.get(&id).map(|(t, _)| t.as_str()).unwrap_or("");
        // Drafts grow by appending. If this one didn't (rewritten), start the
        // phone over from 0; it drops what it held when `from` doesn't match.
        let (from, append) = match text.strip_prefix(already) {
            Some(rest) => (utf16_len(already), rest.to_string()),
            None => (0, text.clone()),
        };
        if append.is_empty() && from > 0 {
            return None;
        }
        self.sent.insert(id.clone(), (text, now));
        Some(Event::Draft {
            agent_id,
            id,
            from,
            text: append,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(id: &str) -> Event {
        Event::Message {
            message: json!({ "id": id }),
        }
    }

    fn status(agent: &str, state: &str) -> Event {
        Event::Status {
            agent_id: agent.into(),
            status: json!({ "state": state }),
        }
    }

    fn cur(j: &Journal, seq: u64) -> Cursor {
        Cursor {
            epoch: j.epoch.clone(),
            seq,
        }
    }

    #[test]
    fn replay_returns_everything_after_the_cursor_in_order() {
        let mut j = Journal::new("e1".into(), 100, 1_000_000);
        for i in 1..=5 {
            j.append(msg(&format!("m{i}")), 10);
        }
        let got = j.since(&cur(&j, 2), 20).unwrap();
        assert_eq!(got.iter().map(|(s, _)| *s).collect::<Vec<_>>(), [3, 4, 5]);
        assert_eq!(j.since(&cur(&j, 5), 20).unwrap().len(), 0, "caught up");
    }

    #[test]
    fn status_like_events_replay_only_their_latest() {
        let mut j = Journal::new("e1".into(), 100, 1_000_000);
        j.append(status("a", "working"), 1); // 1
        j.append(msg("m1"), 1); // 2
        j.append(status("a", "waiting"), 1); // 3
        j.append(status("b", "working"), 1); // 4
        j.append(status("a", "idle"), 1); // 5
        let got: Vec<u64> = j
            .since(&cur(&j, 0), 2)
            .unwrap()
            .iter()
            .map(|(s, _)| *s)
            .collect();
        assert_eq!(got, [2, 4, 5], "every message, latest status per agent");
        let got: Vec<u64> = j
            .since(&cur(&j, 4), 2)
            .unwrap()
            .iter()
            .map(|(s, _)| *s)
            .collect();
        assert_eq!(got, [5]);
    }

    #[test]
    fn a_cursor_from_another_epoch_or_the_future_needs_a_snapshot() {
        let mut j = Journal::new("e1".into(), 100, 1_000_000);
        j.append(msg("m1"), 1);
        let other = Cursor {
            epoch: "e0".into(),
            seq: 1,
        };
        assert!(j.since(&other, 2).is_none());
        assert!(j.since(&cur(&j, 9), 2).is_none());
    }

    #[test]
    fn a_cursor_trimmed_past_needs_a_snapshot() {
        let mut j = Journal::new("e1".into(), 3, 1_000_000);
        for i in 1..=5 {
            j.append(msg(&format!("m{i}")), 1);
        }
        // 1 and 2 were trimmed: a phone at 1 missed 2.
        assert!(j.since(&cur(&j, 1), 2).is_none());
        assert_eq!(
            j.since(&cur(&j, 2), 2).unwrap().len(),
            3,
            "2 itself was applied"
        );
    }

    #[test]
    fn events_older_than_the_window_age_out() {
        let mut j = Journal::new("e1".into(), 100, 1_000);
        j.append(msg("old"), 0);
        j.append(msg("new"), 900);
        assert_eq!(j.since(&cur(&j, 0), 950).unwrap().len(), 2);
        assert!(j.since(&cur(&j, 0), 1_500).is_none(), "seq 1 aged out");
        assert_eq!(j.since(&cur(&j, 1), 1_500).unwrap().len(), 1);
    }

    #[test]
    fn resume_subscribes_so_nothing_is_missed_or_doubled() {
        let hub = Hub::new("e1".into());
        hub.publish(msg("m1"));
        let before = hub.cursor();
        hub.publish(msg("m2"));
        let (mut rx, resume) = hub.resume(Some(&before));
        let Resume::Replay { events, cursor } = resume else {
            panic!("expected replay")
        };
        assert_eq!(events.len(), 1);
        assert_eq!(cursor.seq, 2);
        assert!(rx.try_recv().is_err(), "the replayed event isn't also live");
        hub.publish(msg("m3"));
        match rx.try_recv() {
            Ok(HubItem::Journaled { seq, .. }) => assert_eq!(seq, 3),
            other => panic!("unexpected {other:?}"),
        }
        let (_, resume) = hub.resume(None);
        assert!(matches!(resume, Resume::Snapshot { cursor } if cursor.seq == 3));
    }

    /// What a phone holds: messages upserted by id, latest status per agent.
    #[derive(Default, Debug, PartialEq)]
    struct Phone {
        messages: Vec<(String, serde_json::Value)>,
        statuses: HashMap<String, serde_json::Value>,
        overview: Option<serde_json::Value>,
    }

    impl Phone {
        fn apply(&mut self, event: &Event) {
            match event {
                Event::Message { message } => {
                    let id = message["id"].as_str().unwrap().to_string();
                    match self.messages.iter_mut().find(|(m, _)| *m == id) {
                        Some(slot) => slot.1 = message.clone(),
                        None => self.messages.push((id, message.clone())),
                    }
                }
                Event::Status { agent_id, status } => {
                    self.statuses.insert(agent_id.clone(), status.clone());
                }
                Event::Registry { overview } => self.overview = Some(overview.clone()),
                _ => {}
            }
        }
    }

    #[test]
    fn a_phone_dropped_at_any_point_of_a_turn_ends_with_every_message_once() {
        let approval = |status: &str| Event::Message {
            message: json!({ "id": "q1", "approval": { "status": status } }),
        };
        let script = vec![
            msg("u1"),
            status("a", "working"),
            Event::Registry {
                overview: json!({ "n": 1 }),
            },
            approval("pending"),
            status("a", "waiting"),
            approval("allowed"),
            status("a", "working"),
            msg("r1"),
            status("a", "idle"),
            Event::Registry {
                overview: json!({ "n": 2 }),
            },
        ];
        let mut everything = Phone::default();
        script.iter().for_each(|e| everything.apply(e));
        assert_eq!(everything.messages.len(), 3);

        for dropped_after in 0..=script.len() {
            let mut j = Journal::new("e1".into(), 100, 1_000_000);
            let mut phone = Phone::default();
            let mut cursor = cur(&j, 0);
            for (i, event) in script.iter().enumerate() {
                let seq = j.append(event.clone(), 1);
                if i < dropped_after {
                    phone.apply(event);
                    cursor = cur(&j, seq);
                }
            }
            for (_, event) in j.since(&cursor, 2).expect("replayable") {
                phone.apply(&event);
            }
            assert_eq!(phone, everything, "dropped after {dropped_after} events");
        }
    }

    fn draft_parts(e: Option<Event>) -> Option<(usize, String)> {
        match e? {
            Event::Draft { from, text, .. } => Some((from, text)),
            _ => None,
        }
    }

    #[test]
    fn drafts_become_appends_throttled_per_connection() {
        let t0 = Instant::now();
        let mut d = Drafts::default();
        let offer = |d: &mut Drafts, text: &str, at| {
            draft_parts(d.offer("a".into(), "r1".into(), text.into(), at))
        };
        assert_eq!(offer(&mut d, "Hel", t0), Some((0, "Hel".into())));
        // Too soon: held.
        assert_eq!(offer(&mut d, "Hello", t0 + Duration::from_millis(40)), None);
        assert!(d.flush(t0 + Duration::from_millis(60)).is_empty());
        let flushed = d.flush(t0 + DRAFT_EVERY);
        assert_eq!(
            draft_parts(flushed.into_iter().next()),
            Some((3, "lo".into()))
        );
        // UTF-16 offsets: an emoji counts two.
        let t1 = t0 + DRAFT_EVERY * 2;
        assert_eq!(offer(&mut d, "Hello 👋", t1), Some((5, " 👋".into())));
        let t2 = t1 + DRAFT_EVERY;
        assert_eq!(offer(&mut d, "Hello 👋!", t2), Some((8, "!".into())));
        // Rewritten rather than grown: start over.
        let t3 = t2 + DRAFT_EVERY;
        assert_eq!(offer(&mut d, "Hi", t3), Some((0, "Hi".into())));
        // The message landed: a later draft with that id starts from 0.
        d.finished("r1");
        assert_eq!(offer(&mut d, "Hi again", t3), Some((0, "Hi again".into())));
    }
}
