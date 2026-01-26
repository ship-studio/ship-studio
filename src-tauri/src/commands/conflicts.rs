//! # Merge Conflict Resolution Commands
//!
//! Commands for detecting and resolving merge conflicts.

use crate::types::{ConflictBlock, ConflictedFile};
use crate::utils::validate_project_path;
use std::process::Command;

/// Parse git merge conflict markers from file content.
pub fn parse_conflicts(content: &str, all_lines: &[&str]) -> (Vec<ConflictBlock>, String, String) {
    let mut conflicts = Vec::new();
    let mut ours_branch = String::new();
    let mut theirs_branch = String::new();

    let lines: Vec<&str> = content.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        // Look for conflict start marker
        if lines[i].starts_with("<<<<<<<") {
            let line_start = i as u32 + 1;

            // Extract branch name from marker
            if ours_branch.is_empty() {
                ours_branch = lines[i].trim_start_matches('<').trim().to_string();
                if ours_branch.is_empty() {
                    ours_branch = "current".to_string();
                }
            }

            let mut current_content = Vec::new();
            let mut incoming_content = Vec::new();
            let mut in_current = true;
            i += 1;

            while i < lines.len() {
                if lines[i].starts_with("=======") {
                    in_current = false;
                    i += 1;
                    continue;
                }
                if lines[i].starts_with(">>>>>>>") {
                    // Extract theirs branch name
                    if theirs_branch.is_empty() {
                        theirs_branch = lines[i].trim_start_matches('>').trim().to_string();
                        if theirs_branch.is_empty() {
                            theirs_branch = "incoming".to_string();
                        }
                    }
                    break;
                }

                if in_current {
                    current_content.push(lines[i]);
                } else {
                    incoming_content.push(lines[i]);
                }
                i += 1;
            }

            let line_end = i as u32 + 1;

            // Get context (3 lines before and after)
            let context_start = if line_start > 4 {
                line_start as usize - 4
            } else {
                0
            };
            let context_end = std::cmp::min(line_end as usize + 3, all_lines.len());

            let context_before: String = if context_start < (line_start as usize - 1) {
                all_lines[context_start..(line_start as usize - 1)]
                    .iter()
                    .filter(|l| !l.starts_with("<<<<<<<"))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                String::new()
            };

            let context_after: String = if (line_end as usize) < context_end {
                all_lines[(line_end as usize)..context_end]
                    .iter()
                    .filter(|l| !l.starts_with(">>>>>>>"))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                String::new()
            };

            conflicts.push(ConflictBlock {
                line_start,
                line_end,
                current_content: current_content.join("\n"),
                incoming_content: incoming_content.join("\n"),
                context_before,
                context_after,
            });
        }
        i += 1;
    }

    (conflicts, ours_branch, theirs_branch)
}

/// Get information about all conflicted files in the repository
#[tauri::command]
pub async fn get_conflict_info(project_path: String) -> Result<Vec<ConflictedFile>, String> {
    let validated_path = validate_project_path(&project_path)?;

    // Get list of files with unmerged changes
    let output = Command::new("git")
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to get conflicted files: {}", stderr));
    }

    let file_list = String::from_utf8_lossy(&output.stdout);
    let files: Vec<&str> = file_list.lines().filter(|l| !l.is_empty()).collect();

    let mut conflicted_files = Vec::new();

    for file in files {
        let file_path = validated_path.join(file);

        // Check if file is binary
        let is_binary = Command::new("git")
            .args(["diff", "--numstat", file])
            .current_dir(&validated_path)
            .output()
            .map(|out| {
                let stdout = String::from_utf8_lossy(&out.stdout);
                stdout.starts_with("-\t-")
            })
            .unwrap_or(false);

        if is_binary {
            conflicted_files.push(ConflictedFile {
                file_path: file.to_string(),
                is_binary: true,
                conflicts: Vec::new(),
                ours_branch: "current".to_string(),
                theirs_branch: "incoming".to_string(),
            });
            continue;
        }

        // Read file content and parse conflicts
        let content = match std::fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let all_lines: Vec<&str> = content.lines().collect();
        let (conflicts, ours_branch, theirs_branch) = parse_conflicts(&content, &all_lines);

        if !conflicts.is_empty() {
            conflicted_files.push(ConflictedFile {
                file_path: file.to_string(),
                is_binary: false,
                conflicts,
                ours_branch,
                theirs_branch,
            });
        }
    }

    Ok(conflicted_files)
}

/// Resolve a single conflict in a file by choosing current or incoming content
#[tauri::command]
pub async fn resolve_conflict(
    project_path: String,
    file_path: String,
    conflict_index: u32,
    resolution: String, // "current" or "incoming"
) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;
    let full_path = validated_path.join(&file_path);

    // Read the current file content
    let content =
        std::fs::read_to_string(&full_path).map_err(|e| format!("Failed to read file: {}", e))?;

    let lines: Vec<&str> = content.lines().collect();
    let mut result = Vec::new();
    let mut i = 0;
    let mut current_conflict = 0;

    while i < lines.len() {
        if lines[i].starts_with("<<<<<<<") {
            if current_conflict == conflict_index {
                // Found the conflict to resolve
                let mut current_content = Vec::new();
                let mut incoming_content = Vec::new();
                let mut in_current = true;
                i += 1;

                while i < lines.len() {
                    if lines[i].starts_with("=======") {
                        in_current = false;
                        i += 1;
                        continue;
                    }
                    if lines[i].starts_with(">>>>>>>") {
                        break;
                    }

                    if in_current {
                        current_content.push(lines[i]);
                    } else {
                        incoming_content.push(lines[i]);
                    }
                    i += 1;
                }

                // Add the chosen resolution
                let chosen = if resolution == "current" {
                    &current_content
                } else {
                    &incoming_content
                };

                for line in chosen {
                    result.push(*line);
                }

                current_conflict += 1;
            } else {
                // Skip this conflict, keep it as-is
                result.push(lines[i]);
                current_conflict += 1;
            }
        } else {
            result.push(lines[i]);
        }
        i += 1;
    }

    // Write the modified content back
    let new_content = result.join("\n");
    let final_content = if content.ends_with('\n') {
        format!("{}\n", new_content)
    } else {
        new_content
    };

    std::fs::write(&full_path, final_content)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    // Check if there are any remaining conflicts in this file
    let updated_content = std::fs::read_to_string(&full_path)
        .map_err(|e| format!("Failed to read updated file: {}", e))?;

    let has_more_conflicts = updated_content.contains("<<<<<<<");

    // If no more conflicts, stage the file
    if !has_more_conflicts {
        let add_output = Command::new("git")
            .args(["add", &file_path])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            return Err(format!("Failed to stage resolved file: {}", stderr));
        }
    }

    Ok(())
}

/// Abort the current merge and return to pre-merge state
#[tauri::command]
pub async fn abort_merge(project_path: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    let output = Command::new("git")
        .args(["merge", "--abort"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to abort merge: {}", stderr));
    }

    Ok(())
}

/// Complete the merge after all conflicts have been resolved
#[tauri::command]
pub async fn complete_merge(project_path: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    // Stage all changes
    let add_output = Command::new("git")
        .args(["add", "."])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!("Failed to stage changes: {}", stderr));
    }

    // Create the merge commit
    let commit_output = Command::new("git")
        .args(["commit", "-m", "Resolved merge conflicts via Ship Studio"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        if !stderr.contains("nothing to commit") {
            return Err(format!("Failed to create merge commit: {}", stderr));
        }
    }

    Ok(())
}
