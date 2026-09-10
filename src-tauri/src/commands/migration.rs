//! # Site migration
//!
//! Rebuilding a live site in a fresh project, from nothing but its URL.
//!
//! The app's part of this is deliberately small. It creates the project, drops
//! in the tooling the agent needs to *measure* its own work, and reads back the
//! two files that say how it is going. The rebuilding itself is the agent's
//! job, guided by the `shipstudio-site-to-code` skill.
//!
//! ## Why the measuring tools are copied into the project
//!
//! The agent runs inside the user's project and cannot reach Harbr's own
//! repository, so a comparison script living here would be unavailable exactly
//! where it is needed. Embedding them with `include_str!` and writing them into
//! `.shipstudio/fidelity/` puts them where the agent already is, at the version
//! that shipped with this build — no download, no PATH assumptions, and no
//! chance of a project drifting onto a different comparison than the one whose
//! thresholds the UI reads.
//!
//! ## Two files, read separately, on purpose
//!
//! `.shipstudio/migration.json` is the agent's account of the work — what it
//! has done, what it has not, what it is stuck on. `.shipstudio/fidelity/`
//! holds measurements. Either can exist without the other, and the UI must be
//! able to say so: a migration that has surveyed but not yet compared anything
//! is a real state, and so is a comparison run against a project whose status
//! file was never written.

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The comparison engine, embedded at build time.
///
/// `include_str!` rather than a bundled resource: these are two small text
/// files, and resolving a resource path at runtime is one more thing that can
/// be wrong on a user's machine for reasons nobody can reproduce.
const FIDELITY_MAIN: &str = include_str!("../../../scripts/site-fidelity.mjs");
const FIDELITY_COMPARE: &str = include_str!("../../../scripts/site-fidelity-compare.mjs");

/// The other half of the loop: what is different, rather than how much.
///
/// Shipped beside the comparison because on its own a score cannot be acted
/// on. A container sixty pixels narrow turns a tenth of the page magenta and
/// names nothing; this reads both pages' computed styles and says which width,
/// which type size, which colour.
const STRUCTURE: &str = include_str!("../../../scripts/site-structure.mjs");

/// The browser both tools drive.
///
/// Split out because all three were launching Chrome themselves, on a fixed
/// port and a shared profile, and killing it only from a `finally`. An
/// interrupted run — which is the normal case, since a run outlives an
/// agent's shell call — left the browser parented to init, and the next run
/// found the port answering and drove that orphan instead of its own. They
/// accumulated for as long as the machine stayed up.
const CHROME_LAUNCHER: &str = include_str!("../../../scripts/headless-chrome.mjs");

/// Where a project keeps its migration state, relative to the project root.
const MIGRATION_DIR: &str = ".shipstudio";
const FIDELITY_DIR: &str = ".shipstudio/fidelity";

// ── Reading what an agent wrote ────────────────────────────────────────────
//
// This file's author is a language model, and it will not reproduce a schema
// exactly. A real run wrote "in-progress" where the vocabulary says "active",
// and wrote `needsYou` as a list of sentences rather than a list of objects.
// Both are reasonable readings of an instruction; both would have taken the
// panel down — one to a missing icon, the other to a failed parse that
// reported the whole migration as broken.
//
// So the reader is deliberately forgiving in one direction only: it accepts
// the shapes an agent plausibly writes and normalises them into the one shape
// the UI renders. It does not invent content, and anything it cannot read at
// all is still an error rather than an empty panel.

/// One phase of the method, mirroring `src/lib/migration.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationPhase {
    pub id: String,
    pub label: String,
    #[serde(deserialize_with = "normalised_phase_status")]
    pub status: String,
    #[serde(default)]
    pub detail: String,
}

/// Map what an agent writes onto the four states the UI knows how to draw.
///
/// Anything unrecognised becomes `not-started` rather than passing through: an
/// unknown status reaches the frontend as a missing icon and a class nothing
/// styles, which is a blank row where a phase should be.
fn normalised_phase_status<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    Ok(
        match raw.trim().to_lowercase().replace([' ', '_'], "-").as_str() {
            "done" | "complete" | "completed" | "finished" => "done",
            "active" | "in-progress" | "doing" | "current" | "running" | "started" => "active",
            "blocked" | "waiting" | "needs-you" | "stalled" | "paused" => "blocked",
            _ => "not-started",
        }
        .to_string(),
    )
}

/// Something only the user can settle.
#[derive(Debug, Clone, Serialize)]
pub struct OpenQuestion {
    pub id: String,
    pub question: String,
    pub why: String,
    pub recommendation: String,
}

/// A question as written: either the full shape, or just the sentence.
///
/// A bare string is the common miss, and it is not a useless one — the
/// question itself is the part that matters. It is promoted rather than
/// dropped, with the fields the agent did not supply left empty so the panel
/// can omit them instead of inventing a rationale nobody wrote.
#[derive(Deserialize)]
#[serde(untagged)]
enum RawQuestion {
    Text(String),
    Full {
        #[serde(default)]
        id: String,
        #[serde(default, alias = "title", alias = "summary")]
        question: String,
        #[serde(default, alias = "reason", alias = "context")]
        why: String,
        #[serde(default, alias = "suggestion", alias = "recommended")]
        recommendation: String,
    },
}

impl RawQuestion {
    fn into_question(self, index: usize) -> OpenQuestion {
        match self {
            RawQuestion::Text(question) => OpenQuestion {
                id: format!("q{index}"),
                question,
                why: String::new(),
                recommendation: String::new(),
            },
            RawQuestion::Full {
                id,
                question,
                why,
                recommendation,
            } => OpenQuestion {
                id: if id.is_empty() {
                    format!("q{index}")
                } else {
                    id
                },
                question,
                why,
                recommendation,
            },
        }
    }
}

/// Work that will never happen, and why.
#[derive(Debug, Clone, Serialize)]
pub struct CannotCarry {
    pub item: String,
    pub reason: String,
}

/// The same latitude, for the same reason.
#[derive(Deserialize)]
#[serde(untagged)]
enum RawCannotCarry {
    Text(String),
    Full {
        #[serde(default, alias = "name", alias = "thing")]
        item: String,
        #[serde(default, alias = "why", alias = "detail")]
        reason: String,
    },
}

impl From<RawCannotCarry> for CannotCarry {
    fn from(raw: RawCannotCarry) -> Self {
        match raw {
            RawCannotCarry::Text(item) => CannotCarry {
                item,
                reason: String::new(),
            },
            RawCannotCarry::Full { item, reason } => CannotCarry { item, reason },
        }
    }
}

/// The agent's four-part account of where the migration is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatus {
    pub source_url: String,
    pub started_at: String,
    pub phases: Vec<MigrationPhase>,
    pub doing: Option<String>,
    pub done: Vec<String>,
    pub not_done: Vec<String>,
    pub cannot_carry: Vec<CannotCarry>,
    pub needs_you: Vec<OpenQuestion>,
}

/// The file as found, before normalisation.
///
/// Every list defaults to empty: an agent that has not reached a section yet
/// omits it, and refusing to read the file over a missing key would hide the
/// progress it *has* written.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawStatus {
    #[serde(default)]
    source_url: String,
    #[serde(default)]
    started_at: String,
    #[serde(default)]
    phases: Vec<MigrationPhase>,
    #[serde(default)]
    doing: Option<String>,
    #[serde(default)]
    done: Vec<String>,
    #[serde(default)]
    not_done: Vec<String>,
    #[serde(default)]
    cannot_carry: Vec<RawCannotCarry>,
    #[serde(default)]
    needs_you: Vec<RawQuestion>,
}

impl From<RawStatus> for MigrationStatus {
    fn from(raw: RawStatus) -> Self {
        MigrationStatus {
            source_url: raw.source_url,
            started_at: raw.started_at,
            phases: raw.phases,
            // An agent that finished a step often leaves the old sentence in
            // place; an empty string is the same as nothing in flight.
            doing: raw.doing.filter(|d| !d.trim().is_empty()),
            done: raw.done,
            not_done: raw.not_done,
            cannot_carry: raw.cannot_carry.into_iter().map(Into::into).collect(),
            needs_you: raw
                .needs_you
                .into_iter()
                .enumerate()
                .map(|(i, q)| q.into_question(i))
                .collect(),
        }
    }
}

fn phase(id: &str, label: &str, detail: &str) -> MigrationPhase {
    MigrationPhase {
        id: id.to_string(),
        label: label.to_string(),
        status: "not-started".to_string(),
        detail: detail.to_string(),
    }
}

/// The state a migration starts in.
///
/// Every phase is `not-started` and every list is empty, which is the honest
/// opening position: the agent has been given a URL and has not yet looked at
/// it. Seeding this with optimistic placeholders would put claims on screen
/// that nothing has earned.
fn initial_status(source_url: &str) -> MigrationStatus {
    MigrationStatus {
        source_url: source_url.to_string(),
        started_at: chrono::Utc::now().to_rfc3339(),
        phases: vec![
            phase("survey", "Survey", "Not started."),
            phase("design-system", "Design system", "Not started."),
            phase("homepage", "Homepage", "Not started."),
            phase("templates", "Templates", "Not started."),
            phase("remainder", "Remainder", "Not started."),
        ],
        doing: None,
        done: Vec::new(),
        not_done: vec!["Everything — the agent has not surveyed the site yet.".to_string()],
        cannot_carry: Vec::new(),
        needs_you: Vec::new(),
    }
}

/// Prepare a project to have a site rebuilt into it.
///
/// Idempotent on the tooling and non-destructive on the status: re-running this
/// refreshes the scripts but will not overwrite a status file the agent has
/// already been writing to, because that file is the record of the work and
/// resetting it would erase what the user is relying on to know where things
/// stand.
///
/// That asymmetry is what lets Resume call it. The tools are written once at
/// creation and would otherwise stay frozen at whatever shipped that day, so a
/// migration started before a bug was fixed would keep hitting it forever.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn init_migration(project_path: String, source_url: String) -> Result<(), CommandError> {
    let root = validate_project_path(&project_path)?;
    scaffold_migration(&root, &source_url)
}

/// The work `init_migration` does, once its path has been vouched for.
///
/// Split from the command so it can be exercised against a temp directory.
/// Path validation is a boundary concern and requires a real projects root;
/// what it guards — writing the engine and the opening status — is ordinary
/// file work that should not need the user's home directory to test.
fn scaffold_migration(root: &Path, source_url: &str) -> Result<(), CommandError> {
    let url = source_url.trim();
    if url.is_empty() || !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(CommandError::Validation {
            field: "source_url".into(),
            reason: "Expected an http(s) URL".into(),
        });
    }

    let fidelity = root.join(FIDELITY_DIR);
    std::fs::create_dir_all(&fidelity).map_err(|e| CommandError::Io {
        message: format!("Could not create {}: {e}", fidelity.display()),
    })?;

    // Written under the same names they have in this repo: the entry point
    // imports its comparison module by relative path, so renaming either
    // half here would leave the agent with an engine that cannot start.
    write_file(&fidelity.join("site-fidelity.mjs"), FIDELITY_MAIN)?;
    write_file(
        &fidelity.join("site-fidelity-compare.mjs"),
        FIDELITY_COMPARE,
    )?;
    write_file(&fidelity.join("site-structure.mjs"), STRUCTURE)?;
    write_file(&fidelity.join("headless-chrome.mjs"), CHROME_LAUNCHER)?;

    let status_path = root.join(MIGRATION_DIR).join("migration.json");
    if !status_path.exists() {
        let body =
            serde_json::to_string_pretty(&initial_status(url)).map_err(|e| CommandError::Io {
                message: format!("Could not serialise migration status: {e}"),
            })?;
        write_file(&status_path, &format!("{body}\n"))?;
    }

    Ok(())
}

/// The agent's account of the work, or `None` when it has not written one.
///
/// A missing file is not an error. It is the ordinary state of a project that
/// is not a migration, and of one whose agent has not got there yet.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn read_migration_status(
    project_path: String,
) -> Result<Option<MigrationStatus>, CommandError> {
    let root = validate_project_path(&project_path)?;
    status_at(&root)
}

fn status_at(root: &Path) -> Result<Option<MigrationStatus>, CommandError> {
    let path = root.join(MIGRATION_DIR).join("migration.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };

    // A status the agent wrote badly is reported as a parse failure rather than
    // as "no migration". Silently showing an empty panel over a malformed file
    // would hide the one thing that needs fixing.
    serde_json::from_str::<RawStatus>(&raw)
        .map(|s| Some(MigrationStatus::from(s)))
        .map_err(|e| CommandError::Validation {
            field: "migration.json".into(),
            reason: format!("Could not read the migration status: {e}"),
        })
}

/// A capture run that the agent has produced, if any.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FidelityReportFile {
    /// Absolute path of the directory holding this run's report and images.
    pub dir: String,
    /// The report's raw JSON, parsed by the frontend against its own types.
    pub report: serde_json::Value,
}

/// Every fidelity run in the project, oldest directory name first.
///
/// Returns the raw reports rather than a digested shape: the capture script
/// owns that format, and re-describing it here would create a second place for
/// it to be wrong.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn read_fidelity_runs(
    project_path: String,
) -> Result<Vec<FidelityReportFile>, CommandError> {
    let root = validate_project_path(&project_path)?;
    runs_at(&root)
}

fn runs_at(root: &Path) -> Result<Vec<FidelityReportFile>, CommandError> {
    let fidelity = root.join(FIDELITY_DIR);
    if !fidelity.is_dir() {
        return Ok(Vec::new());
    }

    let mut runs: Vec<(String, FidelityReportFile)> = Vec::new();
    collect_runs(&fidelity, &fidelity, 0, &mut runs);

    // Natural order, not lexicographic: the agent names these, and it will
    // reach `pass-10` eventually. Sorting that before `pass-2` would draw the
    // history backwards, which is worse than useless — it would say a fix made
    // things worse when the passes simply came in a different order.
    runs.sort_by(|a, b| natural_key(&a.0).cmp(&natural_key(&b.0)));
    Ok(runs.into_iter().map(|(_, run)| run).collect())
}

/// Find every comparison under `dir`, however deeply the agent nested it.
///
/// A run is a directory holding a `report.json`. Which directory that is, is
/// not fixed: the tool writes wherever `--out` points, and agents batch pages
/// — one wrote `<fidelity>/<batch>/<page>/report.json`, so a reader that only
/// looked one level down found nothing and the panel showed no comparison for
/// work that had actually been done.
///
/// The run's name is its path relative to the fidelity directory, so a batched
/// page reads as `batch/page` rather than colliding with every other page in
/// the batch.
fn collect_runs(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<(String, FidelityReportFile)>,
) {
    // Runs are shallow in practice. The bound is here so a symlink loop or a
    // stray node_modules cannot turn opening the panel into a filesystem walk.
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        // Anything hidden beside the runs — a cache, an editor's leavings — is
        // not one, and is skipped by name rather than by lacking a report.
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }

        let child = entry.path();
        match std::fs::read_to_string(child.join("report.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        {
            Some(report) => {
                let name = child
                    .strip_prefix(root)
                    .unwrap_or(&child)
                    .to_string_lossy()
                    .to_string();
                out.push((
                    name,
                    FidelityReportFile {
                        dir: child.to_string_lossy().to_string(),
                        report,
                    },
                ));
            }
            // Not a run itself — but it may hold some.
            None => collect_runs(root, &child, depth + 1, out),
        }
    }
}

/// A sort key that reads digit runs as numbers.
///
/// Returns the name split into text and numeric parts, so `pass-2` and
/// `pass-10` compare on 2 and 10 rather than on "2" and "1".
fn natural_key(name: &str) -> Vec<(String, u64)> {
    let mut key = Vec::new();
    let mut text = String::new();
    let mut digits = String::new();

    for c in name.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
        } else {
            if !digits.is_empty() {
                key.push((std::mem::take(&mut text), digits.parse().unwrap_or(0)));
                digits.clear();
            }
            text.push(c);
        }
    }
    key.push((text, digits.parse().unwrap_or(0)));
    key
}

fn write_file(path: &Path, body: &str) -> Result<(), CommandError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| CommandError::Io {
            message: format!("Could not create {}: {e}", parent.display()),
        })?;
    }
    std::fs::write(path, body).map_err(|e| CommandError::Io {
        message: format!("Could not write {}: {e}", path.display()),
    })
}

/// A project name derived from a URL's host.
///
/// Exposed so the creation flow and any future caller agree on it — a project
/// whose folder name does not obviously belong to the site being rebuilt is a
/// small thing that gets confusing fast once there are three of them.
pub fn project_name_from_url(url: &str) -> String {
    let host = url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .trim_start_matches("www.");

    let cleaned: String = host
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();

    let trimmed = cleaned.trim_matches('-').to_lowercase();
    // Collapse runs left by the character substitution above.
    let mut out = String::with_capacity(trimmed.len());
    let mut last_dash = false;
    for c in trimmed.chars() {
        if c == '-' {
            if !last_dash {
                out.push(c);
            }
            last_dash = true;
        } else {
            out.push(c);
            last_dash = false;
        }
    }
    if out.is_empty() {
        "migrated-site".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_names_come_from_the_host_not_the_path() {
        // The path is where a name would come from if you were not thinking:
        // every page of a site would then produce a differently-named project.
        assert_eq!(
            project_name_from_url("https://www.example.com/pricing"),
            "example-com"
        );
        assert_eq!(
            project_name_from_url("http://tempo-template.webflow.io/"),
            "tempo-template-webflow-io"
        );
    }

    #[test]
    fn a_name_is_always_produced() {
        // An empty name would become a project at the workspace root.
        assert_eq!(project_name_from_url(""), "migrated-site");
        assert_eq!(project_name_from_url("https://"), "migrated-site");
    }

    #[test]
    fn the_initial_status_claims_nothing() {
        // The opening state is the one most likely to be believed, because
        // nobody has had a chance to check it yet.
        let status = initial_status("https://example.com/");
        assert!(status.done.is_empty(), "nothing has been done yet");
        assert!(status.doing.is_none(), "nothing is in flight yet");
        assert!(!status.not_done.is_empty(), "everything is outstanding");
        assert!(
            status.phases.iter().all(|p| p.status == "not-started"),
            "no phase has begun"
        );
    }

    #[test]
    fn runs_are_ordered_the_way_a_person_counts() {
        // Lexicographic order puts pass-10 second, which would draw the score
        // history in an order the passes never happened in.
        let mut names = vec!["pass-10", "pass-2", "pass-1"];
        names.sort_by(|a, b| natural_key(a).cmp(&natural_key(b)));
        assert_eq!(names, vec!["pass-1", "pass-2", "pass-10"]);
    }

    #[test]
    fn a_status_round_trips_through_its_own_json() {
        // The panel parses what this writes, so a field renamed on one side
        // and not the other would surface as an empty panel rather than as an
        // error anyone could act on.
        let original = initial_status("https://example.com/");
        let encoded = serde_json::to_string(&original).expect("serialises");
        let decoded: MigrationStatus = serde_json::from_str::<RawStatus>(&encoded)
            .expect("parses back")
            .into();

        assert_eq!(decoded.source_url, "https://example.com/");
        assert_eq!(decoded.phases.len(), 5);
        assert!(decoded.doing.is_none());
        // camelCase on the wire: the frontend types spell it `sourceUrl`.
        assert!(encoded.contains("\"sourceUrl\""));
        assert!(encoded.contains("\"cannotCarry\""));
        assert!(encoded.contains("\"needsYou\""));
    }

    #[test]
    fn scaffolding_leaves_a_project_that_can_measure_itself() {
        // The whole feature rests on the agent being able to run the engine
        // from inside the project it is working in. If either half is missing
        // or misnamed, that failure shows up as the agent being bad at
        // migrating rather than as a missing file.
        let dir = tempfile::tempdir().expect("temp dir");
        scaffold_migration(dir.path(), "https://example.com/").expect("scaffolds");

        let fidelity = dir.path().join(FIDELITY_DIR);
        let entry = fidelity.join("site-fidelity.mjs");
        let compare = fidelity.join("site-fidelity-compare.mjs");
        assert!(entry.exists(), "the engine is missing");
        assert!(compare.exists(), "the comparison module is missing");
        assert!(
            fidelity.join("site-structure.mjs").exists(),
            "the diagnostic is missing — a score with nothing to explain it"
        );

        // The entry point imports its sibling by relative path, so the two
        // names have to agree. This is the assertion that would have caught
        // writing them as fidelity.mjs / compare.mjs.
        let source = std::fs::read_to_string(&entry).expect("readable");
        assert!(
            source.contains("./site-fidelity-compare.mjs"),
            "the engine imports a module that was not written beside it"
        );
    }

    #[test]
    fn a_scaffolded_project_reports_a_status_that_claims_nothing() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(
            status_at(dir.path()).expect("no error").is_none(),
            "a project that is not a migration has no status"
        );

        scaffold_migration(dir.path(), "https://example.com/").expect("scaffolds");
        let status = status_at(dir.path()).expect("reads").expect("exists");
        assert_eq!(status.source_url, "https://example.com/");
        assert!(status.done.is_empty());
    }

    #[test]
    fn scaffolding_twice_does_not_erase_the_agents_work() {
        // Re-running this must refresh the tooling without resetting the
        // record of what has been done — that file is what the user is
        // relying on to know where things stand.
        let dir = tempfile::tempdir().expect("temp dir");
        scaffold_migration(dir.path(), "https://example.com/").expect("scaffolds");

        let status_path = dir.path().join(MIGRATION_DIR).join("migration.json");
        let mut status = status_at(dir.path()).expect("reads").expect("exists");
        status.done.push("Survey".into());
        std::fs::write(&status_path, serde_json::to_string(&status).unwrap()).unwrap();

        scaffold_migration(dir.path(), "https://example.com/").expect("scaffolds again");
        let after = status_at(dir.path()).expect("reads").expect("exists");
        assert_eq!(
            after.done,
            vec!["Survey".to_string()],
            "progress was erased"
        );
    }

    #[test]
    fn a_url_is_required_and_must_be_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(scaffold_migration(dir.path(), "").is_err());
        assert!(scaffold_migration(dir.path(), "not a url").is_err());
        assert!(scaffold_migration(dir.path(), "ftp://example.com").is_err());
    }

    #[test]
    fn runs_are_read_back_in_the_order_the_passes_happened() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(
            runs_at(dir.path()).expect("no error").is_empty(),
            "a project with no captures has no runs"
        );

        for name in ["pass-10", "pass-2", "pass-1"] {
            let run = dir.path().join(FIDELITY_DIR).join(name);
            std::fs::create_dir_all(&run).unwrap();
            std::fs::write(
                run.join("report.json"),
                format!(r#"{{"label":"home","score":1,"name":"{name}"}}"#),
            )
            .unwrap();
        }
        // A directory with no report is skipped rather than failing the read:
        // the agent may well be mid-capture when someone opens the panel.
        std::fs::create_dir_all(dir.path().join(FIDELITY_DIR).join("in-progress")).unwrap();
        // And a hidden directory is not a run even if it does hold a report.
        let cache = dir.path().join(FIDELITY_DIR).join(".reference-cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(
            cache.join("report.json"),
            r#"{"label":"home","score":1,"name":"not-a-run"}"#,
        )
        .unwrap();

        let runs = runs_at(dir.path()).expect("reads");
        let order: Vec<&str> = runs
            .iter()
            .map(|r| r.report["name"].as_str().unwrap())
            .collect();
        assert_eq!(order, vec!["pass-1", "pass-2", "pass-10"]);
    }

    #[test]
    fn a_batched_run_is_still_found() {
        // Agents batch pages under one --out, so a real run wrote
        // `<fidelity>/<batch>/<page>/report.json`. A reader that only looked one
        // level down found nothing, and the panel showed no comparison for work
        // that had been done and measured.
        let dir = tempfile::tempdir().expect("temp dir");
        let batch = dir.path().join(FIDELITY_DIR).join("pillar1440");

        for page in ["about", "industries-retail"] {
            let run = batch.join(page);
            std::fs::create_dir_all(&run).unwrap();
            std::fs::write(
                run.join("report.json"),
                format!(r#"{{"label":"{page}","score":90}}"#),
            )
            .unwrap();
        }

        // And a plain run beside the batch still reads as one.
        let flat = dir.path().join(FIDELITY_DIR).join("home-pass1");
        std::fs::create_dir_all(&flat).unwrap();
        std::fs::write(flat.join("report.json"), r#"{"label":"home","score":80}"#).unwrap();

        let runs = runs_at(dir.path()).expect("reads");
        let names: Vec<String> = runs
            .iter()
            .map(|r| r.report["label"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(runs.len(), 3, "found {names:?}");
        assert!(names.contains(&"about".to_string()));
        assert!(names.contains(&"industries-retail".to_string()));
        assert!(names.contains(&"home".to_string()));
    }

    #[test]
    fn a_batch_directory_is_not_itself_a_run() {
        // The container holds no report, so it must not appear as a comparison
        // nobody ran — which is how it showed up before: "pending", forever.
        let dir = tempfile::tempdir().expect("temp dir");
        let run = dir.path().join(FIDELITY_DIR).join("batch").join("page");
        std::fs::create_dir_all(&run).unwrap();
        std::fs::write(run.join("report.json"), r#"{"label":"page","score":1}"#).unwrap();

        let runs = runs_at(dir.path()).expect("reads");
        assert_eq!(runs.len(), 1);
        // `Path::ends_with` compares components, so it is right on both
        // platforms. `str::ends_with` is a literal compare: the dir is built
        // from `to_string_lossy` on a native path, so on Windows it ends
        // "batch\\page" and could never match a forward slash. The code was
        // correct; only this assertion was not.
        assert!(std::path::Path::new(&runs[0].dir).ends_with("batch/page"));
    }

    #[test]
    fn a_malformed_status_is_an_error_not_an_empty_panel() {
        // Showing nothing would hide the one thing that needs fixing.
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(MIGRATION_DIR);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("migration.json"), "{ not json").unwrap();
        assert!(status_at(dir.path()).is_err());
    }

    /// The exact file a real run produced, reduced to the parts that broke.
    ///
    /// Kept verbatim rather than tidied, save for the site's address: the value
    /// of a regression test written from a live failure is that it preserves
    /// what actually happened, not a cleaner version of it.
    const AS_AN_AGENT_WROTE_IT: &str = r#"{
      "sourceUrl": "https://example.com/",
      "startedAt": "2026-09-08T02:30:08Z",
      "phases": [
        { "id": "survey", "label": "Survey", "status": "done", "detail": "18 URLs." },
        { "id": "design-system", "label": "Design system", "status": "in-progress", "detail": "25 tokens." }
      ],
      "doing": "Porting the design system.",
      "done": ["Survey"],
      "notDone": ["Everything else"],
      "cannotCarry": ["The heading typeface"],
      "needsYou": ["Fonts: self-host the same files, or substitute?"]
    }"#;

    #[test]
    fn a_status_an_agent_actually_wrote_is_readable() {
        // Every assertion here corresponds to a way the panel broke on a live
        // run: an unknown status left a phase with no icon, and questions as
        // bare sentences failed the parse outright — reporting the whole
        // migration as broken while it was in fact going fine.
        let status: MigrationStatus = serde_json::from_str::<RawStatus>(AS_AN_AGENT_WROTE_IT)
            .expect("an agent's own file must parse")
            .into();

        assert_eq!(status.phases[0].status, "done");
        assert_eq!(
            status.phases[1].status, "active",
            "\"in-progress\" is what an agent writes for active"
        );

        assert_eq!(status.needs_you.len(), 1);
        assert_eq!(
            status.needs_you[0].question,
            "Fonts: self-host the same files, or substitute?"
        );
        // Not invented. The agent wrote a sentence, so the sentence is all
        // there is, and the panel omits the rest rather than filling it in.
        assert!(status.needs_you[0].why.is_empty());
        assert!(status.needs_you[0].recommendation.is_empty());
        assert!(
            !status.needs_you[0].id.is_empty(),
            "needs a key to render by"
        );

        assert_eq!(status.cannot_carry.len(), 1);
        assert_eq!(status.cannot_carry[0].item, "The heading typeface");
    }

    #[test]
    fn unknown_phase_words_land_somewhere_drawable() {
        // Passing an unrecognised status through reaches the frontend as a
        // missing icon and a class nothing styles — a blank row where a phase
        // should be.
        let raw =
            r#"{"phases":[{"id":"survey","label":"Survey","status":"whenever","detail":""}]}"#;
        let status: MigrationStatus = serde_json::from_str::<RawStatus>(raw).unwrap().into();
        assert_eq!(status.phases[0].status, "not-started");
    }

    #[test]
    fn a_half_written_status_still_reports_what_is_there() {
        // An agent that has not reached a section yet omits it. Refusing the
        // file over a missing key would hide the progress it has written.
        let raw = r#"{"sourceUrl":"https://example.com/","done":["Survey"]}"#;
        let status: MigrationStatus = serde_json::from_str::<RawStatus>(raw).unwrap().into();
        assert_eq!(status.done, vec!["Survey".to_string()]);
        assert!(status.phases.is_empty());
        assert!(status.doing.is_none());
    }

    #[test]
    fn an_emptied_doing_line_means_nothing_is_in_flight() {
        let raw = r#"{"doing":"   "}"#;
        let status: MigrationStatus = serde_json::from_str::<RawStatus>(raw).unwrap().into();
        assert!(status.doing.is_none());
    }

    #[test]
    fn the_embedded_engine_is_the_real_one() {
        // A stale or empty embed would ship a project that cannot measure
        // anything, and the failure would appear as the agent being bad at
        // migrating rather than as a missing file.
        assert!(FIDELITY_MAIN.contains("captureBeyondViewport"));
        assert!(FIDELITY_COMPARE.contains("PIXEL_THRESHOLD_SQ"));
        assert!(STRUCTURE.contains("getComputedStyle"));
    }
}
