//! Base screenshot operations: crop and save, read as base64, and comparison.

use crate::errors::CommandError;
use crate::utils::{validate_project_file_path, validate_project_path};

/// Crop an image and save it to the project's screenshots folder
/// Takes the source image path, crop bounds (x, y, width, height), and returns the saved path
#[ship_studio_macros::ship_command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn crop_and_save_screenshot(
    project_path: String,
    source_path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<String, CommandError> {
    let project = validate_project_path(&project_path)?;
    let screenshots_dir = project.join(".shipstudio").join("screenshots");

    // Ensure screenshots directory exists
    if !screenshots_dir.exists() {
        std::fs::create_dir_all(&screenshots_dir).map_err(|e| e.to_string())?;
    }

    // Generate timestamped filename
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let screenshot_path = screenshots_dir.join(format!("screenshot-{timestamp}.png"));
    let screenshot_path_str = screenshot_path.to_string_lossy().to_string();

    // Load the source image
    let img = image::open(&source_path).map_err(|e| format!("Failed to open image: {e}"))?;

    // Crop the image (ensure bounds are within image dimensions)
    let img_width = img.width();
    let img_height = img.height();

    let crop_x = x.min(img_width.saturating_sub(1));
    let crop_y = y.min(img_height.saturating_sub(1));
    let crop_width = width.min(img_width.saturating_sub(crop_x));
    let crop_height = height.min(img_height.saturating_sub(crop_y));

    let cropped = img.crop_imm(crop_x, crop_y, crop_width, crop_height);

    // Save the cropped image
    cropped
        .save(&screenshot_path)
        .map_err(|e| format!("Failed to save cropped image: {e}"))?;

    // Clean up the source temp file
    let _ = std::fs::remove_file(&source_path);

    Ok(screenshot_path_str)
}

/// Read a screenshot file and return it as a base64 data URL.
/// Used for displaying screenshot previews in the UI.
///
/// The path is validated: every caller passes a path this app just wrote under
/// `<project>/.shipstudio/screenshots`, so containment costs nothing here and
/// stops the command from doubling as a read-any-file-on-disk primitive.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn get_screenshot_base64(file_path: String) -> Result<String, CommandError> {
    use base64::Engine;

    let path = validate_project_file_path(&file_path)?;

    if !path.exists() {
        return Err((format!("Screenshot file not found: {file_path}")).into());
    }

    let data = std::fs::read(&path).map_err(|e| format!("Failed to read screenshot: {e}"))?;
    let base64_data = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(format!("data:image/png;base64,{base64_data}"))
}
